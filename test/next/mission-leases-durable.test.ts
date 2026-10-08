import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDurableStore, resetDurableForTests, readDurableResult } from '../../src/main/durable.js';
import {
  DurableMissionLeaseStorage, MissionLeaseRegistry, hostBindingKey,
  type MissionLeaseAuthority
} from '../../src/main/next/auth/mission-leases.js';

let root = '';
const secret = Buffer.alloc(32, 42);
const bindingA = hostBindingKey(secret, 'chatgpt', 'userA', 'chat-A');
const bindingB = hostBindingKey(secret, 'chatgpt', 'userB', 'chat-B');
const authority: MissionLeaseAuthority = {
  authenticate: async token => token === 'authenticated-A'
    ? { principalId: 'userA', namespace: 'chatgpt', hostBindingKey: bindingA }
    : token === 'authenticated-B'
      ? { principalId: 'userB', namespace: 'chatgpt', hostBindingKey: bindingB }
      : null,
  confirmApproval: async (approval, action) => approval === 'operator-confirmed-' + action
};
const grant = (actor: 'A' | 'B' = 'A') => ({
  approvalId: actor === 'A' ? 'approval-A' : 'approval-B',
  principalId: actor === 'A' ? 'userA' : 'userB',
  namespace: 'chatgpt',
  hostBindingKey: actor === 'A' ? bindingA : bindingB,
  missionId: actor === 'A' ? 'mission-A' : 'mission-B',
  projectId: actor === 'A' ? 'project-A' : 'project-B',
  capabilities: ['read', 'command'] as ('read' | 'command')[],
  ttlMs: 30_000
});
const request = (actor: 'A' | 'B' = 'A') => ({
  inbound: actor === 'A' ? 'authenticated-A' : 'authenticated-B',
  missionId: actor === 'A' ? 'mission-A' : 'mission-B',
  projectId: actor === 'A' ? 'project-A' : 'project-B',
  capability: 'command' as const,
  epoch: 1
});

beforeEach(async () => {
  resetDurableForTests();
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-next-mission-lease-'));
  initDurableStore(root);
});
afterEach(async () => {
  resetDurableForTests();
  await fs.rm(root, { recursive: true, force: true });
});

describe('WP02 live durable adapter in isolated temp data', () => {
  it('writes and reads only the next-specific ledger with no raw ChatGPT session IDs', async () => {
    const storage = new DurableMissionLeaseStorage();
    const registry = new MissionLeaseRegistry(storage, authority);
    await registry.restore();
    const lease = await registry.grant(grant(), 'operator-confirmed-grant');
    expect(lease.epoch).toBe(1);
    const diskFile = path.join(root, 'state', 'next-mission-leases.json');
    const json = await fs.readFile(diskFile, 'utf8');
    expect(json).not.toContain('chat-A');
    expect(json).not.toContain('authenticated-A');
    expect(json).toContain(bindingA);
    expect((await readDurableResult('next-mission-leases')).kind).toBe('valid');
  });

  it('never silently authorizes a restored permission after process recreation', async () => {
    const storage = new DurableMissionLeaseStorage();
    const original = new MissionLeaseRegistry(storage, authority);
    await original.restore();
    await original.grant(grant(), 'operator-confirmed-grant');
    expect((await original.authorize(request())).allowed).toBe(true);

    const restarted = new MissionLeaseRegistry(storage, authority);
    await restarted.restore();
    expect(await restarted.authorize(request())).toMatchObject({ allowed: false, reason: 'RECOVERY_LOCKED' });
    await restarted.grant(grant('B'), 'operator-confirmed-grant');
    expect(await restarted.authorize(request())).toMatchObject({ allowed: false, reason: 'NOT_BOUND' });
    expect((await restarted.authorize(request('B'))).allowed).toBe(true);
  });

  it('blocks corrupt primary data and refuses to overwrite corruption with a new approval', async () => {
    await fs.mkdir(path.join(root, 'state'), { recursive: true });
    await fs.writeFile(path.join(root, 'state', 'next-mission-leases.json'), '{garbled', 'utf8');
    const storage = new DurableMissionLeaseStorage();
    const damaged = new MissionLeaseRegistry(storage, authority);
    await damaged.restore();
    expect(await damaged.authorize(request())).toMatchObject({ allowed: false, reason: 'RECOVERY_LOCKED' });
    await expect(damaged.grant(grant(), 'operator-confirmed-grant')).rejects.toThrow('STORE_UNAVAILABLE');
    expect(await fs.readFile(path.join(root, 'state', 'next-mission-leases.json'), 'utf8')).toEqual('{garbled');
  });

  it('rejects syntactically valid but weakened persisted schema, missing epochs and invalid leases', async () => {
    const storage = new DurableMissionLeaseStorage();
    const file = path.join(root, 'state', 'next-mission-leases.json');
    await fs.mkdir(path.dirname(file), { recursive: true });
    const invalid = [
      { version: 2, missionEpochs: {}, leases: [] },
      { version: 1, missionEpochs: { '../invalid': 1 }, leases: [] },
      { version: 1, missionEpochs: {}, leases: [{ leaseId: 'fake', missionId: 'mission-A', epoch: 1 }] },
      { version: 1, missionEpochs: { 'mission-A': 0 }, leases: [] }
    ];
    for (const snapshot of invalid) {
      await fs.writeFile(file, JSON.stringify(snapshot), 'utf8');
      const r = new MissionLeaseRegistry(storage, authority);
      await r.restore();
      expect(await r.authorize(request())).toMatchObject({ allowed: false, reason: 'RECOVERY_LOCKED' });
      await expect(r.grant(grant(), 'operator-confirmed-grant')).rejects.toThrow('STORE_UNAVAILABLE');
      expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual(snapshot);
    }
  });

  it('requires an initialized, isolated store before it can grant any authority', async () => {
    resetDurableForTests();
    const storage = new DurableMissionLeaseStorage();
    const r = new MissionLeaseRegistry(storage, authority);
    await r.restore();
    expect(await r.authorize(request())).toMatchObject({ allowed: false, reason: 'RECOVERY_LOCKED' });
    await expect(r.grant(grant(), 'operator-confirmed-grant')).rejects.toThrow('STORE_UNAVAILABLE');
  });

  it('records revoke and epoch fencing durably but requires explicit reapproval on next start', async () => {
    const storage = new DurableMissionLeaseStorage();
    const r = new MissionLeaseRegistry(storage, authority);
    await r.restore();
    await r.grant(grant(), 'operator-confirmed-grant');
    await r.revoke('mission-A', 'operator-confirmed-revoke', 'revoke-A');
    expect((await r.authorize(request())).allowed).toBe(false);
    const json = JSON.parse(await fs.readFile(path.join(root, 'state', 'next-mission-leases.json'), 'utf8'));
    expect(json.missionEpochs['mission-A']).toBe(2);
    expect(json.leases[0].revokedAt).not.toBeNull();
    const restarted = new MissionLeaseRegistry(storage, authority);
    await restarted.restore();
    expect((await restarted.authorize(request())).allowed).toBe(false);
  });
});
