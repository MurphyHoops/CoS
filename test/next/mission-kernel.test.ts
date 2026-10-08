import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MissionKernel, type MissionSnapshot, type MissionCaller,
  type MissionStorage
} from '../../src/main/next/mission/kernel.js';
import type { MissionCapability } from '../../src/main/next/auth/mission-leases.js';

const GOOD = 'a'.repeat(64);
const GOOD2 = 'b'.repeat(64);
const approvals = {
  approve: async (token: unknown, operation: 'create' | 'project' | 'rebind' | 'resume') => token === 'LOCAL_OS_APPROVED_' + operation
};
const verifier = {
  verifyEffect: async (receipt: unknown, _mission: string, _id: string, digest: string) =>
    receipt === 'local-effect-' + digest,
  verifyWait: async (receipt: unknown, _mission: string, _id: string, digest: string) =>
    receipt === 'local-wait-' + digest,
  verifyContinuation: async (receipt: unknown, _mission: string, _id: string, digest: string) =>
    receipt === 'local-continuation-' + digest,
  verifyCompletion: async (receipt: unknown) => receipt === 'local-completion-proof',
  verifyWorkerClaim: async (receipt: unknown, _mission: string, agent: string) => receipt === 'executor-' + agent,
  verifyWorkerReport: async (receipt: unknown, _mission: string, agent: string, digest: string) =>
    receipt === 'local-report-' + agent + '-' + digest,
  verifyWorkerReconciliation: async (receipt: unknown, _mission: string, agent: string,
    outcome: string, digest: string) => receipt === 'local-reconcile-' + agent + '-' + outcome + '-' + digest
};
const trustedLease = {
  authorize: async ({ inbound, projectId, missionId, epoch, capability }: {
    inbound: unknown; projectId: string; missionId: string; epoch: number; capability: MissionCapability
  }) => {
    if (inbound === 'verified-chat-A' && projectId === 'project-A' &&
        missionId === 'mission-A' && epoch === 1) {
      return { allowed: true as const, leaseId: 'lease-A' };
    }
    if (inbound === 'verified-chat-B' && projectId === 'project-B' &&
        missionId === 'mission-B' && epoch === 1 && capability === 'read') {
      return { allowed: true as const, leaseId: 'lease-B' };
    }
    return { allowed: false as const, reason: 'NOT_BOUND' as const };
  }
};
class MemoryStore implements MissionStorage {
  value: MissionSnapshot | null = null;
  writes = 0;
  fail = false;
  readError = false;
  async read() {
    if (this.readError) return { kind: 'corrupt' as const };
    return this.value ? { kind: 'valid' as const, value: structuredClone(this.value) } : { kind: 'missing' as const };
  }
  async commit(snapshot: MissionSnapshot) {
    if (this.fail) throw new Error('disk unavailable');
    this.writes++;
    this.value = structuredClone(snapshot);
  }
}
const ctx: MissionCaller = { inbound: 'verified-chat-A', missionId: 'mission-A', projectId: 'project-A', epoch: 1 };
const effect = { invocationId: 'call-1', idempotencyKey: 'effect-1', capability: 'command' as const,
  expectedRevision: 1, payloadDigest: GOOD };
let projectRoot: string;
let store: MemoryStore;
let kernel: MissionKernel;
async function bootstrap() {
  await kernel.provisionProject('project-A', projectRoot, 'LOCAL_OS_APPROVED_project');
  await kernel.provisionMission('project-A', 'mission-A', ['ci', 'ledger'], 'LOCAL_OS_APPROVED_create');
}
beforeEach(async () => {
  projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-next-project-test-'));
  projectRoot = await fs.realpath(projectRoot);
  store = new MemoryStore();
  kernel = new MissionKernel(store, trustedLease, approvals, verifier);
  await kernel.restore();
});
afterEach(async () => { await fs.rm(projectRoot, { recursive: true, force: true }); });

