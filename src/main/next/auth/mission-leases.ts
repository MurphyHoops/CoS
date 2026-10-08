/**
 * CoS Next WP02 — mission lease authorization foundation.
 *
 * This module intentionally has NO MCP tool wiring. The verifier must be backed
 * by an independently authenticated connection and local operator approval.
 * openai/session and openai/subject are untrusted correlation hints, NOT principals.
 * Denied decisions never execute effects; stop/epoch fences must also be checked
 * by the future executor before each dispatch.
 */
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { durableStoreReady, readDurableResult, writeDurableNow } from '../../durable.js';

export type MissionCapability = 'read' | 'write' | 'command' | 'agents' | 'wait' | 'stop_self';
export type LeaseRejection =
  | 'UNTRUSTED_CALLER' | 'NOT_BOUND' | 'WRONG_SCOPE' | 'WRONG_CAPABILITY'
  | 'STALE_EPOCH' | 'EXPIRED' | 'REVOKED' | 'RECOVERY_LOCKED' | 'STORE_UNAVAILABLE';
export type VerifiedPrincipal = Readonly<{
  principalId: string;
  namespace: string;
  hostBindingKey: string;
}>;
export type MissionLease = Readonly<{
  leaseId: string;
  principalId: string;
  namespace: string;
  hostBindingKey: string;
  missionId: string;
  projectId: string;
  epoch: number;
  capabilities: readonly MissionCapability[];
  expiresAt: number;
  revokedAt: number | null;
}>;
export type LeaseSnapshot = {
  version: 1;
  missionEpochs: Record<string, number>;
  leases: MissionLease[];
  /** Durable idempotency receipts for verified, single-use operator approvals. */
  grantRequests: Record<string, { payloadHash: string; leaseId: string }>;
  revokeRequests: Record<string, { missionId: string; epoch: number }>;
};
export type RestoreResult = { kind: 'missing' } | { kind: 'valid'; value: unknown } |
  { kind: 'corrupt' | 'io_error' };

export interface LeaseStorage {
  read(): Promise<RestoreResult>;
  /** Must resolve only after an atomic durable commit, or reject. */
  commit(snapshot: LeaseSnapshot): Promise<void>;
}

/**
 * Isolated CoS Next-only persistence adapter. The app MUST have initialized
 * durable.ts with Next's own userData root and hold the exclusive writer lease
 * before instantiating this. Never use the production 3.1.x app state root.
 */
export class DurableMissionLeaseStorage implements LeaseStorage {
  private readonly name = 'next-mission-leases';

  async read(): Promise<RestoreResult> {
    if (!durableStoreReady()) return { kind: 'io_error' };
    const result = await readDurableResult<unknown>(this.name);
    switch (result.kind) {
      case 'missing': return { kind: 'missing' };
      case 'valid': return { kind: 'valid', value: result.value };
      default: return { kind: result.kind };
    }
  }

  async commit(snapshot: LeaseSnapshot): Promise<void> {
    if (!durableStoreReady()) throw new Error('STORE_UNAVAILABLE');
    await writeDurableNow(this.name, snapshot);
  }
}

/** Authentication/approval are separate, non-model-controlled app boundaries. */
export interface MissionLeaseAuthority {
  authenticate(inbound: unknown): Promise<VerifiedPrincipal | null>;
  confirmApproval(inboundApproval: unknown, operation: 'grant' | 'revoke'): Promise<boolean>;
}

const CAPABILITIES = new Set<MissionCapability>(['read', 'write', 'command', 'agents', 'wait', 'stop_self']);
const SAFE_NAME = /^[a-zA-Z0-9_.:-]{1,128}$/;
const SHA_256 = /^[0-9a-f]{64}$/;
const MAX_TTL_MS = 24 * 60 * 60 * 1000;

