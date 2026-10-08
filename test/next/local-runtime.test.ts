import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { resetDurableForTests } from '../../src/main/durable.js';
import { NextLocalRuntime } from '../../src/main/next/runtime/local-runtime.js';
import type { MissionLeaseAuthority } from '../../src/main/next/auth/mission-leases.js';
import type { LocalAdministrator, LocalVerifier } from '../../src/main/next/mission/kernel.js';

let base: string;
let userData: string;
const authority: MissionLeaseAuthority = {
  authenticate: async () => null, // No trusted ChatGPT identity in offline mode
  confirmApproval: async (ticket, action) => ticket === 'local-operator-' + action
};
const admin: LocalAdministrator = {
  approve: async (ticket, action) => ticket === 'local-admin-' + action
};
const verifier: LocalVerifier = {
  verifyEffect: async () => false,
  verifyWait: async () => false,
  verifyContinuation: async () => false,
  verifyCompletion: async () => false,
  verifyWorkerClaim: async () => false,
  verifyWorkerReport: async () => false,
  verifyWorkerReconciliation: async () => false
};
const build = () => new NextLocalRuntime({ userData, testHome: path.dirname(userData), authority, admin, verifier });

beforeEach(async () => {
  resetDurableForTests();
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-next-offline-'));
  const home = path.join(base, 'home');
  await fs.mkdir(home);
  userData = path.join(home, 'next-local-root');
});
afterEach(async () => {
  resetDurableForTests();
  await fs.rm(base, { recursive: true, force: true });
});

describe('Next local-only Runtime without browser plugin or Tunnel', () => {
  it('boots independent isolated durable storage and exposes no remote inference', async () => {
    const runtime = build();
    expect(runtime.health.state).toBe('OFF');
    await runtime.start();
    expect(runtime.health).toMatchObject({
      state: 'READY', leases: 'ready', mission: 'READY',
      connector: 'NOT_STARTED', model: 'NOT_STARTED'
    });
    await runtime.mission.provisionProject('test-project', await fs.realpath(userData), 'local-admin-project');
    await runtime.mission.provisionMission('test-project', 'test-mission', ['ci'], 'local-admin-create');
    expect((await fs.readdir(path.join(userData, 'state')))).toContain('next-missions.json');
    await runtime.stop();
    expect(runtime.health.state).toBe('STOPPED');
    await expect(fs.stat(path.join(userData, '.next-writer'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a competing second runtime writer while first owner is alive', async () => {
    const runtime = build();
    await runtime.start();
    // Must not let second call rewrite the process-wide durable root.
    const concurrent = build();
    await expect(concurrent.start()).rejects.toThrow('NEXT_STARTUP_FAILED');
    expect(concurrent.health.state).toBe('HOLD');
    expect(runtime.health.state).toBe('READY');
    await runtime.stop();
    await concurrent.stop();
  });

  it('locks all old model authority after restart until fresh lease is approved', async () => {
    const runtime = build();
    await runtime.start();
    await runtime.mission.provisionProject('test-project', await fs.realpath(userData), 'local-admin-project');
    await runtime.mission.provisionMission('test-project', 'test-mission', ['ci'], 'local-admin-create');
    await runtime.stop();
    resetDurableForTests();
    const restarted = build();
    await restarted.start();
    expect(restarted.health.state).toBe('READY');
    expect(restarted.health.connector).toBe('NOT_STARTED');
    // No "openai/session" metadata can pass the unauthenticated test-only authority.
    await expect(restarted.mission.inspect({
      inbound: { 'openai/session': 'old-web-chat' }, missionId: 'test-mission', projectId: 'test-project', epoch: 1
    })).rejects.toThrow('NOT_AUTHORIZED');
    await restarted.stop();
  });

  it('refuses previously corrupt persisted Mission data, preserving evidence', async () => {
    await fs.mkdir(path.join(userData, 'state'), { recursive: true });
    await fs.writeFile(path.join(userData, 'state', 'next-missions.json'), '{corrupt');
    const runtime = build();
    await runtime.start();
    expect(runtime.health.state).toBe('HOLD');
    expect(() => runtime.mission).toThrow('NEXT_RUNTIME_NOT_AUTHORIZED');
    await runtime.stop();
    expect(await fs.readFile(path.join(userData, 'state', 'next-missions.json'), 'utf8')).toBe('{corrupt');
  });

  it('does not start twice or allow the mission kernel after shutdown', async () => {
    const runtime = build();
    await runtime.start();
    await expect(runtime.start()).rejects.toThrow('NEXT_RUNTIME_ALREADY_STARTED');
    await runtime.stop();
    expect(() => runtime.mission).toThrow('NEXT_RUNTIME_NOT_AUTHORIZED');
  });
});
