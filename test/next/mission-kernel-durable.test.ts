import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDurableStore, resetDurableForTests, readDurableResult } from '../../src/main/durable.js';
import { DurableMissionLeaseStorage, MissionLeaseRegistry, hostBindingKey } from '../../src/main/next/auth/mission-leases.js';
import { DurableMissionStorage, MissionKernel, type LocalAdministrator, type LocalVerifier } from '../../src/main/next/mission/kernel.js';

let root: string;
let projectRoot: string;
const secret = Buffer.alloc(32, 91);
const session = hostBindingKey(secret, 'chatgpt', 'principalA', 'chatA');
const localApprover: LocalAdministrator = {
  approve: async (token, operation) => token === 'admin:' + operation
};
const verifier: LocalVerifier = {
  verifyCompletion: async receipt => receipt === 'local:contract',
  verifyEffect: async (receipt, _mission, _call, digest) => receipt === 'local:effect:' + digest,
  verifyWait: async (receipt, _mission, _wait, digest) => receipt === 'local:wait:' + digest,
  verifyContinuation: async (receipt, _mission, _wait, digest) => receipt === 'local:continuation:' + digest,
  verifyWorkerClaim: async (receipt, _mission, agent) => receipt === 'local:claim:' + agent,
  verifyWorkerReport: async (receipt, _mission, agent, digest) => receipt === 'local:report:' + agent + ':' + digest,
  verifyWorkerReconciliation: async (receipt, _mission, agent, outcome, digest) =>
    receipt === 'local:reconcile:' + agent + ':' + outcome + ':' + digest
};
const authority = {
  authenticate: async (token: unknown) => token === 'verified-internal-connection'
    ? { principalId: 'principalA', namespace: 'chatgpt', hostBindingKey: session } : null,
  confirmApproval: async (approval: unknown, op: 'grant' | 'revoke') => approval === 'operator:' + op
};
const opts = { principalId: 'principalA', namespace: 'chatgpt', hostBindingKey: session,
  missionId: 'm-A', projectId: 'p-A', capabilities: ['read', 'command', 'agents', 'wait', 'stop_self'] as
    ('read' | 'command' | 'agents' | 'wait' | 'stop_self')[], ttlMs: 60_000 };
const caller = (epoch: number) => ({
  inbound: 'verified-internal-connection', missionId: 'm-A', projectId: 'p-A', epoch
});
async function create() {
  const leases = new MissionLeaseRegistry(new DurableMissionLeaseStorage(), authority);
  await leases.restore();
  const journal = new MissionKernel(new DurableMissionStorage(), leases, localApprover, verifier);
  await journal.restore();
  return { leases, journal };
}
beforeEach(async () => {
  resetDurableForTests();
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-next-wp03-integrated-'));
  initDurableStore(root);
  projectRoot = await fs.realpath(await fs.mkdtemp(path.join(root, 'project-')));
});
afterEach(async () => {
  resetDurableForTests();
  await fs.rm(root, { recursive: true, force: true });
});