function validName(value: unknown): value is string {
  return typeof value === 'string' && SAFE_NAME.test(value) && value !== 'prototype' &&
    !Object.prototype.hasOwnProperty.call(Object.prototype, value);
}
function validBinding(value: unknown): value is string {
  return typeof value === 'string' && SHA_256.test(value);
}
function validPrincipal(actor: unknown): actor is VerifiedPrincipal {
  if (!actor || typeof actor !== 'object') return false;
  const a = actor as Partial<VerifiedPrincipal>;
  return validName(a.principalId) && validName(a.namespace) && validBinding(a.hostBindingKey);
}
function validCapabilities(value: unknown): value is MissionCapability[] {
  return Array.isArray(value) && value.length > 0 && value.length <= CAPABILITIES.size &&
    value.every((x: unknown) => typeof x === 'string' && CAPABILITIES.has(x as MissionCapability)) &&
    new Set(value).size === value.length;
}
function validateLease(value: unknown): value is MissionLease {
  if (!value || typeof value !== 'object') return false;
  const x = value as Partial<MissionLease>;
  return validName(x.leaseId) && validName(x.principalId) && validName(x.namespace) &&
    validBinding(x.hostBindingKey) && validName(x.missionId) && validName(x.projectId) &&
    Number.isSafeInteger(x.epoch) && (x.epoch ?? 0) > 0 &&
    validCapabilities(x.capabilities) && Number.isSafeInteger(x.expiresAt) &&
    (x.revokedAt === null || (Number.isSafeInteger(x.revokedAt) && (x.revokedAt ?? 0) > 0));
}
function validSnapshot(raw: unknown): raw is LeaseSnapshot {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const s = raw as Partial<LeaseSnapshot>;
  if (s.version !== 1 || !s.missionEpochs || typeof s.missionEpochs !== 'object' ||
      Array.isArray(s.missionEpochs) || !Array.isArray(s.leases) ||
      !s.grantRequests || typeof s.grantRequests !== 'object' || Array.isArray(s.grantRequests)) return false;
  if (!s.revokeRequests || typeof s.revokeRequests !== 'object' || Array.isArray(s.revokeRequests)) return false;
  if (Object.keys(s.grantRequests).length > 10_000 || Object.keys(s.revokeRequests).length > 10_000) return false;
  for (const [id, receipt] of Object.entries(s.revokeRequests)) {
    if (!validName(id) || !receipt || typeof receipt !== 'object' ||
        !validName(receipt.missionId) || !Number.isSafeInteger(receipt.epoch) || receipt.epoch <= 0) return false;
  }
  for (const [id, receipt] of Object.entries(s.grantRequests)) {
    if (!validName(id) || !receipt || typeof receipt !== 'object' ||
        !SHA_256.test(receipt.payloadHash) || !validName(receipt.leaseId)) return false;
  }
  for (const [id, epoch] of Object.entries(s.missionEpochs)) {
    if (!validName(id) || !Number.isSafeInteger(epoch) || epoch <= 0) return false;
  }
  const ids = new Set<string>();
  for (const lease of s.leases) {
    if (!validateLease(lease) || ids.has(lease.leaseId)) return false;
    const missionEpoch = s.missionEpochs[lease.missionId];
    if (missionEpoch === undefined || lease.epoch > missionEpoch) return false;
    ids.add(lease.leaseId);
  }
  return true;
}

function validHostInput(value: string): boolean {
  return value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
}

/**
 * Durable host binding keys require a protected, stable 32+-byte local key.
 * Unlike WP01 process-only diagnostics these can survive restarts if and ONLY
 * if the key is securely restored from the OS credential store.
 */
export function hostBindingKey(
  secret: Buffer, namespace: string, verifiedPrincipalId: string, hostSession: string
): string {
  if (secret.length < 32 || !validName(namespace) || !validName(verifiedPrincipalId) ||
      typeof hostSession !== 'string' || !validHostInput(hostSession)) {
    throw new Error('Invalid host binding input');
  }
  const parts = [namespace, verifiedPrincipalId, hostSession];
  const h = createHmac('sha256', secret).update('cos-next-host-binding-v1');
  for (const part of parts) h.update(':').update(String(Buffer.byteLength(part, 'utf8'))).update(':').update(part);
  return h.digest('hex');
}

export type GrantRequest = {
  /** Locally approved one-shot operation ID. Never a model argument. */
  approvalId: string;
  principalId: string;
  namespace: string;
  hostBindingKey: string;
  missionId: string;
  projectId: string;
  capabilities: MissionCapability[];
  ttlMs: number;
};

export class MissionLeaseRegistry {
  private snapshot: LeaseSnapshot = { version: 1, missionEpochs: {}, leases: [], grantRequests: {}, revokeRequests: {} };
  private state: 'new' | 'ready' | 'restart_locked' | 'blocked' = 'new';
  private pending: Promise<unknown> = Promise.resolve();
  // Never revive a persisted lease implicitly after restart/failed store commit.
  private activeThisProcess = new Set<string>();

