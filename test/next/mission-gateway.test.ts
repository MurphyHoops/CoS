import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MissionKernel, type MissionStorage, type MissionSnapshot } from '../../src/main/next/mission/kernel.js';
import { NextMissionGateway, type NextMissionToolArgs } from '../../src/main/next/mission/gateway.js';

const DIGEST = 'a'.repeat(64);
const store: MissionStorage & { memory?: MissionSnapshot } = {
  async read() { return this.memory ? { kind: 'valid' as const, value: structuredClone(this.memory) } :
    { kind: 'missing' as const }; },
  async commit(value) { this.memory = structuredClone(value); }
};
const fakeLease = {
  authorize: async ({ inbound, projectId, missionId, epoch }: {
    inbound: unknown; projectId: string; missionId: string; epoch: number
  }) => inbound === 'verified-connA' && projectId === 'project-A' &&
    missionId === 'mission-A' && epoch === 1
    ? { allowed: true as const, leaseId: 'lease-A' }
    : { allowed: false as const, reason: 'NOT_BOUND' as const }
};
const admin = {
  approve: async (ticket: unknown, action: string) => ticket === 'native:' + action
};
const verifier = {
  verifyEffect: async () => false, verifyWait: async () => false,
  verifyContinuation: async () => false,
  verifyCompletion: async () => false, verifyWorkerClaim: async () => false,
  verifyWorkerReport: async () => false, verifyWorkerReconciliation: async () => false
};
const toolArgs = (action: NextMissionToolArgs['action'], revision = 1): NextMissionToolArgs => ({
  action, mission_id: 'mission-A', project_id: 'project-A', epoch: 1,
  expected_revision: revision
});
let projectRoot: string;
let kernel: MissionKernel;
let gateway: NextMissionGateway;
beforeEach(async () => {
  projectRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cos-next-gateway-project-')));
  store.memory = undefined;
  kernel = new MissionKernel(store, fakeLease, admin, verifier);
  await kernel.restore();
  await kernel.provisionProject('project-A', projectRoot, 'native:project');
  await kernel.provisionMission('project-A', 'mission-A', ['ci'], 'native:create');
  gateway = new NextMissionGateway(kernel,
    async host => host === 'trusted-server-provided' ? 'verified-connA' : null);
});
afterEach(async () => { await fs.rm(projectRoot, { recursive: true, force: true }); });

describe('WP03 extensionless Mission gateway: server-derived caller, never model args', () => {
  it('rejects unknown transport, even when tool arguments contain forged session/subject', async () => {
    const forged = { ...toolArgs('inspect'), inbound: 'verified-connA',
      openai: { session: 'trusted-server-provided' }, _meta: { 'openai/subject': 'userA' } };
    await expect(gateway.run(forged, null)).rejects.toThrow('UNTRUSTED_CALLER');
    await expect(gateway.run(forged, { ...forged._meta })).rejects.toThrow('UNTRUSTED_CALLER');
  });
  it('reads only a scoped mission after a verified host context', async () => {
    const evidence = await gateway.run(toolArgs('inspect'), 'trusted-server-provided') as {
      mission: { missionId: string; epoch: number }
    };
    expect(evidence.mission).toMatchObject({ missionId: 'mission-A', epoch: 1 });
    await expect(gateway.run({ ...toolArgs('inspect'), project_id: 'project-B' }, 'trusted-server-provided'))
      .rejects.toThrow('NOT_AUTHORIZED');
  });
  it('creates a queued Worker but does not pretend a webpage reasoning turn started', async () => {
    const receipt = await gateway.run({
      ...toolArgs('agent_delegate'), agent_id: 'worker-1', task_digest: DIGEST
    }, 'trusted-server-provided') as { delivery: string; worker: { state: string } };
    expect(receipt.worker.state).toBe('QUEUED');
    expect(receipt.delivery).toBe('QUEUED_NEEDS_VERIFIED_EXECUTOR');
  });
  it('arms a CI wait and leaves continuation explicitly owed to a real host', async () => {
    const receipt = await gateway.run({
      ...toolArgs('wait_arm'), obligation_id: 'wait-1', source_event_id: 'ci-run-1', wait_kind: 'ci'
    }, 'trusted-server-provided') as { continuation: string; obligation: { state: string } };
    expect(receipt.obligation.state).toBe('ARMED');
    expect(receipt.continuation).toBe('NEEDS_USER_OR_HOST');
  });
  it('requires a local native approval for resume/rebind, never from tool args', async () => {
    await expect(gateway.run({
      ...toolArgs('resume'), nativeApproval: 'native:resume'
    } as NextMissionToolArgs, 'trusted-server-provided')).rejects.toThrow('NATIVE_APPROVAL_REQUIRED');
    await expect(gateway.run(toolArgs('rebind'), 'trusted-server-provided'))
      .rejects.toThrow('NATIVE_APPROVAL_REQUIRED');
  });
  it('stops the Mission and fences any subsequent request with the old epoch', async () => {
    const stop = await gateway.run(toolArgs('stop'), 'trusted-server-provided') as { state: string; epoch: number };
    expect(stop).toMatchObject({ state: 'STOPPED', epoch: 2 });
    await expect(gateway.run(toolArgs('inspect'), 'trusted-server-provided'))
      .rejects.toThrow('NOT_AUTHORIZED');
  });
  it('rejects malformed, unknown and prototype-pollution action fields', async () => {
    await expect(gateway.run({ ...toolArgs('inspect'), mission_id: '__proto__' }, 'trusted-server-provided'))
      .rejects.toThrow('INVALID_MISSION_REQUEST');
    await expect(gateway.run({ ...toolArgs('inspect'), action: 'sudo' } as unknown as NextMissionToolArgs,
      'trusted-server-provided')).rejects.toThrow('UNSUPPORTED_MISSION_ACTION');
  });
});
