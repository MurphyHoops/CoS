import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
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
  initDurableStore,
  readDurableResult,
  resetDurableForTests,
  writeDurableCheckpointNow,
  writeDurableNow
} = await import('../src/main/durable.js');
const {
  SESSION_INPUT_STATE,
  inputRecoveryPaused,
  listInputs,
  resetInputForTests
} = await import('../src/main/session/input.js');
const {
  durableRecoveryIncidents,
  resetDurableRecoveryForTests
} = await import('../src/main/durable-recovery.js');
const { initSessionStore, resetSessionStoreForTests } = await import('../src/main/session/store.js');
const { makeTempDir, removeTempDir } = await import('./helpers.js');

let dir: string;
const primary = (): string => path.join(dir, 'state', `${SESSION_INPUT_STATE}.json`);
const backup = (): string => path.join(dir, 'state', `${SESSION_INPUT_STATE}.backup.json`);

function terminalRow(id = randomUUID()) {
  return {
    id,
    sessionId: null,
    text: 'retained terminal input',
    mode: 'after-turn' as const,
    dueAt: 1,
    model: null,
    reasoningEffort: null,
    state: 'failed' as const,
    owner: null,
    createdAt: 1,
    conversationId: null,
    error: 'not delivered'
  };
}

beforeAll(async () => {
  dir = await makeTempDir('clf-input-recovery-');
  initConfigPath(dir);
  initDurableStore(dir);
  initSessionStore(dir);
  await saveConfig(defaultConfig());
});

beforeEach(async () => {
  resetInputForTests();
  resetDurableRecoveryForTests();
  resetDurableForTests();
  resetSessionStoreForTests();
  initDurableStore(dir);
  initSessionStore(dir);
  await fs.rm(path.join(dir, 'state'), { recursive: true, force: true });
  await saveConfig(defaultConfig());
});

afterAll(async () => {
  resetInputForTests();
  resetDurableRecoveryForTests();
  resetDurableForTests();
  resetSessionStoreForTests();
  if (dir) await removeTempDir(dir);
});

describe('session-input durable corruption recovery', () => {
  it('pauses on a corrupt primary and never restores a valid backup as resend authority', async () => {
    const rows = [terminalRow()];
    await writeDurableNow(SESSION_INPUT_STATE, rows);
    await writeDurableCheckpointNow(SESSION_INPUT_STATE, rows);
    await fs.writeFile(primary(), '{"id":', 'utf8');

    await expect(listInputs()).rejects.toThrow('input_durable_recovery_required');

    expect(inputRecoveryPaused()).toBe(true);
    expect(durableRecoveryIncidents('input')).toContainEqual(
      expect.objectContaining({
        ledger: SESSION_INPUT_STATE,
        copy: 'primary',
        failure: 'json_corrupt',
        disposition: 'pause'
      })
    );
    expect(await readDurableResult(SESSION_INPUT_STATE, 'backup')).toMatchObject({ kind: 'valid' });
  });

  it('keeps recovery paused when both primary and backup are malformed', async () => {
    await fs.mkdir(path.dirname(primary()), { recursive: true });
    await fs.writeFile(primary(), '{"id":', 'utf8');
    await fs.writeFile(backup(), '{"id":', 'utf8');

    await expect(listInputs()).rejects.toThrow('input_durable_recovery_required');

    expect(durableRecoveryIncidents('input')).toEqual(expect.arrayContaining([
      expect.objectContaining({ copy: 'primary', failure: 'json_corrupt', disposition: 'pause' }),
      expect.objectContaining({ copy: 'backup', failure: 'json_corrupt', disposition: 'degraded' })
    ]));
  });

  it('rejects duplicate durable row identities as whole-ledger schema corruption', async () => {
    const id = randomUUID();
    await writeDurableNow(SESSION_INPUT_STATE, [terminalRow(id), terminalRow(id)]);

    await expect(listInputs()).rejects.toThrow('input_durable_recovery_required');

    expect(inputRecoveryPaused()).toBe(true);
    expect(durableRecoveryIncidents('input')).toContainEqual(
      expect.objectContaining({ copy: 'primary', failure: 'schema_invalid', disposition: 'pause' })
    );
  });

  it('does not treat a missing primary with surviving backup evidence as an empty outbox', async () => {
    await writeDurableCheckpointNow(SESSION_INPUT_STATE, [terminalRow()]);

    await expect(listInputs()).rejects.toThrow('input_durable_recovery_required');

    expect(inputRecoveryPaused()).toBe(true);
    expect(durableRecoveryIncidents('input')).toContainEqual(
      expect.objectContaining({ copy: 'primary', failure: 'orphan_backup', disposition: 'pause' })
    );
  });

  it('accepts an explicit durable empty outbox and checkpoints that same generation', async () => {
    await writeDurableNow(SESSION_INPUT_STATE, []);

    await expect(listInputs()).resolves.toEqual([]);

    expect(inputRecoveryPaused()).toBe(false);
    expect(await readDurableResult(SESSION_INPUT_STATE, 'backup')).toMatchObject({ kind: 'valid', value: [] });
  });
});
