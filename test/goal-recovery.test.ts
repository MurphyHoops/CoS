import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '', getVersion: () => '0.0.0' },
  safeStorage: {
    isAsyncEncryptionAvailable: async () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptStringAsync: async (value: string) => Buffer.from(value, 'utf8'),
    decryptStringAsync: async (buffer: Buffer) => ({ result: buffer.toString('utf8'), shouldReEncrypt: false })
  }
}));

const { defaultConfig, initConfigPath, saveConfig } = await import('../src/main/config.js');
const {
  GOAL_OBJECTIVES_STATE,
  GOAL_REPLIES_STATE,
  GOAL_SWITCHES_STATE,
  goalObjectiveFor,
  goalRecoveryPaused,
  goalSwitchEnabledFor,
  goalSwitchFor,
  resetGoalStateForTests,
  setGoalObjectiveNow,
  setGoalSwitchNow
} = await import('../src/main/goal.js');
const { restoreGoalAuthorityState } = await import('../src/main/goal-recovery.js');
const {
  initDurableStore,
  readDurableResult,
  resetDurableForTests
} = await import('../src/main/durable.js');
const {
  durableRecoveryIncidents,
  resetDurableRecoveryForTests
} = await import('../src/main/durable-recovery.js');
const { makeTempDir, removeTempDir } = await import('./helpers.js');

let dir: string;
const primary = (name: string): string => path.join(dir, 'state', `${name}.json`);
const backup = (name: string): string => path.join(dir, 'state', `${name}.backup.json`);

beforeAll(async () => {
  dir = await makeTempDir('clf-goal-recovery-');
  initConfigPath(dir);
  initDurableStore(dir);
});

beforeEach(async () => {
  resetGoalStateForTests();
  resetDurableRecoveryForTests();
  resetDurableForTests();
  initDurableStore(dir);
  await fs.rm(path.join(dir, 'state'), { recursive: true, force: true });
  await saveConfig({
    ...defaultConfig(),
    goal: { ...defaultConfig().goal, enabled: true, mode: 'goal' }
  });
});

afterAll(async () => {
  resetGoalStateForTests();
  resetDurableRecoveryForTests();
  resetDurableForTests();
  if (dir) await removeTempDir(dir);
});

describe('Goal durable corruption recovery', () => {
  it('keeps valid objective and switch facts readable when the reply ledger is corrupt, but pauses driving', async () => {
    const conversationId = 'goal-chat-0001';
    await setGoalObjectiveNow(conversationId, 'finish the verified migration');
    await setGoalSwitchNow(conversationId, 'goal', true);
    await fs.writeFile(primary(GOAL_REPLIES_STATE), '{"version":', 'utf8');
    const corrupt = await fs.readFile(primary(GOAL_REPLIES_STATE), 'utf8');

    resetGoalStateForTests();
    resetDurableRecoveryForTests();

    expect(await restoreGoalAuthorityState()).toBe(false);
    expect(goalRecoveryPaused()).toBe(true);
    expect(goalObjectiveFor(conversationId)).toBe('finish the verified migration');
    expect(goalSwitchFor(conversationId)).toMatchObject({ enabled: true, mode: 'goal', own: true });
    expect(goalSwitchEnabledFor(conversationId)).toBe(false);
    expect(durableRecoveryIncidents('goal')).toContainEqual(
      expect.objectContaining({
        ledger: GOAL_REPLIES_STATE,
        copy: 'primary',
        failure: 'json_corrupt',
        disposition: 'pause'
      })
    );
    expect(await fs.readFile(primary(GOAL_REPLIES_STATE), 'utf8')).toBe(corrupt);
    await expect(setGoalObjectiveNow(conversationId, 'must not overwrite evidence')).rejects.toThrow(
      'goal_durable_recovery_required'
    );
  });

  it('does not resurrect an objective from a surviving backup when its primary is missing', async () => {
    const conversationId = 'goal-chat-0002';
    await setGoalObjectiveNow(conversationId, 'stale backup objective');
    expect(await readDurableResult(GOAL_OBJECTIVES_STATE, 'backup')).toMatchObject({ kind: 'valid' });
    await fs.rm(primary(GOAL_OBJECTIVES_STATE), { force: true });

    resetGoalStateForTests();
    resetDurableRecoveryForTests();

    expect(await restoreGoalAuthorityState()).toBe(false);
    expect(goalRecoveryPaused()).toBe(true);
    expect(goalObjectiveFor(conversationId)).toBe('');
    expect(durableRecoveryIncidents('goal')).toContainEqual(
      expect.objectContaining({
        ledger: GOAL_OBJECTIVES_STATE,
        copy: 'primary',
        failure: 'orphan_backup',
        disposition: 'pause'
      })
    );
    expect(await readDurableResult(GOAL_OBJECTIVES_STATE, 'backup')).toMatchObject({ kind: 'valid' });
  });

  it('repairs a corrupt backup from a valid switch primary without pausing Goal', async () => {
    const conversationId = 'goal-chat-0003';
    await setGoalSwitchNow(conversationId, 'loop', true);
    await fs.writeFile(backup(GOAL_SWITCHES_STATE), '{"version":', 'utf8');

    resetGoalStateForTests();
    resetDurableRecoveryForTests();

    expect(await restoreGoalAuthorityState()).toBe(true);
    expect(goalRecoveryPaused()).toBe(false);
    expect(goalSwitchFor(conversationId)).toMatchObject({ enabled: true, mode: 'loop', own: true });
    expect(await readDurableResult(GOAL_SWITCHES_STATE, 'backup')).toMatchObject({ kind: 'valid' });
    expect(durableRecoveryIncidents('goal')).toEqual([]);
  });

  it('keeps the Goal domain paused when both copies of one ledger are malformed', async () => {
    await fs.mkdir(path.dirname(primary(GOAL_REPLIES_STATE)), { recursive: true });
    await fs.writeFile(primary(GOAL_REPLIES_STATE), '{"version":', 'utf8');
    await fs.writeFile(backup(GOAL_REPLIES_STATE), '{"version":', 'utf8');

    expect(await restoreGoalAuthorityState()).toBe(false);
    expect(goalRecoveryPaused()).toBe(true);
    expect(durableRecoveryIncidents('goal')).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ledger: GOAL_REPLIES_STATE,
        copy: 'primary',
        failure: 'json_corrupt',
        disposition: 'pause'
      }),
      expect.objectContaining({
        ledger: GOAL_REPLIES_STATE,
        copy: 'backup',
        failure: 'json_corrupt',
        disposition: 'degraded'
      })
    ]));
  });
});