  constructor(
    private readonly storage: LeaseStorage,
    private readonly authority: MissionLeaseAuthority,
    private readonly now: () => number = Date.now
  ) {}

  /** Restored authorizations never silently resume across process restart. */
  async restore(): Promise<void> {
    if (this.state !== 'new') throw new Error('Lease registry already initialized');
    const result = await this.storage.read();
    if (result.kind === 'missing') {
      this.state = 'ready';
      return;
    }
    if (result.kind !== 'valid' || !validSnapshot(result.value)) {
      this.state = 'blocked';
      return;
    }
    this.snapshot = structuredClone(result.value);
    this.state = 'restart_locked';
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.pending.then(operation);
    this.pending = run.then(() => undefined, () => undefined);
    return run;
  }

  /** Operator-approved grant replaces all prior authority for the mission. */
  grant(request: GrantRequest, localApproval: unknown): Promise<MissionLease> {
    return this.serialized(async () => {
      if (this.state === 'new' || this.state === 'blocked') throw new Error('STORE_UNAVAILABLE');
      if (!validName(request.approvalId) || !validName(request.principalId) || !validName(request.namespace) ||
          !validBinding(request.hostBindingKey) || !validName(request.missionId) ||
          !validName(request.projectId) || !validCapabilities(request.capabilities) ||
          !Number.isSafeInteger(request.ttlMs) || request.ttlMs < 1_000 ||
          request.ttlMs > MAX_TTL_MS) throw new Error('INVALID_GRANT');
      if (!(await this.authority.confirmApproval(localApproval, 'grant'))) throw new Error('APPROVAL_REQUIRED');
      const payloadHash = createHash('sha256').update(JSON.stringify({
        principalId: request.principalId, namespace: request.namespace,
        hostBindingKey: request.hostBindingKey, missionId: request.missionId,
        projectId: request.projectId, capabilities: [...request.capabilities].sort(),
        ttlMs: request.ttlMs
      })).digest('hex');
      const existing = Object.hasOwn(this.snapshot.grantRequests, request.approvalId)
        ? this.snapshot.grantRequests[request.approvalId] : undefined;
      if (existing) {
        if (existing.payloadHash !== payloadHash) throw new Error('APPROVAL_REPLAY_CONFLICT');
        const prior = this.snapshot.leases.find(x => x.leaseId === existing.leaseId);
        if (!prior || this.state !== 'ready' || !this.activeThisProcess.has(prior.leaseId) ||
            prior.revokedAt !== null || this.now() >= prior.expiresAt ||
            this.snapshot.missionEpochs[prior.missionId] !== prior.epoch) {
          throw new Error('APPROVAL_ALREADY_CONSUMED');
        }
        return prior; // Exact duplicate never increments epoch or writes again.
      }
      if (Object.keys(this.snapshot.grantRequests).length >= 10_000) throw new Error('APPROVAL_LOG_FULL');
      const currentEpoch = this.snapshot.missionEpochs[request.missionId] ?? 0;
      const epoch = currentEpoch + 1;
      if (!Number.isSafeInteger(epoch)) throw new Error('EPOCH_EXHAUSTED');
      const issued: MissionLease = {
        leaseId: randomUUID(),
        principalId: request.principalId,
        namespace: request.namespace,
        hostBindingKey: request.hostBindingKey,
        missionId: request.missionId,
        projectId: request.projectId,
        capabilities: [...request.capabilities],
        epoch,
        expiresAt: this.now() + request.ttlMs,
        revokedAt: null
      };
      const candidate: LeaseSnapshot = {
        version: 1,
        missionEpochs: { ...this.snapshot.missionEpochs, [request.missionId]: epoch },
        leases: [...this.snapshot.leases.filter(x => x.missionId !== request.missionId), issued],
        grantRequests: { ...this.snapshot.grantRequests,
          [request.approvalId]: { payloadHash, leaseId: issued.leaseId } },
        revokeRequests: { ...this.snapshot.revokeRequests }
      };
      // This is a commit barrier; never acknowledge an uncommitted grant.
      try { await this.storage.commit(candidate); }
      catch { this.state = 'blocked'; throw new Error('STORE_UNAVAILABLE'); }
      this.snapshot = candidate;
      for (const old of [...this.activeThisProcess]) {
        if (!candidate.leases.some(x => x.leaseId === old)) this.activeThisProcess.delete(old);
      }
      this.activeThisProcess.add(issued.leaseId);
      this.state = 'ready';
      return issued;
    });
  }

