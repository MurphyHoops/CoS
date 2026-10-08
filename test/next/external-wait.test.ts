import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MissionKernel, type MissionSnapshot, type MissionStorage } from '../../src/main/next/mission/kernel.js';
import { NativeWaitEvidence, NextExternalWaitSupervisor, type WaitProbeState } from '../../src/main/next/wait/external-wait.js';

const ctx = { inbound: 'verified', projectId: 'p-A', missionId: 'm-A', epoch: 1 };
const lease = { authorize: async ({ inbound, epoch }: { inbound: unknown; epoch: number }) =>
  inbound === 'verified' && epoch === 1 ? { allowed: true as const, leaseId: 'lease-A' } :
  { allowed: false as const, reason: 'NOT_BOUND' as const } };
let root: string;
let kernel: MissionKernel;
let storage: MissionStorage & { snapshot?: MissionSnapshot; writes: number };
let evidence: NativeWaitEvidence;
let calls: number;
let remote: WaitProbeState;
let provider: NextExternalWaitSupervisor;
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cosnext-external-wait-')));
  storage = {
    writes: 0,
    read: async () => storage.snapshot ? { kind: 'valid' as const, value: structuredClone(storage.snapshot) } :
      { kind: 'missing' as const },
    commit: async s => { storage.snapshot = structuredClone(s); storage.writes++; }
  };
  evidence = new NativeWaitEvidence();
  kernel = new MissionKernel(storage, lease, { approve: async () => true }, {
    verifyEffect: async () => false, verifyCompletion: async () => false,
    verifyWait: (r, m, o, h) => evidence.verifyWait(r, m, o, h),
    verifyContinuation: (r, m, o, h) => evidence.verifyContinuation(r, m, o, h),
    verifyWorkerClaim: async () => false, verifyWorkerReport: async () => false,
    verifyWorkerReconciliation: async () => false
  });
  await kernel.restore();
  await kernel.provisionProject('p-A', root, true);
  await kernel.provisionMission('p-A', 'm-A', ['ci'], true);
  await kernel.armWait(ctx, 1, 'wait-1', 'github-run:12345', 'ci');
  remote = { state: 'PENDING' }; calls = 0;
  provider = new NextExternalWaitSupervisor(kernel, evidence, async () => { calls++; return remote; });
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe('WP05 real durable external wait to continuation-owed handoff', () => {
  it('keeps an in-progress external run waiting and never claims model continuation', async () => {
    expect(await provider.tick(ctx, 'wait-1')).toBe('PENDING');
    const state = (await kernel.inspect(ctx)).obligations[0]!;
    expect(state).toMatchObject({ state: 'ARMED', outcome: 'PENDING', continuation: 'NONE' });
  });
  it('records external completion once with hash evidence, without starting a browser turn', async () => {
    remote = { state: 'COMPLETE', result: 'SUCCESS',
      externalRecord: { runId: 12345, head_sha: 'abc', conclusion: 'success' } };
    expect(await provider.tick(ctx, 'wait-1')).toBe('CONTINUATION_OWED');
    const first = (await kernel.inspect(ctx)).obligations[0]!;
    expect(first).toMatchObject({ state: 'RESOLVED', outcome: 'SUCCESS', continuation: 'OWED' });
    expect(first.evidenceDigest).toMatch(/^[a-f0-9]{64}$/);
    const n = storage.writes;
    expect(await provider.tick(ctx, 'wait-1')).toBe('ALREADY_RESOLVED');
    expect(storage.writes).toBe(n);
    expect(calls).toBe(1);
  });
  it('records a failed CI as FAILURE rather than false success', async () => {
    remote = { state: 'COMPLETE', result: 'FAILURE',
      externalRecord: { runId: 12345, conclusion: 'failure' } };
    expect(await provider.tick(ctx, 'wait-1')).toBe('CONTINUATION_OWED');
    expect((await kernel.inspect(ctx)).obligations[0]).toMatchObject({
      outcome: 'FAILURE', continuation: 'OWED'
    });
  });
  it('cannot complete or ACK a mission simply because a watcher observed CI completion', async () => {
    remote = { state: 'COMPLETE', result: 'SUCCESS', externalRecord: { runId: 12345 } };
    await provider.tick(ctx, 'wait-1');
    const obligation = (await kernel.inspect(ctx)).obligations[0]!;
    await expect(kernel.ackContinuation(ctx, 'wait-1', { 'openai/session': 'forged' }))
      .rejects.toThrow('CONTINUATION_ACK_NOT_VERIFIED');
    const ticket = evidence.mintContinuation(ctx.missionId, 'wait-1', obligation.evidenceDigest!);
    const acked = await kernel.ackContinuation(ctx, 'wait-1', ticket);
    expect(acked.continuation).toBe('ACKED');
    await expect(kernel.ackContinuation(ctx, 'wait-1', ticket)).rejects.toThrow('CONTINUATION_NOT_OWED');
  });
  it('a Stop arriving while the provider fetches wins and forbids later completion', async () => {
    let started!: () => void;
    let release!: (r: WaitProbeState) => void;
    const pending = new Promise<void>(r => { started = r; });
    const race = new NextExternalWaitSupervisor(kernel, evidence, async () => {
      started();
      return await new Promise<WaitProbeState>(r => { release = r; });
    });
    const tick = race.tick(ctx, 'wait-1');
    await pending;
    await kernel.stop(ctx, 2);
    release({ state: 'COMPLETE', result: 'SUCCESS', externalRecord: { from: 'old-epoch' } });
    expect(await tick).toBe('HOLD');
    expect(storage.snapshot?.obligations['wait-1']?.state).toBe('CANCELLED');
  });
  it('no parallel provider polling or duplicate durable delivery for one event', async () => {
    remote = { state: 'COMPLETE', result: 'SUCCESS', externalRecord: { ci: true } };
    const statuses = await Promise.all(Array.from({ length: 25 },
      () => provider.tick(ctx, 'wait-1')));
    expect(statuses.filter(x => x === 'CONTINUATION_OWED')).toHaveLength(1);
    expect(calls).toBe(1);
    expect(storage.snapshot?.obligations['wait-1']?.continuation).toBe('OWED');
  });
  it('times out a provider that ignores AbortSignal instead of hanging shutdown indefinitely', async () => {
    const blocked = new NextExternalWaitSupervisor(kernel, evidence,
      async () => await new Promise<WaitProbeState>(() => {}));
    const t0 = Date.now();
    expect(await blocked.tick(ctx, 'wait-1', 100)).toBe('RETRY_LATER');
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(storage.snapshot?.obligations['wait-1']?.state).toBe('ARMED');
  });

  it('an unavailable or corrupt external result never transitions or persists an obligation', async () => {
    remote = { state: 'UNKNOWN' };
    const writes = storage.writes;
    expect(await provider.tick(ctx, 'wait-1')).toBe('RETRY_LATER');
    expect(storage.writes).toBe(writes);
    expect(storage.snapshot?.obligations['wait-1']?.state).toBe('ARMED');
  });
});
