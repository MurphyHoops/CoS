import {
  RETIRED_WORKERS_STATE,
  SWARM_STATE,
  restoreRetiredWorkers,
  restoreSwarm,
  validateRetiredWorkersSnapshot,
  validateSwarmSnapshot,
  type RetiredWorkersSnapshot,
  type SwarmSnapshot
} from './agents.js';
import { readDurableResult, writeDurableCheckpointNow } from './durable.js';
import {
  noteDurableRecoveryIncident,
  resolveDurableRecoveryIncident
} from './durable-recovery.js';

type AgentLedgerLoad<T> =
  | { safe: true; value: T | null; primaryPresent: boolean }
  | { safe: false };

function noteAgentRecovery(
  ledger: string,
  copy: 'primary' | 'backup',
  failure: 'json_corrupt' | 'schema_invalid' | 'io_error' | 'checkpoint_degraded' | 'orphan_backup',
  disposition: 'pause' | 'degraded',
  detail?: string
): void {
  noteDurableRecoveryIncident({
    domain: 'agents',
    ledger,
    copy,
    failure,
    disposition,
    detail
  });
}

async function inspectAgentBackup<T>(
  ledger: string,
  validate: (value: unknown) => value is T
): Promise<'missing' | 'valid' | 'invalid'> {
  const backup = await readDurableResult<unknown>(ledger, 'backup');
  if (backup.kind === 'missing') {
    resolveDurableRecoveryIncident('agents', ledger, 'backup');
    return 'missing';
  }
  if (backup.kind === 'io_error') {
    noteAgentRecovery(ledger, 'backup', 'io_error', 'degraded', backup.error);
    return 'invalid';
  }
  if (backup.kind === 'corrupt') {
    noteAgentRecovery(ledger, 'backup', 'json_corrupt', 'degraded', backup.error);
    return 'invalid';
  }
  if (!validate(backup.value)) {
    noteAgentRecovery(
      ledger,
      'backup',
      'schema_invalid',
      'degraded',
      'backup snapshot failed owner schema validation'
    );
    return 'invalid';
  }
  resolveDurableRecoveryIncident('agents', ledger, 'backup');
  return 'valid';
}

async function loadRetiredWorkersForRecovery(): Promise<AgentLedgerLoad<RetiredWorkersSnapshot>> {
  const primary = await readDurableResult<unknown>(RETIRED_WORKERS_STATE);
  if (primary.kind === 'missing') {
    const backup = await inspectAgentBackup(RETIRED_WORKERS_STATE, validateRetiredWorkersSnapshot);
    if (backup !== 'missing') {
      noteAgentRecovery(
        RETIRED_WORKERS_STATE,
        'primary',
        'orphan_backup',
        'pause',
        'retired-worker primary is missing while recovery evidence still exists'
      );
      return { safe: false };
    }
    resolveDurableRecoveryIncident('agents', RETIRED_WORKERS_STATE, 'primary');
    return { safe: true, value: null, primaryPresent: false };
  }
  if (primary.kind === 'io_error') {
    noteAgentRecovery(RETIRED_WORKERS_STATE, 'primary', 'io_error', 'pause', primary.error);
    await inspectAgentBackup(RETIRED_WORKERS_STATE, validateRetiredWorkersSnapshot);
    return { safe: false };
  }
  if (primary.kind === 'corrupt') {
    noteAgentRecovery(RETIRED_WORKERS_STATE, 'primary', 'json_corrupt', 'pause', primary.error);
    await inspectAgentBackup(RETIRED_WORKERS_STATE, validateRetiredWorkersSnapshot);
    return { safe: false };
  }
  if (!validateRetiredWorkersSnapshot(primary.value)) {
    noteAgentRecovery(
      RETIRED_WORKERS_STATE,
      'primary',
      'schema_invalid',
      'pause',
      'retired-worker primary failed owner schema validation'
    );
    await inspectAgentBackup(RETIRED_WORKERS_STATE, validateRetiredWorkersSnapshot);
    return { safe: false };
  }
  resolveDurableRecoveryIncident('agents', RETIRED_WORKERS_STATE, 'primary');
  await inspectAgentBackup(RETIRED_WORKERS_STATE, validateRetiredWorkersSnapshot);
  return { safe: true, value: primary.value, primaryPresent: true };
}

