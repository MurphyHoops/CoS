import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MissionKernel, type MissionStorage, type MissionSnapshot } from '../../src/main/next/mission/kernel.js';
import { NextNativeCommandExecutor, NativeProcessEvidence, type LocalCommand } from '../../src/main/next/executor/native-command.js';

let root: string;
let store: MissionStorage & { state?: MissionSnapshot };
let kernel: MissionKernel;
let runner: NextNativeCommandExecutor;
let evidence: NativeProcessEvidence;
const context = { inbound: 'verified-native-A', missionId: 'mission-A', projectId: 'project-A', epoch: 1 };
const lease = {
  authorize: async ({ inbound, projectId, missionId, epoch }: { inbound: unknown; projectId: string; missionId: string; epoch: number; capability: string }) =>
    inbound === 'verified-native-A' && projectId === 'project-A' && missionId === 'mission-A' && epoch === 1
      ? { allowed: true as const, leaseId: 'lease-A' }
      : { allowed: false as const, reason: 'NOT_BOUND' as const }
};
const admin = {
  approve: async (ticket: unknown, operation: string) => ticket === 'trusted-admin-' + operation
};
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cos-next-command-')));
  store = {
    read: async () => store.state ? { kind: 'valid' as const, value: structuredClone(store.state) } :
      { kind: 'missing' as const },
    commit: async s => { store.state = structuredClone(s); }
  };
  evidence = new NativeProcessEvidence();
  kernel = new MissionKernel(store, lease, admin, evidence);
  await kernel.restore();
  await kernel.provisionProject('project-A', root, 'trusted-admin-project');
  await kernel.provisionMission('project-A', 'mission-A', ['ci'], 'trusted-admin-create');
  runner = new NextNativeCommandExecutor(kernel, evidence, new Map());
});
afterEach(async () => { runner.dispose(); await fs.rm(root, { recursive: true, force: true }); });
function runApproved(spec: LocalCommand) {
  runner.dispose();
  runner = new NextNativeCommandExecutor(kernel, evidence, new Map([
    [context.missionId + '\0call-1', { missionId: context.missionId, invocationId: 'call-1', spec }]
  ]));
  return runner.run(context, 'call-1', spec);
}
async function admit(invocationId = 'call-1', key = 'once', revision = 1) {
  await kernel.admitEffect(context, {
    invocationId, idempotencyKey: key, expectedRevision: revision,
    capability: 'command', payloadDigest: 'a'.repeat(64)
  });
}

