import { beforeEach, describe, expect, it } from 'vitest';
import {
  hostBindingKey, MissionLeaseRegistry,
  type LeaseStorage, type LeaseSnapshot, type MissionLeaseAuthority,
  type VerifiedPrincipal, type MissionCapability
} from '../../src/main/next/auth/mission-leases.js';

const SECRET = Buffer.alloc(32, 17);
const bindingA = hostBindingKey(SECRET, 'chatgpt', 'userA', 'chat-A');
const bindingB = hostBindingKey(SECRET, 'chatgpt', 'userA', 'chat-B');
const bindingOther = hostBindingKey(SECRET, 'chatgpt', 'userB', 'chat-A');

type ActorToken = 'A' | 'B' | 'OTHER' | 'BAD' | 'ALIAS';
const ACTORS: Partial<Record<ActorToken, VerifiedPrincipal>> = {
  A: { principalId: 'userA', namespace: 'chatgpt', hostBindingKey: bindingA },
  B: { principalId: 'userA', namespace: 'chatgpt', hostBindingKey: bindingB },
  OTHER: { principalId: 'userB', namespace: 'chatgpt', hostBindingKey: bindingOther },
  ALIAS: { principalId: 'userA', namespace: 'desktop', hostBindingKey: bindingA }
};
class MemoryStore implements LeaseStorage {
  value: LeaseSnapshot | null = null;
  broken = false;
  writes = 0;
  barrier: (() => Promise<void>) | null = null;
  async read() {
    if (this.broken) return { kind: 'corrupt' as const };
    return this.value ? { kind: 'valid' as const, value: structuredClone(this.value) } : { kind: 'missing' as const };
  }
  async commit(snapshot: LeaseSnapshot) {
    if (this.barrier) await this.barrier();
    if (this.broken) throw new Error('simulated fs error');
    this.writes++;
    this.value = structuredClone(snapshot);
  }
}
const auth: MissionLeaseAuthority = {
  async authenticate(inbound: unknown) {
    // Test-only trusted gateway fixture; this is deliberately NOT parsed from MCP tool args.
    if (typeof inbound !== 'string' || !(inbound in ACTORS)) return null;
    return ACTORS[inbound as ActorToken] ?? null;
  },
  async confirmApproval(inbound: unknown, operation: 'grant' | 'revoke') {
    return inbound === 'approved-' + operation;
  }
};
function grantFor(hostBindingKey = bindingA, caps: MissionCapability[] = ['read', 'command']) {
  return {
    approvalId: hostBindingKey === bindingB ? 'approval-B' : 'approval-A',
    principalId: 'userA', namespace: 'chatgpt', hostBindingKey,
    missionId: 'mission-A', projectId: 'project-A', capabilities: caps, ttlMs: 60_000
  };
}
function context(inbound: unknown = 'A', overrides: Record<string, unknown> = {}) {
  return { inbound, missionId: 'mission-A', projectId: 'project-A', capability: 'command' as const, epoch: 1, ...overrides };
}
let store: MemoryStore;
let currentTime: number;
let ledger: MissionLeaseRegistry;
beforeEach(async () => {
  store = new MemoryStore();
  currentTime = 100_000;
  ledger = new MissionLeaseRegistry(store, auth, () => currentTime);
  await ledger.restore();
});

describe('WP02 HMAC host binding', () => {
  it('derives stable, domain-separated keys without persisting original ChatGPT IDs', () => {
    expect(bindingA).toMatch(/^[0-9a-f]{64}$/);
    expect(bindingA).toEqual(hostBindingKey(SECRET, 'chatgpt', 'userA', 'chat-A'));
    expect(bindingA).not.toEqual(bindingB);
    expect(bindingA).not.toEqual(bindingOther);
    expect(bindingA).not.toEqual(hostBindingKey(SECRET, 'desktop', 'userA', 'chat-A'));
  });
  it('rejects weak secrets, empty strings, control characters, oversized IDs and ambiguous namespaces', () => {
    expect(() => hostBindingKey(Buffer.alloc(2), 'chatgpt', 'userA', 'A')).toThrow();
    for (const value of ['', 'bad\nnewline', 'B'.repeat(513)]) {
      expect(() => hostBindingKey(SECRET, 'chatgpt', 'userA', value)).toThrow();
    }
    expect(() => hostBindingKey(SECRET, '../bad', 'userA', 'A')).toThrow();
  });
});