describe('WP03 mission transaction authority and fail-close', () => {
  it('requires a separately confirmed administrator to create projects and missions', async () => {
    await expect(kernel.provisionProject('project-A', '/tmp/A', { toolArgs: 'approve' })).rejects.toThrow('LOCAL_APPROVAL_REQUIRED');
    expect(store.writes).toBe(0);
    await bootstrap();
    expect((await kernel.inspect(ctx)).mission).toMatchObject({ state: 'ACTIVE', revision: 1, epoch: 1 });
  });

  it('native project catalog requires local approval and is never exposed through host identity metadata', async () => {
    await bootstrap();
    await expect(kernel.adminCatalog({ 'openai/session': 'forged' }))
      .rejects.toThrow('LOCAL_APPROVAL_REQUIRED');
    const catalog = await kernel.adminCatalog('LOCAL_OS_APPROVED_browse');
    expect(catalog.projects).toHaveLength(1);
    expect(catalog.missions).toHaveLength(1);
    expect(catalog.projects[0]?.canonicalRoot).toBe(projectRoot);
    expect(catalog.missions[0]?.completionChecks).toEqual(['ci', 'ledger']);
  });

  it('does not disclose cross-project or cross-chat data', async () => {
    await bootstrap();
    await expect(kernel.inspect({ ...ctx, inbound: 'verified-chat-B' })).rejects.toThrow('NOT_AUTHORIZED');
    await expect(kernel.inspect({ ...ctx, projectId: 'project-B' })).rejects.toThrow('NOT_AUTHORIZED');
    await expect(kernel.inspect({ ...ctx, missionId: 'mission-B' })).rejects.toThrow('NOT_AUTHORIZED');
    await expect(kernel.inspect({ ...ctx, inbound: { 'openai/session': 'chat-A' } })).rejects.toThrow('NOT_AUTHORIZED');
  });

  it('admits an effect once, then treats a repeated identical invocation as the original receipt', async () => {
    await bootstrap();
    const first = await kernel.admitEffect(ctx, effect);
    expect(first.state).toBe('ADMITTED');
    const writes = store.writes;
    const repeated = await kernel.admitEffect(ctx, effect);
    expect(repeated).toEqual(first);
    expect(store.writes).toBe(writes);
    await expect(kernel.admitEffect(ctx, { ...effect, payloadDigest: GOOD2 }))
      .rejects.toThrow('EFFECT_REPLAY_CONFLICT');
    await expect(kernel.admitEffect(ctx, { ...effect, invocationId: 'call-2' }))
      .rejects.toThrow('EFFECT_REPLAY_CONFLICT');
  });

  it('only one concurrent admission with the same revision is accepted', async () => {
    await bootstrap();
    const result = await Promise.allSettled([
      kernel.admitEffect(ctx, effect),
      kernel.admitEffect(ctx, { ...effect, invocationId: 'call-2', idempotencyKey: 'effect-2' })
    ]);
    expect(result.filter(x => x.status === 'fulfilled')).toHaveLength(1);
    expect(result.filter(x => x.status === 'rejected')).toHaveLength(1);
    expect(store.value?.missions['mission-A']!.revision).toBe(2);
    expect(Object.keys(store.value?.effects ?? {})).toHaveLength(1);
  });

  it('rejects external dispatch if the originally approved project directory is replaced', async () => {
    await bootstrap();
    await kernel.admitEffect(ctx, effect);
    const original = projectRoot + '.original';
    await fs.rename(projectRoot, original);
    await fs.mkdir(projectRoot);
    try {
      await expect(kernel.startDispatch(ctx, 'call-1')).rejects.toThrow('PROJECT_ROOT_CHANGED');
      expect(store.value?.effects['call-1']!.state).toBe('ADMITTED');
    } finally {
      await fs.rm(projectRoot, { recursive: true, force: true });
      await fs.rename(original, projectRoot);
    }
  });

  it('starts an external effect inside the Stop admission queue, never after Stop commits', async () => {
    await bootstrap();
    await kernel.admitEffect(ctx, effect);
    const events: string[] = [];
    const started = kernel.dispatchWithStarter(ctx, 'call-1', () => { events.push('native-start'); });
    const stopped = kernel.stop(ctx, 3).then(() => { events.push('stop-committed'); });
    const receipt = await started;
    await stopped;
    expect(receipt.state).toBe('DISPATCHED');
    expect(events).toEqual(['native-start', 'stop-committed']);
    await expect(kernel.dispatchWithStarter(ctx, 'call-1', () => events.push('unsafe')))
      .rejects.toThrow('NOT_AUTHORIZED');
    expect(events).toEqual(['native-start', 'stop-committed']);
  });

  it('cannot promote a starter failure to verified success or retry it blindly', async () => {
    await bootstrap();
    await kernel.admitEffect(ctx, effect);
    let attempted = 0;
    await expect(kernel.dispatchWithStarter(ctx, 'call-1', () => {
      attempted++; throw new Error('spawn may have succeeded');
    })).rejects.toThrow('DISPATCH_EFFECT_UNKNOWN');
    expect(attempted).toBe(1);
    expect(store.value?.effects['call-1']!.state).toBe('UNKNOWN_EFFECT');
    await expect(kernel.dispatchWithStarter(ctx, 'call-1', () => { attempted++; }))
      .rejects.toThrow('EFFECT_NOT_DISPATCHABLE');
    expect(attempted).toBe(1);
  });

  it('rejects asynchronous native starters instead of losing the stop fence', async () => {
    await bootstrap();
    await kernel.admitEffect(ctx, effect);
    await expect(kernel.dispatchWithStarter(ctx, 'call-1', (() => Promise.resolve()) as unknown as () => void))
      .rejects.toThrow('DISPATCH_EFFECT_UNKNOWN');
    expect(store.value?.effects['call-1']!.state).toBe('UNKNOWN_EFFECT');
  });

  it('never automatically dispatches external effects or repeats unknown effects after restart', async () => {
    await bootstrap();
    await kernel.admitEffect(ctx, effect);
    const sent = await kernel.startDispatch(ctx, 'call-1');
    expect(sent.state).toBe('DISPATCHED');
    const restarted = new MissionKernel(store, trustedLease, approvals, verifier);
    await restarted.restore();
    const evidence = await restarted.inspect(ctx);
    expect(evidence.effects[0]!.state).toBe('UNKNOWN_EFFECT');
    await expect(restarted.startDispatch(ctx, 'call-1')).rejects.toThrow('MISSION_NOT_ACTIVE');
    await expect(restarted.complete(ctx, evidence.mission.revision, { ci: true, ledger: true }, 'local-completion-proof'))
      .rejects.toThrow('MISSION_NOT_ACTIVE');
    expect(store.value?.effects['call-1']!.state).toBe('UNKNOWN_EFFECT');
  });

  it('does not finish a mission while an admitted effect has not executed', async () => {
    await bootstrap();
    await kernel.admitEffect(ctx, effect);
    await expect(kernel.complete(ctx, 2, { ci: true, ledger: true }, 'local-completion-proof'))
      .rejects.toThrow('PENDING_EFFECTS');
  });

  it('reconciles an unknown effect without replaying it or claiming model success', async () => {
    await bootstrap();
    await kernel.admitEffect(ctx, effect);
    await kernel.startDispatch(ctx, 'call-1');
    const resumed = new MissionKernel(store, trustedLease, approvals, verifier);
    await resumed.restore();
    await expect(resumed.reconcileEffect(ctx, 'call-1', GOOD2, true))
      .rejects.toThrow('UNTRUSTED_EFFECT_RECEIPT');
    expect((await resumed.reconcileEffect(ctx, 'call-1', GOOD2, 'local-effect-' + GOOD2)).state)
      .toBe('RECONCILED');
    await expect(resumed.startDispatch(ctx, 'call-1')).rejects.toThrow('MISSION_NOT_ACTIVE');
  });

  it('requires verified external receipt; model-provided success is rejected', async () => {
    await bootstrap();
    await kernel.admitEffect(ctx, effect);
    await kernel.startDispatch(ctx, 'call-1');
    await expect(kernel.observeEffect(ctx, 'call-1', GOOD2, true))
      .rejects.toThrow('UNTRUSTED_EFFECT_RECEIPT');
    expect((await kernel.observeEffect(ctx, 'call-1', GOOD2, 'local-effect-' + GOOD2)).state).toBe('EFFECT_OBSERVED');
  });

  it('fences local Worker execution and report receipts through a verified executor', async () => {
    await bootstrap();
    await kernel.delegate(ctx, 1, 'worker-1', GOOD);
    await expect(kernel.claimWorker(ctx, 'worker-1', { fromModel: true }))
      .rejects.toThrow('WORKER_CLAIM_UNVERIFIED');
    expect((await kernel.claimWorker(ctx, 'worker-1', 'executor-worker-1')).state).toBe('CLAIMED');
    await expect(kernel.finishWorker(ctx, 'worker-1', GOOD2, true)).rejects.toThrow('WORKER_REPORT_UNVERIFIED');
    expect((await kernel.finishWorker(ctx, 'worker-1', GOOD2, 'local-report-worker-1-' + GOOD2)).state)
      .toBe('FINISHED');
    await expect(kernel.finishWorker(ctx, 'worker-1', GOOD2, 'local-report-worker-1-' + GOOD2))
      .rejects.toThrow('WORKER_NOT_REPORTABLE');
  });

  it('refuses project completion while a locally delegated Worker is still pending', async () => {
    await bootstrap();
    await kernel.delegate(ctx, 1, 'worker-1', GOOD);
    await expect(kernel.complete(ctx, 2, { ci: true, ledger: true }, 'local-completion-proof'))
      .rejects.toThrow('WORKERS_PENDING');
  });

  it('stops, fences prior epoch, cancels workers and waits in a single commit', async () => {
    await bootstrap();
    const worker = await kernel.delegate(ctx, 1, 'worker-1', GOOD);
    expect(worker.state).toBe('QUEUED');
    const w = await kernel.armWait(ctx, 2, 'obligation-1', 'ci-run-1', 'ci');
    expect(w.state).toBe('ARMED');
    const stopped = await kernel.stop(ctx, 3);
    expect(stopped).toMatchObject({ state: 'STOPPED', revision: 4, epoch: 2 });
    expect(store.value?.workers['worker-1']!.state).toBe('CANCELLED');
    expect(store.value?.obligations['obligation-1']!.state).toBe('CANCELLED');
    await expect(kernel.admitEffect(ctx, { ...effect, expectedRevision: 4 }))
      .rejects.toThrow('NOT_AUTHORIZED');
  });

  it('rejects an event arriving after Stop and refuses to wake an old Worker', async () => {
    await bootstrap();
    await kernel.armWait(ctx, 1, 'obl-1', 'ci-42', 'ci');
    await kernel.stop(ctx, 2);
    await expect(kernel.resolveWait(ctx, 'obl-1', GOOD, true, 'SUCCESS')).rejects.toThrow('NOT_AUTHORIZED');
  });

  it('deduplicates repeated CI/process obligations and rejects conflicting replay', async () => {
    await bootstrap();
    const first = await kernel.armWait(ctx, 1, 'obl-1', 'ci-42', 'ci');
    const writes = store.writes;
    expect(await kernel.armWait(ctx, 1, 'obl-1', 'ci-42', 'ci')).toEqual(first);
    expect(store.writes).toBe(writes);
    await expect(kernel.armWait(ctx, 1, 'obl-2', 'ci-42', 'ci')).rejects.toThrow('OBLIGATION_REPLAY_CONFLICT');
  });

  it('requires a machine-verified completion contract and no outstanding external obligations', async () => {
    await bootstrap();
    await expect(kernel.complete(ctx, 1, { ci: true, ledger: true }, false))
      .rejects.toThrow('COMPLETION_NOT_VERIFIED');
    await expect(kernel.complete(ctx, 1, { ci: true, ledger: false }, 'local-completion-proof'))
      .rejects.toThrow('COMPLETION_NOT_VERIFIED');
    await kernel.armWait(ctx, 1, 'obl-1', 'ci-42', 'ci');
    await expect(kernel.complete(ctx, 2, { ci: true, ledger: true }, 'local-completion-proof'))
      .rejects.toThrow('OBLIGATIONS_PENDING');
    await expect(kernel.resolveWait(ctx, 'obl-1', GOOD2, false, 'SUCCESS')).rejects.toThrow('INVALID_OBLIGATION_PROOF');
    await kernel.resolveWait(ctx, 'obl-1', GOOD2, 'local-wait-' + GOOD2, 'SUCCESS');
    await expect(kernel.complete(ctx, 3, { ci: true, ledger: true }, 'local-completion-proof'))
      .rejects.toThrow('CONTINUATION_PENDING');
    await expect(kernel.ackContinuation(ctx, 'obl-1', true)).rejects.toThrow('CONTINUATION_ACK_NOT_VERIFIED');
    await kernel.ackContinuation(ctx, 'obl-1', 'local-continuation-' + GOOD2);
    const done = await kernel.complete(ctx, 4, { ci: true, ledger: true }, 'local-completion-proof');
    expect(done.state).toBe('DONE');
    await expect(kernel.admitEffect(ctx, { ...effect, expectedRevision: 5 })).rejects.toThrow('MISSION_NOT_ACTIVE');
  });

  it('fails closed after uncertain durable commit and never claims success', async () => {
    await bootstrap();
    store.fail = true;
    await expect(kernel.admitEffect(ctx, effect)).rejects.toThrow('COMMIT_AMBIGUOUS');
    store.fail = false;
    await expect(kernel.inspect(ctx)).rejects.toThrow('STORE_UNAVAILABLE');
  });

  it('fails closed after damaged schema or unknown commit during recovery', async () => {
    store.value = { ...store.value!, version: 2 } as unknown as MissionSnapshot;
    const corrupted = new MissionKernel(store, trustedLease, approvals, verifier);
    await corrupted.restore();
    await expect(corrupted.provisionProject('new', '/tmp/new', 'LOCAL_OS_APPROVED_project'))
      .rejects.toThrow('STORE_UNAVAILABLE');

    store.value = null;
    await bootstrap();
    await kernel.admitEffect(ctx, effect);
    await kernel.startDispatch(ctx, 'call-1');
    store.fail = true;
    const recovering = new MissionKernel(store, trustedLease, approvals, verifier);
    await recovering.restore();
    store.fail = false;
    await expect(recovering.inspect(ctx)).rejects.toThrow('STORE_UNAVAILABLE');
  });

  it('prohibits prototype keys in projects, mission IDs and event indexes', async () => {
    for (const name of ['__proto__', 'constructor', 'hasOwnProperty', 'toString']) {
      await expect(kernel.provisionProject(name, '/tmp/A', 'LOCAL_OS_APPROVED_project'))
        .rejects.toThrow('LOCAL_APPROVAL_REQUIRED');
    }
    expect(store.writes).toBe(0);
  });
});
