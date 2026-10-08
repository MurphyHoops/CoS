import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodexAppServerClient } from '../../src/main/next/model/codex-app-server.js';

let cwd: string;
let client: CodexAppServerClient;
let notifications: string[];
const script = path.resolve(process.cwd(), 'test/next/fixtures/fake-codex-app-server.mjs');
beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-next-fake-model-'));
  notifications = [];
  client = new CodexAppServerClient(process.execPath, cwd, 'FAKE_OAUTH_TOKEN_NOT_REAL',
    name => notifications.push(name), [script]);
});
afterEach(async () => {
  await client.close();
  await fs.rm(cwd, { recursive: true, force: true });
});
describe('Optional ChatGPT-plan-backed Codex app-server JSONL contract, fake offline provider', () => {
  it('initializes the server, starts a distinct thread and completes a simulated turn', async () => {
    await client.start();
    const thread = await client.startThread();
    const result = await client.runTurn(thread, 'summarize sandbox project');
    expect(result).toMatchObject({ threadId: thread, turnId: 'turn-1', status: 'completed' });
    expect(notifications).toContain('turn/completed');
  });
  it('handles completion arriving before the start response without losing the exact turn', async () => {
    await client.start();
    const thread = await client.startThread();
    const first = await client.runTurn(thread, '[early] fast turnaround');
    const second = await client.runTurn(thread, 'next turn');
    expect(first.turnId).toBe('turn-1');
    expect(second.turnId).toBe('turn-2');
  });
  it('returns failed and interrupted turn receipts without false success', async () => {
    await client.start();
    const thread = await client.startThread();
    expect((await client.runTurn(thread, '[failed]')).status).toBe('failed');
    expect((await client.runTurn(thread, '[interrupted]')).status).toBe('interrupted');
  });
  it('declines every simulated server-side unsafe command request by default', async () => {
    await client.start();
    const thread = await client.startThread();
    const result = await client.runTurn(thread, '[approval] needs execution');
    expect(result.status).toBe('completed');
    // The simulated server only emits turn/completed after it sees decline.
    expect(notifications).toContain('turn/completed');
  });
  it('fences an uncertain inference turn and never automatically starts another one', async () => {
    await client.start();
    const thread = await client.startThread();
    await expect(client.runTurn(thread, '[hang]', 1000)).rejects.toThrow('CODEX_TURN_OUTCOME_UNKNOWN');
  });
  it('rejects invalid local binary, missing token and unsafe fake argv outside test', async () => {
    expect(() => new CodexAppServerClient('codex', cwd, 'token')).toThrow('CODEX_STARTUP_NOT_AUTHORIZED');
    expect(() => new CodexAppServerClient(process.execPath, cwd, '')).toThrow('CODEX_STARTUP_NOT_AUTHORIZED');
  });
});