describe('WP03–05 actual durable Mission + WP02 lease integration', () => {
  it('persists both ledgers independently within an isolated Next-only userData root', async () => {
    const { leases, journal } = await create();
    await journal.provisionProject('p-A', projectRoot, 'admin:project');
    await journal.provisionMission('p-A', 'm-A', ['ci', 'ledger'], 'admin:create');
    await leases.grant({ ...opts, approvalId: 'grant-v1' }, 'operator:grant');
    const accepted = await journal.admitEffect(caller(1), {
      invocationId: 'call-1', idempotencyKey: 'once', capability: 'command', expectedRevision: 1,
      payloadDigest: 'a'.repeat(64)
    });
    expect(accepted.state).toBe('ADMITTED');
    expect(await readDurableResult('next-missions')).toMatchObject({ kind: 'valid' });
    expect(await readDurableResult('next-mission-leases')).toMatchObject({ kind: 'valid' });
    const names = await fs.readdir(path.join(root, 'state'));
    expect(names).toContain('next-missions.json');
    expect(names).toContain('next-mission-leases.json');
    const content = await fs.readFile(path.join(root, 'state', 'next-missions.json'), 'utf8');
    expect(content).not.toContain('chatA');
  });

  it('requires brand-new authenticated WP02 lease and explicit local rebind+resume after restart', async () => {
    const { leases, journal } = await create();
    await journal.provisionProject('p-A', projectRoot, 'admin:project');
    await journal.provisionMission('p-A', 'm-A', ['ci'], 'admin:create');
    await leases.grant({ ...opts, approvalId: 'grant-v1' }, 'operator:grant');
    await journal.delegate(caller(1), 1, 'worker-1', 'a'.repeat(64));
    await journal.claimWorker(caller(1), 'worker-1', 'local:claim:worker-1');
    const next = await create();
    // Old principal metadata is not restored as authority (even for the same session).
    await expect(next.journal.inspect(caller(1))).rejects.toThrow('NOT_AUTHORIZED');
    await next.leases.grant({ ...opts, approvalId: 'grant-v2' }, 'operator:grant');
    await expect(next.journal.rebindMission(caller(2), 3, 'model:true')).rejects.toThrow('RENEWAL_NOT_AUTHORIZED');
    const rebound = await next.journal.rebindMission(caller(2), 3, 'admin:rebind');
    expect(rebound).toMatchObject({ state: 'PAUSED', epoch: 2, revision: 4 });
    const state = await next.journal.inspect(caller(2));
    expect(state.workers[0]?.state).toBe('DELIVERY_UNKNOWN');
    await expect(next.journal.resume(caller(2), 4, 'admin:resume')).rejects.toThrow('UNKNOWN_WORKER_DELIVERY');
    await expect(next.journal.reconcileWorker(caller(2), 'worker-1', 'CANCELLED', 'b'.repeat(64), true))
      .rejects.toThrow('UNTRUSTED_WORKER_RECONCILIATION');
    const reconciled = await next.journal.reconcileWorker(caller(2), 'worker-1', 'FINISHED',
      'b'.repeat(64), 'local:reconcile:worker-1:FINISHED:' + 'b'.repeat(64));
    expect(reconciled.state).toBe('FINISHED');
    expect((await next.journal.resume(caller(2), 5, 'admin:resume')).state).toBe('ACTIVE');
  });

  it('allows safe resume only when no unknown external effects or worker deliveries exist', async () => {
    const { leases, journal } = await create();
    await journal.provisionProject('p-A', projectRoot, 'admin:project');
    await journal.provisionMission('p-A', 'm-A', ['ci'], 'admin:create');
    await leases.grant({ ...opts, approvalId: 'grant-v1' }, 'operator:grant');
    const next = await create();
    await next.leases.grant({ ...opts, approvalId: 'grant-v2' }, 'operator:grant');
    await next.journal.rebindMission(caller(2), 1, 'admin:rebind');
    await expect(next.journal.resume(caller(2), 2, true)).rejects.toThrow('LOCAL_APPROVAL_REQUIRED');
    const started = await next.journal.resume(caller(2), 2, 'admin:resume');
    expect(started).toMatchObject({ state: 'ACTIVE', epoch: 2, revision: 3 });
    await expect(next.journal.inspect(caller(1))).rejects.toThrow('NOT_AUTHORIZED');
    const resumed = await next.journal.admitEffect(caller(2), {
      invocationId: 'call-2', idempotencyKey: 'once-v2', capability: 'command',
      expectedRevision: 3, payloadDigest: 'a'.repeat(64)
    });
    expect(resumed.epoch).toBe(2);
  });

  it('refuses to restore malformed durable mission schema without silently reinitializing it', async () => {
    const file = path.join(root, 'state', 'next-missions.json');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, '{bad json');
    const corrupted = new MissionKernel(new DurableMissionStorage(), {
      authorize: async () => ({ allowed: false as const, reason: 'NOT_BOUND' as const })
    }, localApprover, verifier);
    await corrupted.restore();
    await expect(corrupted.provisionProject('p-A', '/tmp/test', 'admin:project'))
      .rejects.toThrow('STORE_UNAVAILABLE');
  });
});
