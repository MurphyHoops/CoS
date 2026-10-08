import { beforeEach, describe, expect, it } from 'vitest';
import { MissionKernel, type MissionSnapshot, type MissionStorage } from '../../src/main/next/mission/kernel.js';
import { NativeWorkerEvidence, NextWorkerBroker } from '../../src/main/next/model/worker-broker.js';
import { NativeWaitEvidence, NextExternalWaitSupervisor } from '../../src/main/next/wait/external-wait.js';
const ctx = { inbound: 'trusted-local', missionId: 'm-A', projectId: 'p-A', epoch: 1 };
let kernel: MissionKernel;
let workerEvidence: NativeWorkerEvidence;
let waitEvidence: NativeWaitEvidence;
let modelCalls: number;
let state: MissionSnapshot | undefined;
const store: MissionStorage = {
  async read() { return state ? { kind: 'valid', value: structuredClone(state) } : { kind: 'missing' }; },
  async commit(value) { state = structuredClone(value); }
};
beforeEach(async () => {
  state = undefined; modelCalls = 0;
  workerEvidence = new NativeWorkerEvidence();
  waitEvidence = new NativeWaitEvidence();
  kernel = new MissionKernel(store, {
    authorize: async ({ inbound }) => inbound === 'trusted-local'
      ? { allowed: true as const, leaseId: 'trusted' } :
      { allowed: false as const, reason: 'NOT_BOUND' as const }
  }, { approve: async () => true }, {
    verifyEffect: async () => false, verifyCompletion: async () => false,
    verifyWait: (r, m, o, hash) => waitEvidence.verifyWait(r, m, o, hash),
    verifyContinuation: (r, m, o, hash) => waitEvidence.verifyContinuation(r, m, o, hash),
    verifyWorkerClaim: (r, m, w, epoch) => workerEvidence.verifyWorkerClaim(r, m, w, epoch),
    verifyWorkerReport: (r, m, w, hash) => workerEvidence.verifyWorkerReport(r, m, w, hash),
    verifyWorkerReconciliation: (r, m, w, outcome, hash) =>
      workerEvidence.verifyWorkerReconciliation(r, m, w, outcome, hash)
  });
  await kernel.restore();
  await kernel.provisionProject('p-A', process.cwd(), true);
  await kernel.provisionMission('p-A', 'm-A', ['ci'], true);
  await kernel.armWait(ctx, 1, 'wait-1', 'ghrun:999', 'ci');
  const supervisor = new NextExternalWaitSupervisor(kernel, waitEvidence, async () => ({
    state: 'COMPLETE', result: 'SUCCESS', externalRecord: {
      runId: 999, conclusion: 'success', sha: 'a'.repeat(40)
    }
  }));
  expect(await supervisor.tick(ctx, 'wait-1')).toBe('CONTINUATION_OWED');
  await kernel.delegate(ctx, 3, 'worker-1', 'a'.repeat(64));
});
describe('WP04/05 GitHub CI -> durable continuation owed -> local Codex Worker receipt', () => {
  it('only an observed, completed local model turn ACKs an existing external wait', async () => {
    const broker = new NextWorkerBroker(kernel, workerEvidence, {
      async runTurn(threadId) { modelCalls++; return { threadId, turnId: 'local-turn-1', status: 'completed' }; }
    }, () => true, 4, waitEvidence);
    const result = await broker.run(ctx, {
      agentId: 'worker-1', threadId: 'local-thread-1', prompt: 'Continue verified CI task',
      continuationObligationId: 'wait-1'
    });
    expect(result.status).toBe('FINISHED');
    expect(modelCalls).toBe(1);
    const snapshot = await kernel.inspect(ctx);
    expect(snapshot.workers[0]?.state).toBe('FINISHED');
    expect(snapshot.obligations[0]?.continuation).toBe('ACKED');
    await expect(broker.run(ctx, {
      agentId: 'worker-1', threadId: 'local-thread-1', prompt: 'Duplicate',
      continuationObligationId: 'wait-1'
    })).rejects.toThrow('CONTINUATION_NOT_OWED');
    expect(modelCalls).toBe(1);
  });
  it('failed or interrupted model response leaves the external continuation owed', async () => {
    const broker = new NextWorkerBroker(kernel, workerEvidence, {
      async runTurn(threadId) { modelCalls++; return { threadId, turnId: 'turn-1', status: 'failed' }; }
    }, () => true, 4, waitEvidence);
    expect((await broker.run(ctx, {
      agentId: 'worker-1', threadId: 'local-thread-1',
      prompt: 'Continue', continuationObligationId: 'wait-1'
    })).status).toBe('HOLD');
    expect((await kernel.inspect(ctx)).obligations[0]?.continuation).toBe('OWED');
    expect(modelCalls).toBe(1);
  });
  it('does not start any inference for a missing or mismatched continuation obligation', async () => {
    const broker = new NextWorkerBroker(kernel, workerEvidence, {
      async runTurn(threadId) { modelCalls++; return { threadId, turnId: 'turn-1', status: 'completed' }; }
    }, () => true, 4, waitEvidence);
    await expect(broker.run(ctx, {
      agentId: 'worker-1', threadId: 'local-thread-1',
      prompt: 'Forged source', continuationObligationId: 'other'
    })).rejects.toThrow('CONTINUATION_NOT_OWED');
    expect(modelCalls).toBe(0);
    expect((await kernel.inspect(ctx)).workers[0]?.state).toBe('QUEUED');
  });
});