  /** Immediately fence in-memory authorization while the revocation commits. */
  revoke(missionId: string, localApproval: unknown, approvalId: string): Promise<boolean> {
    if (!validName(missionId) || !validName(approvalId)) return Promise.reject(new Error('INVALID_MISSION'));
    return this.serialized(async () => {
      if (this.state !== 'ready') throw new Error('STORE_UNAVAILABLE');
      if (!(await this.authority.confirmApproval(localApproval, 'revoke'))) throw new Error('APPROVAL_REQUIRED');
      const existing = Object.hasOwn(this.snapshot.revokeRequests, approvalId)
        ? this.snapshot.revokeRequests[approvalId] : undefined;
      if (existing) {
        if (existing.missionId !== missionId) throw new Error('APPROVAL_REPLAY_CONFLICT');
        return true; // Exact receipt retry: do not increment the mission epoch again.
      }
      if (Object.keys(this.snapshot.revokeRequests).length >= 10_000) throw new Error('APPROVAL_LOG_FULL');
      this.state = 'blocked';
      const epoch = (this.snapshot.missionEpochs[missionId] ?? 0) + 1;
      if (!Number.isSafeInteger(epoch)) throw new Error('EPOCH_EXHAUSTED');
      const candidate: LeaseSnapshot = {
        version: 1,
        missionEpochs: { ...this.snapshot.missionEpochs, [missionId]: epoch },
        leases: this.snapshot.leases.map(x => x.missionId === missionId
          ? { ...x, revokedAt: this.now() } : x),
        grantRequests: { ...this.snapshot.grantRequests },
        revokeRequests: { ...this.snapshot.revokeRequests, [approvalId]: { missionId, epoch } }
      };
      try { await this.storage.commit(candidate); }
      catch { throw new Error('STORE_UNAVAILABLE'); }
      this.snapshot = candidate;
      for (const old of [...this.activeThisProcess]) {
        if (!candidate.leases.some(x => x.leaseId === old && x.revokedAt === null)) this.activeThisProcess.delete(old);
      }
      this.state = 'ready';
      return true;
    });
  }

  async authorize(input: {
    inbound: unknown;
    missionId: string;
    projectId: string;
    capability: MissionCapability;
    epoch: number;
  }): Promise<{ allowed: true; leaseId: string } | { allowed: false; reason: LeaseRejection }> {
    if (this.state !== 'ready') {
      return { allowed: false, reason: this.state === 'new' ? 'STORE_UNAVAILABLE' : 'RECOVERY_LOCKED' };
    }
    let actor: VerifiedPrincipal | null;
    try { actor = await this.authority.authenticate(input.inbound); }
    catch { actor = null; }
    if (!validPrincipal(actor)) return { allowed: false, reason: 'UNTRUSTED_CALLER' };
    if (!validName(input.missionId) || !validName(input.projectId) ||
        !CAPABILITIES.has(input.capability) || !Number.isSafeInteger(input.epoch)) {
      return { allowed: false, reason: 'NOT_BOUND' };
    }
    const lease = this.snapshot.leases.find(x =>
      x.missionId === input.missionId && x.principalId === actor.principalId &&
      x.namespace === actor.namespace && x.hostBindingKey === actor.hostBindingKey
    );
    if (!lease || !this.activeThisProcess.has(lease.leaseId)) return { allowed: false, reason: 'NOT_BOUND' };
    if (lease.revokedAt !== null) return { allowed: false, reason: 'REVOKED' };
    if (this.snapshot.missionEpochs[input.missionId] !== input.epoch ||
        lease.epoch !== input.epoch) return { allowed: false, reason: 'STALE_EPOCH' };
    if (this.now() >= lease.expiresAt) return { allowed: false, reason: 'EXPIRED' };
    if (lease.projectId !== input.projectId) return { allowed: false, reason: 'WRONG_SCOPE' };
    if (!lease.capabilities.includes(input.capability)) return { allowed: false, reason: 'WRONG_CAPABILITY' };
    // A revocation may have started while authenticate() awaited external validation.
    if (this.state !== 'ready') return { allowed: false, reason: 'RECOVERY_LOCKED' };
    return { allowed: true, leaseId: lease.leaseId };
  }
}