async function loadSwarmForRecovery(): Promise<AgentLedgerLoad<SwarmSnapshot>> {
  const primary = await readDurableResult<unknown>(SWARM_STATE);
  if (primary.kind === 'missing') {
    // The swarm owner intentionally represents Clear-swarm as an absent primary file.
    // A surviving backup is stale evidence and must not resurrect an old incarnation.
    try {
      await writeDurableCheckpointNow(SWARM_STATE, null);
      resolveDurableRecoveryIncident('agents', SWARM_STATE, 'backup');
    } catch (error) {
      noteAgentRecovery(
        SWARM_STATE,
        'backup',
        'checkpoint_degraded',
        'degraded',
        error instanceof Error ? error.message : String(error)
      );
    }
    resolveDurableRecoveryIncident('agents', SWARM_STATE, 'primary');
    return { safe: true, value: null, primaryPresent: false };
  }
  if (primary.kind === 'io_error') {
    noteAgentRecovery(SWARM_STATE, 'primary', 'io_error', 'pause', primary.error);
    await inspectAgentBackup(SWARM_STATE, validateSwarmSnapshot);
    return { safe: false };
  }
  if (primary.kind === 'corrupt') {
    noteAgentRecovery(SWARM_STATE, 'primary', 'json_corrupt', 'pause', primary.error);
    await inspectAgentBackup(SWARM_STATE, validateSwarmSnapshot);
    return { safe: false };
  }
  if (!validateSwarmSnapshot(primary.value)) {
    noteAgentRecovery(
      SWARM_STATE,
      'primary',
      'schema_invalid',
      'pause',
      'swarm primary failed owner schema validation'
    );
    await inspectAgentBackup(SWARM_STATE, validateSwarmSnapshot);
    return { safe: false };
  }
  resolveDurableRecoveryIncident('agents', SWARM_STATE, 'primary');
  await inspectAgentBackup(SWARM_STATE, validateSwarmSnapshot);
  return { safe: true, value: primary.value, primaryPresent: true };
}

export async function checkpointAgentLedger(ledger: string, value: unknown): Promise<void> {
  try {
    await writeDurableCheckpointNow(ledger, value);
    resolveDurableRecoveryIncident('agents', ledger, 'backup');
  } catch (error) {
    noteAgentRecovery(
      ledger,
      'backup',
      'checkpoint_degraded',
      'degraded',
      error instanceof Error ? error.message : String(error)
    );
  }
}

export async function restoreAgentAuthorityState(): Promise<boolean> {
  const retired = await loadRetiredWorkersForRecovery();
  const swarm = await loadSwarmForRecovery();
  if (!retired.safe || !swarm.safe) {
    restoreRetiredWorkers(null);
    restoreSwarm(null);
    return false;
  }

  const retiredRestored = restoreRetiredWorkers(retired.value);
  const swarmRestored = restoreSwarm(swarm.value);
  if (!retiredRestored || !swarmRestored) {
    restoreRetiredWorkers(null);
    restoreSwarm(null);
    noteAgentRecovery(
      !retiredRestored ? RETIRED_WORKERS_STATE : SWARM_STATE,
      'primary',
      'schema_invalid',
      'pause',
      'validated agents snapshot failed owner restore'
    );
    return false;
  }

  if (retired.primaryPresent) await checkpointAgentLedger(RETIRED_WORKERS_STATE, retired.value);
  if (swarm.primaryPresent) await checkpointAgentLedger(SWARM_STATE, swarm.value);
  return true;
}
