import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  safeStorage: {
    isAsyncEncryptionAvailable: async () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptStringAsync: async (value: string) => Buffer.from(value, 'utf8'),
    decryptStringAsync: async (buffer: Buffer) => ({ result: buffer.toString('utf8'), shouldReEncrypt: false })
  },
  clipboard: { readText: () => '', writeText: () => undefined },
  shell: { openExternal: async () => undefined }
}));

const { defaultConfig, initConfigPath, saveConfig } = await import('../src/main/config.js');
const {
  RETIRED_WORKERS_STATE,
  SWARM_STATE,
  agentsRecoveryPaused,
  bindConversation,
  currentRunId,
  resetAgentsForTests,
  snapshotSwarm,
  spawn,
  swarmRunning
} = await import('../src/main/agents.js');
const { restoreAgentAuthorityState } = await import('../src/main/agents-recovery.js');
const {
  initDurableStore,
  readDurableResult,
  resetDurableForTests,
  writeDurableCheckpointNow,
  writeDurableNow
} = await import('../src/main/durable.js');
const {
  durableRecoveryIncidents,
  resetDurableRecoveryForTests
} = await import('../src/main/durable-recovery.js');
const { makeTempDir, removeTempDir } = await import('./helpers.js');

let dir: string;
const primary = (name: string): string => path.join(dir, 'state', `${name}.json`);
const backup = (name: string): string => path.join(dir, 'state', `${name}.backup.json`);

async function enableAgents(): Promise<void> {
  const base = defaultConfig();
  await saveConfig({
    ...base,
    multiAgent: { ...base.multiAgent, enabled: true, maxWorkers: 3 }
  });
}

function makeSwarmSnapshot() {
  const result = spawn({
    caller: { conversationId: 'prime-recovery' },
    workers: [{ task: 'verify durable recovery' }]
  });
  bindConversation('worker-1', 'worker-recovery', result.runId);
  const snapshot = structuredClone(snapshotSwarm());
  if (!snapshot) throw new Error('expected swarm snapshot');
  return snapshot;
}

beforeAll(async () => {
  dir = await makeTempDir('clf-agents-recovery-');
  initConfigPath(dir);
  initDurableStore(dir);
  await enableAgents();
});

beforeEach(async () => {
  resetAgentsForTests();
  resetDurableRecoveryForTests();
  resetDurableForTests();
  initDurableStore(dir);
  await fs.rm(path.join(dir, 'state'), { recursive: true, force: true });
  await enableAgents();
});

afterAll(async () => {
  resetAgentsForTests();
  resetDurableRecoveryForTests();
  resetDurableForTests();
  if (dir) await removeTempDir(dir);
});

describe('agents durable corruption recovery', () => {
  it('pauses on corrupt swarm primary and never auto-restores a valid backup', async () => {
    const snapshot = makeSwarmSnapshot();
    resetAgentsForTests();

    await writeDurableNow(SWARM_STATE, snapshot);
    await writeDurableCheckpointNow(SWARM_STATE, snapshot);
    await fs.writeFile(primary(SWARM_STATE), '{"version":', 'utf8');

    expect(await restoreAgentAuthorityState()).toBe(false);
    expect(agentsRecoveryPaused()).toBe(true);
    expect(swarmRunning()).toBe(false);
    expect(currentRunId('prime-recovery')).toBeNull();
    expect(durableRecoveryIncidents('agents')).toContainEqual(
      expect.objectContaining({
        ledger: SWARM_STATE,
        copy: 'primary',
        failure: 'json_corrupt',
        disposition: 'pause'
      })
    );
    expect(await readDurableResult(SWARM_STATE, 'backup')).toMatchObject({ kind: 'valid' });
  });

  it('publishes neither ledger when retired-worker authority is corrupt but swarm is valid', async () => {
    const snapshot = makeSwarmSnapshot();
    resetAgentsForTests();

    await writeDurableNow(SWARM_STATE, snapshot);
    await fs.mkdir(path.dirname(primary(RETIRED_WORKERS_STATE)), { recursive: true });
    await fs.writeFile(primary(RETIRED_WORKERS_STATE), '{"version":', 'utf8');

    expect(await restoreAgentAuthorityState()).toBe(false);
    expect(agentsRecoveryPaused()).toBe(true);
    expect(swarmRunning()).toBe(false);
    expect(currentRunId('prime-recovery')).toBeNull();
    expect(durableRecoveryIncidents('agents')).toContainEqual(
      expect.objectContaining({
        ledger: RETIRED_WORKERS_STATE,
        copy: 'primary',
        failure: 'json_corrupt',
        disposition: 'pause'
      })
    );
  });

  it('treats missing swarm primary as canonical clear and deletes stale backup evidence', async () => {
    const snapshot = makeSwarmSnapshot();
    resetAgentsForTests();

    await writeDurableCheckpointNow(SWARM_STATE, snapshot);
    expect(await readDurableResult(SWARM_STATE, 'backup')).toMatchObject({ kind: 'valid' });
    expect(await readDurableResult(SWARM_STATE)).toMatchObject({ kind: 'missing' });

    expect(await restoreAgentAuthorityState()).toBe(true);
    expect(agentsRecoveryPaused()).toBe(false);
    expect(swarmRunning()).toBe(false);
    expect(await readDurableResult(SWARM_STATE, 'backup')).toMatchObject({ kind: 'missing' });
  });

  it('rejects conflicting conversation ownership as whole-ledger schema corruption', async () => {
    const snapshot = makeSwarmSnapshot() as any;
    snapshot.activeRuns[0].agents.find((entry: any) => entry.info.id === 'worker-1').info.conversationId =
      'prime-recovery';
    resetAgentsForTests();

    await writeDurableNow(SWARM_STATE, snapshot);

    expect(await restoreAgentAuthorityState()).toBe(false);
    expect(agentsRecoveryPaused()).toBe(true);
    expect(swarmRunning()).toBe(false);
    expect(durableRecoveryIncidents('agents')).toContainEqual(
      expect.objectContaining({
        ledger: SWARM_STATE,
        copy: 'primary',
        failure: 'schema_invalid',
        disposition: 'pause'
      })
    );
  });

  it('keeps agents paused when both swarm copies are malformed', async () => {
    await fs.mkdir(path.dirname(primary(SWARM_STATE)), { recursive: true });
    await fs.writeFile(primary(SWARM_STATE), '{"version":', 'utf8');
    await fs.writeFile(backup(SWARM_STATE), '{"version":', 'utf8');

    expect(await restoreAgentAuthorityState()).toBe(false);
    expect(agentsRecoveryPaused()).toBe(true);
    expect(durableRecoveryIncidents('agents')).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ledger: SWARM_STATE,
        copy: 'primary',
        failure: 'json_corrupt',
        disposition: 'pause'
      }),
      expect.objectContaining({
        ledger: SWARM_STATE,
        copy: 'backup',
        failure: 'json_corrupt',
        disposition: 'degraded'
      })
    ]));
  });
});