describe('WP05 actual bounded native OS process and durable effect receipts', () => {
  it('executes one local approved node process and records OS exit evidence', async () => {
    await admit();
    const outcome = await runApproved({
      program: process.execPath,
      args: ['-e', "require('node:fs').writeFileSync('proof.txt','done')"],
      timeoutMs: 5_000
    });
    expect(outcome).toMatchObject({ exitCode: 0, timedOut: false, observed: true });
    expect(outcome.outputDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(await fs.readFile(path.join(root, 'proof.txt'), 'utf8')).toBe('done');
    expect(store.state?.effects['call-1']!.state).toBe('EFFECT_OBSERVED');
    await expect(runner.run(context, 'call-1', {
      program: process.execPath, args: ['-e', "require('node:fs').writeFileSync('proof.txt','BAD')"],
      timeoutMs: 5_000
    })).rejects.toThrow('PROGRAM_NOT_APPROVED');
    expect(await fs.readFile(path.join(root, 'proof.txt'), 'utf8')).toBe('done');
  });

  it('rejects disallowed binaries, shells and invalid argv before effects start', async () => {
    await admit();
    await expect(runner.run(context, 'call-1', {
      program: '/bin/sh', args: ['-c', 'touch BAD'], timeoutMs: 5_000
    })).rejects.toThrow('PROGRAM_NOT_APPROVED');
    await expect(runner.run(context, 'call-1', {
      program: process.execPath, args: ['\u0000'], timeoutMs: 5_000
    })).rejects.toThrow('PROGRAM_NOT_APPROVED');
    expect(store.state?.effects['call-1']!.state).toBe('ADMITTED');
  });

  it('freezes exact argv authorization and rejects mutation of the originally approved command', async () => {
    await admit();
    const approved = { program: process.execPath,
      args: ['-e', "require('node:fs').writeFileSync('proof.txt','SAFE')"], timeoutMs: 5_000 };
    const catalog = new Map([[context.missionId + '\0call-1', {
      missionId: context.missionId, invocationId: 'call-1', spec: approved
    }]]);
    runner.dispose();
    runner = new NextNativeCommandExecutor(kernel, evidence, catalog);
    approved.args[1] = "require('node:fs').writeFileSync('proof.txt','INJECTED')";
    catalog.clear();
    await expect(runner.run(context, 'call-1', approved)).rejects.toThrow('PROGRAM_NOT_APPROVED');
    expect(store.state?.effects['call-1']!.state).toBe('ADMITTED');
    const safe = await runner.run(context, 'call-1', {
      program: process.execPath,
      args: ['-e', "require('node:fs').writeFileSync('proof.txt','SAFE')"], timeoutMs: 5_000
    });
    expect(safe.observed).toBe(true);
    expect(await fs.readFile(path.join(root, 'proof.txt'), 'utf8')).toBe('SAFE');
  });

  it('a nonzero process exit is an observed external effect, not model success', async () => {
    await admit();
    const out = await runApproved({
      program: process.execPath, args: ['-e', 'process.exit(7)'], timeoutMs: 5_000
    });
    expect(out).toMatchObject({ exitCode: 7, timedOut: false, observed: true });
    expect(store.state?.effects['call-1']!.state).toBe('EFFECT_OBSERVED');
  });

  it('pauses uncertain timed-out commands without pretending exit was verified', async () => {
    await admit();
    const out = await runApproved({
      program: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], timeoutMs: 200
    });
    expect(out.timedOut).toBe(true);
    expect(out.observed).toBe(false);
    expect(store.state?.effects['call-1']!.state).toBe('DISPATCHED');
    const restart = new MissionKernel(store, lease, admin, new NativeProcessEvidence());
    await restart.restore();
    expect((await restart.inspect(context)).effects[0]!.state).toBe('UNKNOWN_EFFECT');
  });

  it('Stop cancels a real running process after durable fencing and preserves unknown effect', async () => {
    await admit();
    const future = runApproved({
      program: process.execPath,
      args: ['-e', "require('node:fs').writeFileSync('started','yes');setInterval(()=>{},100)"],
      timeoutMs: 10_000
    });
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      try { await fs.stat(path.join(root, 'started')); break; }
      catch { await new Promise(resolve => setTimeout(resolve, 15)); }
    }
    expect(await fs.readFile(path.join(root, 'started'), 'utf8')).toBe('yes');
    expect(store.state?.effects['call-1']!.state).toBe('DISPATCHED');
    await kernel.stop(context, 3);
    expect(store.state?.effects['call-1']!.state).toBe('UNKNOWN_EFFECT');
    const outcome = await future;
    expect(outcome.cancelled).toBe(true);
    expect(outcome.observed).toBe(false);
    expect(outcome.timedOut).toBe(false);
  });

  it('Pause also cancels a live process rather than leaving side effects active', async () => {
    await admit();
    const future = runApproved({
      program: process.execPath,
      args: ['-e', "require('node:fs').writeFileSync('started','yes');setInterval(()=>{},100)"],
      timeoutMs: 10_000
    });
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      try { await fs.stat(path.join(root, 'started')); break; }
      catch { await new Promise(resolve => setTimeout(resolve, 15)); }
    }
    expect(await fs.readFile(path.join(root, 'started'), 'utf8')).toBe('yes');
    await kernel.pause(context, 3);
    const outcome = await future;
    expect(outcome.cancelled).toBe(true);
    expect(store.state?.effects['call-1']!.state).toBe('UNKNOWN_EFFECT');
  });

  it('does not execute any command when Mission Stop commits before launch', async () => {
    await admit();
    await kernel.stop(context, 2);
    await expect(runApproved({
      program: process.execPath,
      args: ['-e', "require('node:fs').writeFileSync('danger','oops')"], timeoutMs: 5_000
    })).rejects.toThrow('NOT_AUTHORIZED');
    await expect(fs.stat(path.join(root, 'danger'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
