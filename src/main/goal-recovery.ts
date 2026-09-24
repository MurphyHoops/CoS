import {
  GOAL_OBJECTIVES_STATE,
  GOAL_REPLIES_STATE,
  GOAL_SWITCHES_STATE,
  checkpointGoalLedger,
  restoreGoalObjectives,
  restoreGoalReplies,
  restoreGoalSwitches,
  validateGoalObjectivesSnapshot,
  validateGoalRepliesSnapshot,
  validateGoalSwitchesSnapshot,
  type GoalObjectivesSnapshot,
  type GoalRepliesSnapshot,
  type GoalSwitchesSnapshot
} from './goal.js';
import { readDurableResult } from './durable.js';
import {
  noteDurableRecoveryIncident,
  resolveDurableRecoveryIncident
} from './durable-recovery.js';

type GoalLedgerLoad<T> =
  | { safe: true; value: T | null; primaryPresent: boolean }
  | { safe: false };

function noteGoalRecovery(
  ledger: string,
  copy: 'primary' | 'backup',
  failure: 'json_corrupt' | 'schema_invalid' | 'io_error' | 'checkpoint_degraded' | 'orphan_backup',
  disposition: 'pause' | 'degraded',
  detail?: string
): void {
  noteDurableRecoveryIncident({
    domain: 'goal',
    ledger,
    copy,
    failure,
    disposition,
    detail
  });
}

async function inspectGoalBackup<T>(
  ledger: string,
  validate: (value: unknown) => value is T
): Promise<'missing' | 'valid' | 'invalid'> {
  const backup = await readDurableResult<unknown>(ledger, 'backup');
  if (backup.kind === 'missing') {
    resolveDurableRecoveryIncident('goal', ledger, 'backup');
    return 'missing';
  }
  if (backup.kind === 'io_error') {
    noteGoalRecovery(ledger, 'backup', 'io_error', 'degraded', backup.error);
    return 'invalid';
  }
  if (backup.kind === 'corrupt') {
    noteGoalRecovery(ledger, 'backup', 'json_corrupt', 'degraded', backup.error);
    return 'invalid';
  }
  if (!validate(backup.value)) {
    noteGoalRecovery(
      ledger,
      'backup',
      'schema_invalid',
      'degraded',
      'backup snapshot failed Goal owner schema validation'
    );
    return 'invalid';
  }
  resolveDurableRecoveryIncident('goal', ledger, 'backup');
  return 'valid';
}

async function loadGoalLedger<T>(
  ledger: string,
  validate: (value: unknown) => value is T
): Promise<GoalLedgerLoad<T>> {
  const primary = await readDurableResult<unknown>(ledger);
  if (primary.kind === 'missing') {
    const backup = await inspectGoalBackup(ledger, validate);
    if (backup !== 'missing') {
      noteGoalRecovery(
        ledger,
        'primary',
        'orphan_backup',
        'pause',
        'Goal primary is missing while recovery evidence still exists'
      );
      return { safe: false };
    }
    resolveDurableRecoveryIncident('goal', ledger, 'primary');
    return { safe: true, value: null, primaryPresent: false };
  }
  if (primary.kind === 'io_error') {
    noteGoalRecovery(ledger, 'primary', 'io_error', 'pause', primary.error);
    await inspectGoalBackup(ledger, validate);
    return { safe: false };
  }
  if (primary.kind === 'corrupt') {
    noteGoalRecovery(ledger, 'primary', 'json_corrupt', 'pause', primary.error);
    await inspectGoalBackup(ledger, validate);
    return { safe: false };
  }
  if (!validate(primary.value)) {
    noteGoalRecovery(
      ledger,
      'primary',
      'schema_invalid',
      'pause',
      'Goal primary failed owner schema validation'
    );
    await inspectGoalBackup(ledger, validate);
    return { safe: false };
  }

  resolveDurableRecoveryIncident('goal', ledger, 'primary');
  await inspectGoalBackup(ledger, validate);
  return { safe: true, value: primary.value, primaryPresent: true };
}

export async function restoreGoalAuthorityState(): Promise<boolean> {
  const objectives = await loadGoalLedger<GoalObjectivesSnapshot>(
    GOAL_OBJECTIVES_STATE,
    validateGoalObjectivesSnapshot
  );
  const switches = await loadGoalLedger<GoalSwitchesSnapshot>(
    GOAL_SWITCHES_STATE,
    validateGoalSwitchesSnapshot
  );
  const replies = await loadGoalLedger<GoalRepliesSnapshot>(
    GOAL_REPLIES_STATE,
    validateGoalRepliesSnapshot
  );

  let allSafe = true;

  if (objectives.safe) {
    if (!restoreGoalObjectives(objectives.value)) {
      noteGoalRecovery(
        GOAL_OBJECTIVES_STATE,
        'primary',
        'schema_invalid',
        'pause',
        'validated Goal objective snapshot failed owner restore'
      );
      allSafe = false;
    } else if (objectives.primaryPresent) {
      await checkpointGoalLedger(GOAL_OBJECTIVES_STATE, objectives.value);
    }
  } else {
    allSafe = false;
  }

  if (switches.safe) {
    if (!restoreGoalSwitches(switches.value)) {
      noteGoalRecovery(
        GOAL_SWITCHES_STATE,
        'primary',
        'schema_invalid',
        'pause',
        'validated Goal switch snapshot failed owner restore'
      );
      allSafe = false;
    } else if (switches.primaryPresent) {
      await checkpointGoalLedger(GOAL_SWITCHES_STATE, switches.value);
    }
  } else {
    allSafe = false;
  }

  if (replies.safe) {
    if (!restoreGoalReplies(replies.value)) {
      noteGoalRecovery(
        GOAL_REPLIES_STATE,
        'primary',
        'schema_invalid',
        'pause',
        'validated Goal reply snapshot failed owner restore'
      );
      allSafe = false;
    } else if (replies.primaryPresent) {
      await checkpointGoalLedger(GOAL_REPLIES_STATE, replies.value);
    }
  } else {
    allSafe = false;
  }

  // Each ledger keeps its own readable fact projection. One corrupt ledger pauses Goal/Loop
  // driving through the shared domain, but does not erase two independently valid ledgers and
  // thereby turn "unknown" into "empty".
  return allSafe;
}