describe('WP02 MissionLease fail-closed authorization', () => {
  it('rejects unbound / unauthenticated requests before an approved lease exists', async () => {
    expect(await ledger.authorize(context())).toEqual({ allowed: false, reason: 'NOT_BOUND' });
    expect(await ledger.authorize(context('BAD'))).toEqual({ allowed: false, reason: 'UNTRUSTED_CALLER' });
    expect(store.writes).toBe(0);
  });

  it('denies grants without independent operator approval or with malformed scope', async () => {
    await expect(ledger.grant(grantFor(), { 'openai/session': 'chat-A' })).rejects.toThrow('APPROVAL_REQUIRED');
    await expect(ledger.grant({ ...grantFor(), projectId: '../other' }, 'approved-grant')).rejects.toThrow('INVALID_GRANT');
    await expect(ledger.grant({ ...grantFor(), capabilities: ['read', 'read'] }, 'approved-grant')).rejects.toThrow('INVALID_GRANT');
    expect(store.writes).toBe(0);
  });

  it('commits a grant before first successful authorization, never by tool arguments', async () => {
    const grant = await ledger.grant(grantFor(), 'approved-grant');
    expect(grant.epoch).toBe(1);
    expect(store.writes).toBe(1);
    expect(await ledger.authorize(context())).toEqual({ allowed: true, leaseId: grant.leaseId });
    expect(await ledger.authorize(context({ missionId: 'mission-A', user: 'userA', session: 'chat-A' })))
      .toMatchObject({ allowed: false, reason: 'UNTRUSTED_CALLER' });
  });

  it('refuses prototype-chain names for missions and approval receipts', async () => {
    for (const name of ['__proto__', 'constructor', 'toString', 'prototype', 'hasOwnProperty']) {
      await expect(ledger.grant({ ...grantFor(), approvalId: name }, 'approved-grant'))
        .rejects.toThrow('INVALID_GRANT');
      await expect(ledger.grant({ ...grantFor(), missionId: name }, 'approved-grant'))
        .rejects.toThrow('INVALID_GRANT');
    }
    expect(store.writes).toBe(0);
  });

  it('returns the original receipt for an identical approved grant retry without a second write', async () => {
    const first = await ledger.grant(grantFor(), 'approved-grant');
    const again = await ledger.grant(grantFor(), 'approved-grant');
    expect(again.leaseId).toBe(first.leaseId);
    expect(again.epoch).toBe(1);
    expect(store.writes).toBe(1);
    expect(store.value?.grantRequests['approval-A']?.leaseId).toBe(first.leaseId);
  });

  it('rejects an approval ID replay with a different grant payload', async () => {
    await ledger.grant(grantFor(), 'approved-grant');
    await expect(ledger.grant({ ...grantFor(bindingB), approvalId: 'approval-A' }, 'approved-grant'))
      .rejects.toThrow('APPROVAL_REPLAY_CONFLICT');
    expect(store.writes).toBe(1);
    expect((await ledger.authorize(context())).allowed).toBe(true);
  });

  it('never reopens superseded or restarted authority by replaying an old approval ID', async () => {
    await ledger.grant(grantFor(), 'approved-grant');
    await ledger.grant(grantFor(bindingB), 'approved-grant');
    await expect(ledger.grant(grantFor(), 'approved-grant')).rejects.toThrow('APPROVAL_ALREADY_CONSUMED');
    expect(store.writes).toBe(2);
    const restarted = new MissionLeaseRegistry(store, auth, () => currentTime);
    await restarted.restore();
    await expect(restarted.grant(grantFor(bindingB), 'approved-grant')).rejects.toThrow('APPROVAL_ALREADY_CONSUMED');
  });

  it('rejects other host sessions, principals, namespaces and projects', async () => {
    await ledger.grant(grantFor(), 'approved-grant');
    expect(await ledger.authorize(context('B'))).toMatchObject({ allowed: false, reason: 'NOT_BOUND' });
    expect(await ledger.authorize(context('OTHER'))).toMatchObject({ allowed: false, reason: 'NOT_BOUND' });
    expect(await ledger.authorize(context('ALIAS'))).toMatchObject({ allowed: false, reason: 'NOT_BOUND' });
    expect(await ledger.authorize(context('A', { projectId: 'project-B' })))
      .toMatchObject({ allowed: false, reason: 'WRONG_SCOPE' });
    expect(await ledger.authorize(context('A', { missionId: 'mission-B' })))
      .toMatchObject({ allowed: false, reason: 'NOT_BOUND' });
  });

  it('restricts capability, expiry and stale epoch independently', async () => {
    await ledger.grant(grantFor(), 'approved-grant');
    expect(await ledger.authorize(context('A', { capability: 'agents' })))
      .toMatchObject({ allowed: false, reason: 'WRONG_CAPABILITY' });
    expect(await ledger.authorize(context('A', { epoch: 2 })))
      .toMatchObject({ allowed: false, reason: 'STALE_EPOCH' });
    currentTime += 60_000;
    expect(await ledger.authorize(context())).toMatchObject({ allowed: false, reason: 'EXPIRED' });
  });

  it('fences the old lease after a new approved grant with a new epoch', async () => {
    const old = await ledger.grant(grantFor(), 'approved-grant');
    const next = await ledger.grant(grantFor(bindingB), 'approved-grant');
    expect(next.epoch).toBe(2);
    expect(next.leaseId).not.toBe(old.leaseId);
    expect(await ledger.authorize(context('A', { epoch: 1 })))
      .toMatchObject({ allowed: false, reason: 'NOT_BOUND' });
    expect(await ledger.authorize(context('B', { epoch: 2 })))
      .toEqual({ allowed: true, leaseId: next.leaseId });
    expect(store.value?.leases).toHaveLength(1);
  });

  it('requires independent revoke approval; revoked or wrong-epoch calls cannot write', async () => {
    await ledger.grant(grantFor(), 'approved-grant');
    await expect(ledger.revoke('mission-A', 'wrong', 'revoke-A')).rejects.toThrow('APPROVAL_REQUIRED');
    expect((await ledger.authorize(context())).allowed).toBe(true);
    expect(await ledger.revoke('mission-A', 'approved-revoke', 'revoke-A')).toBe(true);
    expect(await ledger.authorize(context())).toMatchObject({ allowed: false });
    expect(store.value?.missionEpochs['mission-A']).toBe(2);
  });

  it('deduplicates a confirmed revoke and rejects the same approval ID for another mission', async () => {
    await ledger.grant(grantFor(), 'approved-grant');
    await ledger.revoke('mission-A', 'approved-revoke', 'revoke-A');
    expect(store.value?.missionEpochs['mission-A']).toBe(2);
    expect(store.writes).toBe(2);
    expect(await ledger.revoke('mission-A', 'approved-revoke', 'revoke-A')).toBe(true);
    expect(store.writes).toBe(2);
    await expect(ledger.revoke('mission-B', 'approved-revoke', 'revoke-A'))
      .rejects.toThrow('APPROVAL_REPLAY_CONFLICT');
  });

  it('never acknowledges an uncommitted grant; fails closed after ambiguous storage writes', async () => {
    const deferred: { resolve: () => void } = { resolve: () => { throw new Error('barrier not entered'); } };
    store.barrier = () => new Promise<void>(resolve => { deferred.resolve = resolve; });
    const pending = ledger.grant(grantFor(), 'approved-grant');
    await new Promise(resolve => setImmediate(resolve));
    expect(await ledger.authorize(context())).toMatchObject({ allowed: false });
    expect(store.writes).toBe(0);
    deferred.resolve();
    const grant = await pending;
    expect(await ledger.authorize(context())).toEqual({ allowed: true, leaseId: grant.leaseId });
    store.barrier = null;
    store.broken = true;
    await expect(ledger.grant(grantFor(bindingB), 'approved-grant')).rejects.toThrow('STORE_UNAVAILABLE');
    expect(await ledger.authorize(context())).toMatchObject({ allowed: false, reason: 'RECOVERY_LOCKED' });
  });

  it('blocks access immediately on an accepted revoke while persistence is in flight', async () => {
    await ledger.grant(grantFor(), 'approved-grant');
    const deferred: { resolve: () => void } = { resolve: () => { throw new Error('barrier not entered'); } };
    store.barrier = () => new Promise<void>(resolve => { deferred.resolve = resolve; });
    const revoking = ledger.revoke('mission-A', 'approved-revoke', 'revoke-A');
    await new Promise(resolve => setImmediate(resolve));
    expect(await ledger.authorize(context())).toMatchObject({ allowed: false, reason: 'RECOVERY_LOCKED' });
    deferred.resolve();
    await revoking;
    expect((await ledger.authorize(context())).allowed).toBe(false);
  });

  it('refuses restored leases even if a new mission gets approved', async () => {
    const first = await ledger.grant(grantFor(), 'approved-grant');
    const restored = new MissionLeaseRegistry(store, auth, () => currentTime);
    await restored.restore();
    expect(await restored.authorize(context())).toMatchObject({ allowed: false, reason: 'RECOVERY_LOCKED' });
    const nextGrant = await restored.grant({ ...grantFor(bindingB), missionId: 'mission-B' }, 'approved-grant');
    expect(nextGrant.epoch).toBe(1);
    expect(await restored.authorize(context())).toMatchObject({ allowed: false, reason: 'NOT_BOUND' });
    expect(await restored.authorize(context('B', { missionId: 'mission-B' })))
      .toEqual({ allowed: true, leaseId: nextGrant.leaseId });
    expect(first.leaseId).not.toBe(nextGrant.leaseId);
  });

  it('does not read authority from a damaged or inaccessible durable store', async () => {
    const bad = new MemoryStore();
    bad.broken = true;
    const damaged = new MissionLeaseRegistry(bad, auth, () => currentTime);
    await damaged.restore();
    expect(await damaged.authorize(context())).toMatchObject({ allowed: false, reason: 'RECOVERY_LOCKED' });
    await expect(damaged.grant(grantFor(), 'approved-grant')).rejects.toThrow('STORE_UNAVAILABLE');
  });

  it('serializes competing approved grants and grants only the newest epoch', async () => {
    const results = await Promise.all([
      ledger.grant(grantFor(), 'approved-grant'),
      ledger.grant(grantFor(bindingB), 'approved-grant')
    ]);
    expect(results.map(r => r.epoch)).toEqual([1, 2]);
    expect(store.writes).toBe(2);
    expect((await ledger.authorize(context('A', { epoch: 1 }))).allowed).toBe(false);
    expect((await ledger.authorize(context('B', { epoch: 2 }))).allowed).toBe(true);
  });
});
