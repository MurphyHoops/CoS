import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { reserveTunnelOwnership, tunnelOwnershipPath } from '../../src/main/next/tunnel/exclusive-owner.mjs';

const ID_A = 'tunnel_' + 'a'.repeat(32);
const ID_B = 'tunnel_' + 'b'.repeat(32);
const script = fileURLToPath(new URL('./fixtures/tunnel-owner-worker.mjs', import.meta.url));
let root: string;
const children: ChildProcessWithoutNullStreams[] = [];
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-next-owner-test-'));
});
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && !child.killed) child.kill('SIGKILL');
  }
  await fs.rm(root, { recursive: true, force: true });
});
type WorkerState = {
  pending: string[];
  waiters: Array<{ accept: (line: string) => void; reject: (error: Error) => void }>;
  buffered: string;
  closed: boolean;
};
const workerStates = new WeakMap<ChildProcessWithoutNullStreams, WorkerState>();
function child(label: string, id = ID_A) {
  const p = spawn(process.execPath, [script], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, COS_NEXT_TEST_LOCK_ROOT: root, COS_NEXT_TEST_TUNNEL_ID: id, COS_NEXT_TEST_LABEL: label }
  });
  const state: WorkerState = { pending: [], waiters: [], buffered: '', closed: false };
  workerStates.set(p, state);
  // Attach immediately at spawn, before any await between two competing children.
  p.stdout.on('data', (chunk: Buffer) => {
    state.buffered += chunk.toString('utf8');
    for (;;) {
      const end = state.buffered.indexOf('\n');
      if (end < 0) break;
      const line = state.buffered.slice(0, end).trim();
      state.buffered = state.buffered.slice(end + 1);
      const waiter = state.waiters.shift();
      if (waiter) waiter.accept(line);
      else state.pending.push(line);
    }
  });
  p.on('close', code => {
    state.closed = true;
    for (const waiter of state.waiters.splice(0)) {
      waiter.reject(new Error('worker closed before result: ' + code));
    }
  });
  p.on('error', error => {
    state.closed = true;
    for (const waiter of state.waiters.splice(0)) waiter.reject(error);
  });
  children.push(p);
  return p;
}
async function nextLine(proc: ChildProcessWithoutNullStreams): Promise<string> {
  const state = workerStates.get(proc);
  if (!state) throw new Error('unknown test worker');
  if (state.pending.length > 0) return state.pending.shift()!;
  if (state.closed) throw new Error('worker already closed before expected result');
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const i = state.waiters.indexOf(waiter);
      if (i >= 0) state.waiters.splice(i, 1);
      reject(new Error('worker response timed out'));
    }, 5000);
    const waiter = {
      accept(line: string) { clearTimeout(timer); resolve(line); },
      reject(error: Error) { clearTimeout(timer); reject(error); }
    };
    state.waiters.push(waiter);
  });
}
describe('WP08 single Tunnel ID ownership without touching active tunnel clients', () => {
  it('derives one label-independent lock path and never writes raw Tunnel IDs', async () => {
    const p = tunnelOwnershipPath(ID_A, root);
    expect(p).not.toContain(ID_A);
    const handle = await reserveTunnelOwnership(ID_A, { root, label: 'core' });
    try {
      const file = await fs.readFile(path.join(p, 'owner.json'), 'utf8');
      expect(file).not.toContain(ID_A);
      expect(file).toContain('"label":"core"');
      await handle.verify();
    } finally { await handle.release(); }
  });
  it('refuses a second contender for the same ID regardless of connector label', async () => {
    const handle = await reserveTunnelOwnership(ID_A, { root, label: 'core' });
    try {
      await expect(reserveTunnelOwnership(ID_A, { root, label: 'desktop' }))
        .rejects.toMatchObject({ code: 'TUNNEL_ALREADY_RESERVED' });
    } finally { await handle.release(); }
    const next = await reserveTunnelOwnership(ID_A, { root, label: 'plugins' });
    await next.release();
  });
  it('lets separate tunnel IDs coexist', async () => {
    const a = await reserveTunnelOwnership(ID_A, { root });
    const b = await reserveTunnelOwnership(ID_B, { root });
    try { await a.verify(); await b.verify(); }
    finally { await a.release(); await b.release(); }
  });
  it('rejects malformed IDs, labels and nonabsolute lock roots', async () => {
    expect(() => tunnelOwnershipPath('not-a-tunnel', root)).toThrow();
    expect(() => tunnelOwnershipPath(ID_A, '../relative')).toThrow();
    await expect(reserveTunnelOwnership(ID_A, { root, label: '../attack' }))
      .rejects.toMatchObject({ code: 'INVALID_LABEL' });
  });
  it('rejects ambiguous owner metadata and never takes down unrelated processes', async () => {
    const p = tunnelOwnershipPath(ID_A, root);
    await fs.mkdir(p, { recursive: true });
    await expect(reserveTunnelOwnership(ID_A, { root }))
      .rejects.toMatchObject({ code: 'TUNNEL_ALREADY_RESERVED' });
  });
  it('fails closed when another actor alters ownership while running', async () => {
    const handle = await reserveTunnelOwnership(ID_A, { root });
    const file = path.join(tunnelOwnershipPath(ID_A, root), 'owner.json');
    await fs.writeFile(file, '{}');
    await expect(handle.verify()).rejects.toMatchObject({ code: 'OWNERSHIP_AMBIGUOUS' });
    await expect(handle.release()).rejects.toMatchObject({ code: 'OWNERSHIP_AMBIGUOUS' });
  });
  it('can release exactly once, and cannot verify a released lock', async () => {
    const h = await reserveTunnelOwnership(ID_A, { root });
    await h.release();
    await h.release();
    await expect(h.verify()).rejects.toMatchObject({ code: 'RESERVATION_RELEASED' });
  });
  it('refuses cleanup when the lock directory is replaced before release', async () => {
    const h = await reserveTunnelOwnership(ID_A, { root });
    const original = tunnelOwnershipPath(ID_A, root);
    const other = original + '.original';
    await fs.rename(original, other);
    await fs.mkdir(original);
    await fs.writeFile(path.join(original, 'owner.json'), '{}');
    await expect(h.release()).rejects.toMatchObject({ code: 'OWNERSHIP_AMBIGUOUS' });
    expect(await fs.readFile(path.join(original, 'owner.json'), 'utf8')).toBe('{}');
  });
  it('cannot reuse an invalid stale owner record without an explicit reconciliation', async () => {
    const p = tunnelOwnershipPath(ID_A, root);
    await fs.mkdir(p, { recursive: true });
    await fs.writeFile(path.join(p, 'owner.json'), JSON.stringify({ pid: 0, nonce: '0'.repeat(48) }));
    await expect(reserveTunnelOwnership(ID_A, { root })).rejects.toMatchObject({ code: 'TUNNEL_ALREADY_RESERVED' });
  });
  it('coalesces concurrent release requests without accidentally releasing a successor', async () => {
    const h = await reserveTunnelOwnership(ID_A, { root });
    const calls = await Promise.all([h.release(), h.release(), h.release()]);
    expect(calls).toEqual([undefined, undefined, undefined]);
    const successor = await reserveTunnelOwnership(ID_A, { root, label: 'desktop' });
    await h.release();
    await successor.verify();
    await successor.release();
  });
  it('blocks a separate OS process while another process holds the same Tunnel ID', async () => {
    const first = child('core');
    expect(await nextLine(first)).toBe('ACQUIRED');
    const second = child('desktop');
    expect(await nextLine(second)).toBe('REFUSED:TUNNEL_ALREADY_RESERVED');
    first.stdin.write('release\n');
    expect(await nextLine(first)).toBe('RELEASED');
    const replacement = child('plugins');
    expect(await nextLine(replacement)).toBe('ACQUIRED');
    replacement.stdin.write('release\n');
    expect(await nextLine(replacement)).toBe('RELEASED');
  }, 15000);
  it('does not automatically steal a lock after the owning OS process is killed', async () => {
    const first = child('core');
    expect(await nextLine(first)).toBe('ACQUIRED');
    first.kill('SIGKILL');
    const second = child('desktop');
    expect(await nextLine(second)).toBe('REFUSED:TUNNEL_ALREADY_RESERVED');
  }, 15000);
  it('admits only one winner on genuinely concurrent separate-process claims', async () => {
    const first = child('core');
    const second = child('desktop');
    const outcomes = await Promise.all([nextLine(first), nextLine(second)]);
    expect([...outcomes].sort()).toEqual(['ACQUIRED', 'REFUSED:TUNNEL_ALREADY_RESERVED']);
    const winner = outcomes[0] === 'ACQUIRED' ? first : second;
    winner.stdin.write('release\n');
    expect(await nextLine(winner)).toBe('RELEASED');
  }, 15000);
});
