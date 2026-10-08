import { beforeEach, describe, expect, it } from 'vitest';
import { MissionKernel, type MissionSnapshot, type MissionStorage } from '../../src/main/next/mission/kernel.js';
import { NativeWorkerEvidence, NextWorkerBroker } from '../../src/main/next/model/worker-broker.js';
import type { TurnReceipt } from '../../src/main/next/model/codex-app-server.js';

let kernel: MissionKernel;
let store: MissionStorage & { snapshot?: MissionSnapshot };
let approval = true;
let calls = 0;
let receipt: NativeWorkerEvidence;
const ctx = { inbound: 'verified-host', missionId: 'mission-A', projectId: 'project-A', epoch: 1 };
const projectRoot = process.cwd();
const lease = {
  authorize: async ({ inbound, missionId, epoch, projectId }: {
    inbound: unknown; missionId: string; projectId: string; epoch: number
  }) => inbound === 'verified-host' && missionId === 'mission-A' && projectId === 'project-A' && epoch === 1
    ? { allowed: true as const, leaseId: 'lease-A' }
    : { allowed: false as const, reason: 'NOT_BOUND' as const }
};
beforeEach(async () => {
  calls = 0; approval = true;
  store = {
    read: async () => store.snapshot ? { kind: 'valid' as const, value: structuredClone(store.snapshot) } :
      { kind: 'missing' as const },
    commit: async s => { store.snapshot = structuredClone(s); }
  };
  receipt = new NativeWorkerEvidence();
  kernel = new MissionKernel(store, lease, {
    approve: async (v: unknown, op) => v === 'admin:' + op
  }, {
    verifyEffect: async () => false, verifyWait: async () => false,
    verifyContinuation: async () => false,
    verifyCompletion: async () => false,
    verifyWorkerClaim: (v, mid, id, epoch) => receipt.verifyWorkerClaim(v, mid, id, epoch),
    verifyWorkerReport: (v, mid, id, digest) => receipt.verifyWorkerReport(v, mid, id, digest),
    verifyWorkerReconciliation: (v, mid, id, outcome, digest) =>
      receipt.verifyWorkerReconciliation(v, mid, id, outcome, digest)
  });
  await kernel.restore();
  await kernel.provisionProject('project-A', projectRoot, 'admin:project');
  await kernel.provisionMission('project-A', 'mission-A', ['ci'], 'admin:create');
});
const model = (status: TurnReceipt['status'] = 'completed') => ({
  async runTurn(threadId: string) { calls++; return { threadId, turnId: 'turn-1', status }; }
});

describe('CoS Next WP04 Multi-Agent optional plan Worker broker', () => {
  it('executes only a queued verified Worker once and persists a local completion receipt', async () => {
    await kernel.delegate(ctx, 1, 'worker-1', 'a'.repeat(64));
    const broker = new NextWorkerBroker(kernel, receipt, model(), () => approval);
    const result = await broker.run(ctx, { agentId: 'worker-1', threadId: 'thread-1', prompt: 'review local repo' });
    expect(result.status).toBe('FINISHED');
    expect(result.digest).toMatch(/^[0-9a-f]{64}$/);
    expect((await kernel.inspect(ctx)).workers[0]?.state).toBe('FINISHED');
    await expect(broker.run(ctx, { agentId: 'worker-1', threadId: 'thread-1', prompt: 'run again' }))
      .rejects.toThrow('WORKER_NOT_CLAIMABLE');
    expect(calls).toBe(1);
  });
  it('never calls a model when the local plan user has not approved inference', async () => {
    await kernel.delegate(ctx, 1, 'worker-1', 'a'.repeat(64));
    approval = false;
    const broker = new NextWorkerBroker(kernel, receipt, model(), () => approval);
    await expect(broker.run(ctx, { agentId: 'worker-1', threadId: 'thread-1', prompt: 'test' }))
      .rejects.toThrow('PLAN_INFERENCE_NOT_APPROVED');
    expect(calls).toBe(0);
    expect((await kernel.inspect(ctx)).workers[0]?.state).toBe('QUEUED');
  });
  it('marks failed/interrupted provider turns DELIVERY_UNKNOWN rather than retrying', async () => {
    await kernel.delegate(ctx, 1, 'worker-1', 'a'.repeat(64));
    const broker = new NextWorkerBroker(kernel, receipt, model('failed'), () => true);
    const outcome = await broker.run(ctx, { agentId: 'worker-1', threadId: 'thread-1', prompt: 'test' });
    expect(outcome.status).toBe('HOLD');
    expect((await kernel.inspect(ctx)).workers[0]?.state).toBe('DELIVERY_UNKNOWN');
    await expect(broker.run(ctx, { agentId: 'worker-1', threadId: 'thread-1', prompt: 'retry' }))
      .rejects.toThrow('WORKER_NOT_CLAIMABLE');
    expect(calls).toBe(1);
  });
  it('a provider exception never automatically restarts the same logical Worker', async () => {
    await kernel.delegate(ctx, 1, 'worker-1', 'a'.repeat(64));
    const broker = new NextWorkerBroker(kernel, receipt, {
      async runTurn() { calls++; throw new Error('provider disconnected'); }
    }, () => true);
    expect((await broker.run(ctx, { agentId: 'worker-1', threadId: 'thread-1', prompt: 'test' })).status)
      .toBe('HOLD');
    expect(calls).toBe(1);
    expect((await kernel.inspect(ctx)).workers[0]?.state).toBe('DELIVERY_UNKNOWN');
  });
  it('forces a HOLD when Stop fences the Mission during an in-flight model response', async () => {
    await kernel.delegate(ctx, 1, 'worker-1', 'a'.repeat(64));
    let release!: (x: TurnReceipt) => void;
    let entered!: () => void;
    const modelStarted = new Promise<void>(resolve => { entered = resolve; });
    const broker = new NextWorkerBroker(kernel, receipt, {
      async runTurn() {
        entered();
        return await new Promise<TurnReceipt>(resolve => { release = resolve; });
      }
    }, () => true);
    const pending = broker.run(ctx, { agentId: 'worker-1', threadId: 'thread-1', prompt: 'test' });
    await modelStarted;
    await kernel.stop(ctx, 3);
    release({ threadId: 'thread-1', turnId: 'turn-1', status: 'completed' });
    expect((await pending).status).toBe('HOLD');
    expect(store.snapshot?.workers['worker-1']?.state).toBe('DELIVERY_UNKNOWN');
  });
  it('caps concurrent accepted worker turns before sending any further inference', async () => {
    await kernel.delegate(ctx, 1, 'worker-1', 'a'.repeat(64));
    await kernel.delegate(ctx, 2, 'worker-2', 'b'.repeat(64));
    let release!: (x: TurnReceipt) => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const broker = new NextWorkerBroker(kernel, receipt, {
      async runTurn(_threadId) {
        calls++;
        entered();
        return await new Promise<TurnReceipt>(resolve => { release = resolve; });
      }
    }, () => true, 1);
    const first = broker.run(ctx, { agentId: 'worker-1', threadId: 'thread-1', prompt: 'test' });
    await started;
    await expect(broker.run(ctx, { agentId: 'worker-2', threadId: 'thread-2', prompt: 'test' }))
      .rejects.toThrow('WORKER_POOL_FULL');
    release({ threadId: 'thread-1', turnId: 'turn-1', status: 'completed' });
    await first;
    expect(calls).toBe(1);
    expect(broker.running).toBe(0);
  });
});
