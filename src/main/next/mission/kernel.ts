/**
 * CoS Next WP03–05: a single-authority Mission transaction ledger.
 *
 * This kernel is deliberately NOT registered as a ChatGPT MCP tool. The caller
 * must supply a trusted, non-model-controlled LeaseRegistry authority, and the
 * process must own an exclusive Next data-writer lock before it is constructed.
 * No operation below starts a model, shell command, agent or CI job itself.
 * Durably admitted effects must be reconciled by an authorized executor.
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { durableStoreReady, readDurableResult, writeDurableNow } from '../../durable.js';
import type { MissionCapability, MissionLeaseRegistry } from '../auth/mission-leases.js';

type MissionState = 'ACTIVE' | 'PAUSED' | 'STOPPED' | 'DONE' | 'HOLD';
type EffectState = 'ADMITTED' | 'DISPATCHED' | 'UNKNOWN_EFFECT' | 'EFFECT_OBSERVED' | 'RECONCILED';
type AgentState = 'QUEUED' | 'CLAIMED' | 'DELIVERY_UNKNOWN' | 'FINISHED' | 'CANCELLED';
type ObligationState = 'ARMED' | 'FIRED' | 'RESOLVED' | 'CANCELLED';
const MISSION_STATES = new Set<MissionState>(['ACTIVE', 'PAUSED', 'STOPPED', 'DONE', 'HOLD']);
const EFFECT_STATES = new Set<EffectState>(['ADMITTED', 'DISPATCHED', 'UNKNOWN_EFFECT', 'EFFECT_OBSERVED', 'RECONCILED']);
const AGENT_STATES = new Set<AgentState>(['QUEUED', 'CLAIMED', 'DELIVERY_UNKNOWN', 'FINISHED', 'CANCELLED']);
const OBLIGATION_STATES = new Set<ObligationState>(['ARMED', 'FIRED', 'RESOLVED', 'CANCELLED']);
const ID = /^[a-zA-Z0-9_.:-]{1,128}$/;
function validId(x: unknown): x is string {
  return typeof x === 'string' && ID.test(x) && !Object.prototype.hasOwnProperty.call(Object.prototype, x);
}
function validEpoch(n: unknown): n is number { return Number.isSafeInteger(n) && (n as number) > 0; }
function validRevision(n: unknown): n is number { return validEpoch(n); }
function digest(data: unknown): string { return createHash('sha256').update(JSON.stringify(data)).digest('hex'); }
function validDigest(x: unknown): x is string { return typeof x === 'string' && /^[a-f0-9]{64}$/.test(x); }
function conflict(reason: string): never { throw new Error(reason); }

export type Mission = Readonly<{
  missionId: string; projectId: string; state: MissionState;
  revision: number; epoch: number;
  completionChecks: readonly string[];
}>;
export type Project = Readonly<{
  projectId: string; canonicalRoot: string; rootDev: number; rootIno: number;
}>;
export type Effect = Readonly<{
  invocationId: string; missionId: string; key: string; requestHash: string;
  capability: 'write' | 'command'; epoch: number; state: EffectState;
  evidenceDigest: string | null;
}>;
export type Worker = Readonly<{
  agentId: string; missionId: string; state: AgentState; epoch: number;
  taskDigest: string; reportDigest: string | null;
}>;
export type Obligation = Readonly<{
  obligationId: string; missionId: string; sourceEventId: string;
  state: ObligationState; epoch: number; kind: 'process' | 'ci' | 'model' | 'user';
  evidenceDigest: string | null;
  outcome: 'PENDING' | 'SUCCESS' | 'FAILURE';
  continuation: 'NONE' | 'OWED' | 'ACKED';
}>;
export type MissionSnapshot = {
  version: 1;
  projects: Record<string, Project>;
  missions: Record<string, Mission>;
  effects: Record<string, Effect>;
  workers: Record<string, Worker>;
  obligations: Record<string, Obligation>;
};
export type StoreRead = { kind: 'missing' } | { kind: 'valid'; value: unknown } |
  { kind: 'corrupt' | 'io_error' };
export interface MissionStorage {
  read(): Promise<StoreRead>;
  commit(snapshot: MissionSnapshot): Promise<void>;
}
/** Must be instantiated ONLY after Next has initialized its isolated durable root. */
export class DurableMissionStorage implements MissionStorage {
  async read(): Promise<StoreRead> {
    if (!durableStoreReady()) return { kind: 'io_error' };
    const r = await readDurableResult<unknown>('next-missions');
    if (r.kind === 'valid') return { kind: 'valid', value: r.value };
    if (r.kind === 'missing') return { kind: 'missing' };
    return { kind: r.kind };
  }
  async commit(snapshot: MissionSnapshot): Promise<void> {
    if (!durableStoreReady()) throw new Error('STORE_UNAVAILABLE');
    await writeDurableNow('next-missions', snapshot);
  }
}

function validRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length <= 10_000 && Object.keys(value).every(validId);
}
function validSnapshot(raw: unknown): raw is MissionSnapshot {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const s = raw as Partial<MissionSnapshot>;
  if (s.version !== 1 || !validRecord(s.projects) || !validRecord(s.missions) ||
      !validRecord(s.effects) || !validRecord(s.workers) || !validRecord(s.obligations)) return false;
  for (const [id, p] of Object.entries(s.projects)) {
    if (!p || p.projectId !== id || typeof p.canonicalRoot !== 'string' ||
        p.canonicalRoot.length < 2 || p.canonicalRoot.length > 4096 ||
        !Number.isSafeInteger(p.rootDev) || !Number.isSafeInteger(p.rootIno) ||
        p.rootDev < 0 || p.rootIno < 0) return false;
  }
  for (const [id, m] of Object.entries(s.missions)) {
    if (!m || m.missionId !== id || !validId(m.projectId) ||
        !s.projects[m.projectId] || !MISSION_STATES.has(m.state) ||
        !validRevision(m.revision) || !validEpoch(m.epoch) ||
        !Array.isArray(m.completionChecks) ||
        m.completionChecks.length > 32 || !m.completionChecks.every(validId)) return false;
  }
  for (const [id, e] of Object.entries(s.effects)) {
    if (!e || e.invocationId !== id || !validId(e.key) || !validId(e.missionId) ||
        !s.missions[e.missionId] || !validDigest(e.requestHash) ||
        !validEpoch(e.epoch) || e.epoch > s.missions[e.missionId]!.epoch ||
        !EFFECT_STATES.has(e.state) || !['write', 'command'].includes(e.capability) ||
        (e.evidenceDigest !== null && !validDigest(e.evidenceDigest))) return false;
  }
  for (const [id, w] of Object.entries(s.workers)) {
    if (!w || w.agentId !== id || !validId(w.missionId) ||
        !s.missions[w.missionId] || !validEpoch(w.epoch) ||
        w.epoch > s.missions[w.missionId]!.epoch ||
        !AGENT_STATES.has(w.state) || !validDigest(w.taskDigest) ||
        (w.reportDigest !== null && !validDigest(w.reportDigest))) return false;
  }
  for (const [id, o] of Object.entries(s.obligations)) {
    if (!o || o.obligationId !== id || !validId(o.missionId) ||
        !s.missions[o.missionId] || !validId(o.sourceEventId) ||
        !validEpoch(o.epoch) || o.epoch > s.missions[o.missionId]!.epoch ||
        !OBLIGATION_STATES.has(o.state) ||
        !['process', 'ci', 'model', 'user'].includes(o.kind) ||
        !['PENDING', 'SUCCESS', 'FAILURE'].includes(o.outcome) ||
        !['NONE', 'OWED', 'ACKED'].includes(o.continuation) ||
        (o.evidenceDigest !== null && !validDigest(o.evidenceDigest))) return false;
  }
  return true;
}
const empty = (): MissionSnapshot => ({
  version: 1, projects: {}, missions: {}, effects: {}, workers: {}, obligations: {}
});

export interface MissionCaller {
  readonly inbound: unknown; // trusted endpoint context, NOT MCP tool args/_meta
  readonly missionId: string;
  readonly projectId: string;
  readonly epoch: number;
}
export interface LocalAdministrator {
  /** Proves local, explicit operator approval independently of the model. */
  approve(internalApproval: unknown, operation: 'create' | 'project' | 'browse' | 'rebind' | 'resume', scopeId: string): Promise<boolean>;
}
/** Receipts must be verified independently of incoming model/tool arguments. */
export interface LocalVerifier {
  verifyEffect(receipt: unknown, missionId: string, invocationId: string, digest: string): Promise<boolean>;
  verifyWait(receipt: unknown, missionId: string, obligationId: string, digest: string): Promise<boolean>;
  verifyCompletion(receipt: unknown, missionId: string, checks: Readonly<Record<string, boolean>>): Promise<boolean>;
  verifyWorkerClaim(receipt: unknown, missionId: string, agentId: string, epoch: number): Promise<boolean>;
  verifyWorkerReport(receipt: unknown, missionId: string, agentId: string, digest: string): Promise<boolean>;
  verifyWorkerReconciliation(receipt: unknown, missionId: string, agentId: string,
    outcome: 'FINISHED' | 'CANCELLED', digest: string): Promise<boolean>;
  verifyContinuation(receipt: unknown, missionId: string, obligationId: string, digest: string): Promise<boolean>;
}
export class MissionKernel {
  private current: MissionSnapshot = empty();
  private state: 'NEW' | 'READY' | 'BLOCKED' = 'NEW';
  private serial: Promise<unknown> = Promise.resolve();
  /** Native in-process executors subscribe to epoch fence AFTER durable commit. */
  private readonly fenceListeners = new Set<(missionId: string, oldEpoch: number) => void>();

  subscribeEpochFence(callback: (missionId: string, oldEpoch: number) => void): () => void {
    this.fenceListeners.add(callback);
    return () => this.fenceListeners.delete(callback);
  }
  private notifyEpochFence(missionId: string, oldEpoch: number): void {
    for (const listener of this.fenceListeners) {
      try { listener(missionId, oldEpoch); } catch { /* already durably fenced */ }
    }
  }

  constructor(
    private readonly storage: MissionStorage,
    private readonly leases: Pick<MissionLeaseRegistry, 'authorize'>,
    private readonly admin: LocalAdministrator,
    private readonly verifier: LocalVerifier
  ) {}

  /** Read-only health signal. No project, caller or receipt material. */
  get posture(): 'NEW' | 'READY' | 'BLOCKED' { return this.state; }

  async restore(): Promise<void> {
    if (this.state !== 'NEW') throw new Error('ALREADY_STARTED');
    let r: StoreRead;
    try { r = await this.storage.read(); } catch { r = { kind: 'io_error' }; }
    if (r.kind === 'missing') { this.state = 'READY'; return; }
    if (r.kind !== 'valid' || !validSnapshot(r.value)) {
      this.state = 'BLOCKED'; return;
    }
    // A previously DISPATCHED operation may have caused effects after a crash.
    // Persist the UNKNOWN_EFFECT fence before admitting *any* new operations.
    const candidate = structuredClone(r.value);
    let changed = false;
    for (const [id, e] of Object.entries(candidate.effects)) {
      if (e.state === 'DISPATCHED') {
        candidate.effects[id] = { ...e, state: 'UNKNOWN_EFFECT' };
        changed = true;
      }
    }
    for (const [id, w] of Object.entries(candidate.workers)) {
      if (w.state === 'CLAIMED') {
        candidate.workers[id] = { ...w, state: 'DELIVERY_UNKNOWN' };
        changed = true;
      }
    }
    for (const [id, m] of Object.entries(candidate.missions)) {
      if (m.state === 'ACTIVE') {
        candidate.missions[id] = { ...m, state: 'PAUSED' };
        changed = true;
      }
    }
    if (changed) {
      try { await this.storage.commit(candidate); }
      catch { this.state = 'BLOCKED'; return; }
    }
    this.current = candidate;
    this.state = 'READY';
  }

  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const step = this.serial.then(work);
    this.serial = step.then(() => undefined, () => undefined);
    return step;
  }
  private guardReady(): void { if (this.state !== 'READY') conflict('STORE_UNAVAILABLE'); }
  private async commit(next: MissionSnapshot): Promise<void> {
    this.guardReady();
    try { await this.storage.commit(next); }
    catch { this.state = 'BLOCKED'; conflict('COMMIT_AMBIGUOUS'); }
    this.current = next;
  }
  private async scope(ctx: MissionCaller, capability: MissionCapability, requireActive: boolean): Promise<Mission> {
    this.guardReady();
    if (!validId(ctx.missionId) || !validId(ctx.projectId) || !validEpoch(ctx.epoch))
      conflict('INVALID_CONTEXT');
    const m = this.current.missions[ctx.missionId];
    // Deny existence disclosure for out-of-scope attempts.
    if (!m || m.projectId !== ctx.projectId || m.epoch !== ctx.epoch) conflict('NOT_AUTHORIZED');
    const authorized = await this.leases.authorize({ inbound: ctx.inbound, missionId: ctx.missionId,
      projectId: ctx.projectId, epoch: ctx.epoch, capability });
    if (!authorized.allowed) conflict('NOT_AUTHORIZED');
    if (requireActive && m.state !== 'ACTIVE') conflict('MISSION_NOT_ACTIVE');
    return m;
  }
  private revise(next: MissionSnapshot, id: string): void {
    const m = next.missions[id]!;
    if (!Number.isSafeInteger(m.revision + 1)) conflict('REVISION_OVERFLOW');
    next.missions[id] = { ...m, revision: m.revision + 1 };
  }
  private compare(m: Mission, expectedRevision: number): void {
    if (!validRevision(expectedRevision) || m.revision !== expectedRevision) conflict('STALE_REVISION');
  }
  private async verifyProjectRoot(projectId: string): Promise<void> {
    const project = this.current.projects[projectId];
    if (!project) conflict('PROJECT_ROOT_UNAVAILABLE');
    try {
      const actual = await fs.realpath(project.canonicalRoot);
      const st = await fs.stat(actual);
      if (actual !== project.canonicalRoot || !st.isDirectory() ||
          st.dev !== project.rootDev || st.ino !== project.rootIno)
        conflict('PROJECT_ROOT_CHANGED');
    } catch { conflict('PROJECT_ROOT_CHANGED'); }
  }

  /** Native-only catalog. ChatGPT MCP cannot query other projects by name. */
  adminCatalog(localApproval: unknown): Promise<{ projects: Project[]; missions: Mission[] }> {
    return this.serialized(async () => {
      this.guardReady();
      if (!(await this.admin.approve(localApproval, 'browse', 'local-registry')))
        conflict('LOCAL_APPROVAL_REQUIRED');
      return structuredClone({
        projects: Object.values(this.current.projects),
        missions: Object.values(this.current.missions)
      });
    });
  }

  /** Local administrative bootstrap; never accessible as a raw ChatGPT tool. */
  provisionProject(projectId: string, canonicalRoot: string, approval: unknown): Promise<Project> {
    return this.serialized(async () => {
      this.guardReady();
      if (!validId(projectId) || typeof canonicalRoot !== 'string' ||
          canonicalRoot.length < 2 || canonicalRoot.length > 4096 ||
          !(await this.admin.approve(approval, 'project', projectId))) conflict('LOCAL_APPROVAL_REQUIRED');
      if (this.current.projects[projectId]) conflict('PROJECT_EXISTS');
      if (!path.isAbsolute(canonicalRoot) || canonicalRoot === path.parse(canonicalRoot).root)
        conflict('PROJECT_ROOT_INVALID');
      // A project must bind a REAL, existing, non-symlinked, canonical directory.
      // File operations still need a per-dispatch root/inode recheck to defeat TOCTOU.
      let verifiedRoot: string;
      try {
        verifiedRoot = await fs.realpath(canonicalRoot);
        if (verifiedRoot !== path.normalize(canonicalRoot) ||
            !(await fs.stat(verifiedRoot)).isDirectory()) conflict('PROJECT_ROOT_INVALID');
      } catch { conflict('PROJECT_ROOT_INVALID'); }
      if (Object.values(this.current.projects).some(p => p.canonicalRoot === verifiedRoot))
        conflict('PROJECT_ROOT_ALREADY_BOUND');
      const st = await fs.stat(verifiedRoot);
      const next = structuredClone(this.current);
      const project = { projectId, canonicalRoot: verifiedRoot, rootDev: st.dev, rootIno: st.ino };
      next.projects[projectId] = project;
      await this.commit(next);
      return project;
    });
  }
  provisionMission(projectId: string, missionId: string, checks: string[], approval: unknown): Promise<Mission> {
    return this.serialized(async () => {
      this.guardReady();
      if (!validId(projectId) || !validId(missionId) || !this.current.projects[projectId] ||
          !Array.isArray(checks) || checks.length > 32 || !checks.every(validId) ||
          !(await this.admin.approve(approval, 'create', missionId))) conflict('LOCAL_APPROVAL_REQUIRED');
      if (this.current.missions[missionId]) conflict('MISSION_EXISTS');
      const next = structuredClone(this.current);
      const mission: Mission = { projectId, missionId, state: 'ACTIVE', revision: 1, epoch: 1,
        completionChecks: [...new Set(checks)] };
      next.missions[missionId] = mission;
      await this.commit(next);
      return mission;
    });
  }
  inspect(ctx: MissionCaller): Promise<{ mission: Mission; effects: Effect[]; workers: Worker[]; obligations: Obligation[] }> {
    return this.serialized(async () => {
      const mission = await this.scope(ctx, 'read', false);
      return structuredClone({ mission,
        effects: Object.values(this.current.effects).filter(x => x.missionId === mission.missionId),
        workers: Object.values(this.current.workers).filter(x => x.missionId === mission.missionId),
        obligations: Object.values(this.current.obligations).filter(x => x.missionId === mission.missionId) });
    });
  }
  /** Return a pinned canonical root only to a verified scoped caller. */
  projectRoot(ctx: MissionCaller): Promise<string> {
    return this.serialized(async () => {
      const m = await this.scope(ctx, 'command', true);
      await this.verifyProjectRoot(m.projectId);
      return this.current.projects[m.projectId]!.canonicalRoot;
    });
  }

  /** Stop is persisted before the acknowledgement, fences epoch, and cancels future work. */
  stop(ctx: MissionCaller, expectedRevision: number): Promise<Mission> {
    return this.serialized(async () => {
      const m = await this.scope(ctx, 'stop_self', false);
      this.compare(m, expectedRevision);
      if (m.state === 'STOPPED') conflict('ALREADY_STOPPED');
      const next = structuredClone(this.current);
      if (!Number.isSafeInteger(m.epoch + 1)) conflict('EPOCH_OVERFLOW');
      next.missions[m.missionId] = { ...m, epoch: m.epoch + 1, state: 'STOPPED', revision: m.revision + 1 };
      for (const [key, w] of Object.entries(next.workers)) {
        if (w.missionId !== m.missionId) continue;
        if (w.state === 'QUEUED') next.workers[key] = { ...w, state: 'CANCELLED' };
        else if (w.state === 'CLAIMED') next.workers[key] = { ...w, state: 'DELIVERY_UNKNOWN' };
      }
      for (const [key, effect] of Object.entries(next.effects)) {
        if (effect.missionId === m.missionId && effect.state === 'DISPATCHED') {
          next.effects[key] = { ...effect, state: 'UNKNOWN_EFFECT' };
        }
      }
      for (const [key, o] of Object.entries(next.obligations)) {
        if (o.missionId === m.missionId && o.state !== 'RESOLVED') next.obligations[key] = { ...o, state: 'CANCELLED' };
      }
      await this.commit(next);
      this.notifyEpochFence(m.missionId, m.epoch);
      return next.missions[m.missionId]!;
    });
  }
  pause(ctx: MissionCaller, expectedRevision: number): Promise<Mission> {
    return this.serialized(async () => {
      const m = await this.scope(ctx, 'stop_self', true);
      this.compare(m, expectedRevision);
      if (!Number.isSafeInteger(m.epoch + 1)) conflict('EPOCH_OVERFLOW');
      const next = structuredClone(this.current);
      next.missions[m.missionId] = { ...m, epoch: m.epoch + 1,
        state: 'PAUSED', revision: m.revision + 1 };
      for (const [key, w] of Object.entries(next.workers)) {
        if (w.missionId === m.missionId && w.state === 'QUEUED') next.workers[key] = { ...w, state: 'CANCELLED' };
        else if (w.missionId === m.missionId && w.state === 'CLAIMED')
          next.workers[key] = { ...w, state: 'DELIVERY_UNKNOWN' };
      }
      for (const [key, effect] of Object.entries(next.effects)) {
        if (effect.missionId === m.missionId && effect.state === 'DISPATCHED') {
          next.effects[key] = { ...effect, state: 'UNKNOWN_EFFECT' };
        }
      }
      await this.commit(next);
      this.notifyEpochFence(m.missionId, m.epoch);
      return next.missions[m.missionId]!;
    });
  }

  /**
   * New local approval plus a *new* approved WP02 lease is required to bind
   * a restarted/paused Mission. Never grant rights merely because its disk
   * record or its former host session exists. STOPPED is terminal.
   */
  rebindMission(ctx: MissionCaller, expectedRevision: number, localApproval: unknown): Promise<Mission> {
    return this.serialized(async () => {
      this.guardReady();
      const m = this.current.missions[ctx.missionId];
      if (!m || m.projectId !== ctx.projectId || m.state !== 'PAUSED' ||
          ctx.epoch !== m.epoch + 1 || !Number.isSafeInteger(ctx.epoch)) conflict('RENEWAL_NOT_AUTHORIZED');
      this.compare(m, expectedRevision);
      const lease = await this.leases.authorize({ inbound: ctx.inbound, missionId: ctx.missionId,
        projectId: ctx.projectId, epoch: ctx.epoch, capability: 'read' });
      if (!lease.allowed || !(await this.admin.approve(localApproval, 'rebind', m.missionId))) conflict('RENEWAL_NOT_AUTHORIZED');
      const next = structuredClone(this.current);
      next.missions[m.missionId] = { ...m, epoch: ctx.epoch, revision: m.revision + 1 };
      // Old queued workers and waits cannot be inherited by a new lease.
      for (const [key, w] of Object.entries(next.workers)) {
        if (w.missionId === m.missionId && w.state === 'QUEUED') next.workers[key] = { ...w, state: 'CANCELLED' };
      }
      for (const [key, o] of Object.entries(next.obligations)) {
        if (o.missionId === m.missionId && o.state === 'ARMED') next.obligations[key] = { ...o, state: 'CANCELLED' };
      }
      await this.commit(next);
      return next.missions[m.missionId]!;
    });
  }

  /** Resume requires explicit local operator approval and no unresolved effects. */
  resume(ctx: MissionCaller, expectedRevision: number, localApproval: unknown): Promise<Mission> {
    return this.serialized(async () => {
      const m = await this.scope(ctx, 'command', false);
      this.compare(m, expectedRevision);
      if (m.state !== 'PAUSED') conflict('MISSION_NOT_PAUSED');
      if (!(await this.admin.approve(localApproval, 'resume', m.missionId))) conflict('LOCAL_APPROVAL_REQUIRED');
      if (Object.values(this.current.effects).some(e => e.missionId === m.missionId &&
          (e.state === 'DISPATCHED' || e.state === 'UNKNOWN_EFFECT'))) conflict('UNKNOWN_EFFECT_PENDING');
      if (Object.values(this.current.workers).some(w => w.missionId === m.missionId &&
          w.state === 'DELIVERY_UNKNOWN')) conflict('UNKNOWN_WORKER_DELIVERY');
      const next = structuredClone(this.current);
      next.missions[m.missionId] = { ...m, state: 'ACTIVE', revision: m.revision + 1 };
      await this.commit(next);
      return next.missions[m.missionId]!;
    });
  }

  /** Admission is durable; no external effect is started by this call. */
  admitEffect(ctx: MissionCaller, request: {
    invocationId: string; idempotencyKey: string; capability: 'write' | 'command';
    expectedRevision: number; payloadDigest: string
  }): Promise<Effect> {
    return this.serialized(async () => {
      const m = await this.scope(ctx, request.capability, true);
      if (!validId(request.invocationId) || !validId(request.idempotencyKey) ||
          !validDigest(request.payloadDigest)) conflict('INVALID_EFFECT');
      const requestHash = digest([m.missionId, request.idempotencyKey, request.capability, request.payloadDigest]);
      const known = Object.values(this.current.effects).find(x => x.missionId === m.missionId &&
        (x.key === request.idempotencyKey || x.invocationId === request.invocationId));
      if (known) {
        if (known.key !== request.idempotencyKey || known.requestHash !== requestHash ||
            known.invocationId !== request.invocationId) conflict('EFFECT_REPLAY_CONFLICT');
        return structuredClone(known); // Includes UNKNOWN_EFFECT; caller MUST NOT replay.
      }
      this.compare(m, request.expectedRevision);
      const next = structuredClone(this.current);
      const effect: Effect = { invocationId: request.invocationId, missionId: m.missionId,
        key: request.idempotencyKey, requestHash, capability: request.capability, epoch: m.epoch,
        state: 'ADMITTED', evidenceDigest: null };
      next.effects[effect.invocationId] = effect;
      this.revise(next, m.missionId);
      await this.commit(next);
      return effect;
    });
  }
  /** A dispatched operation is never automatically executed again after restart. */
  startDispatch(ctx: MissionCaller, invocationId: string): Promise<Effect> {
    return this.serialized(async () => {
      const effect = this.current.effects[invocationId];
      if (!effect || !['write', 'command'].includes(effect.capability)) conflict('EFFECT_NOT_DISPATCHABLE');
      const m = await this.scope(ctx, effect.capability, true);
      if (effect.missionId !== m.missionId || effect.epoch !== m.epoch ||
          effect.state !== 'ADMITTED') conflict('EFFECT_NOT_DISPATCHABLE');
      await this.verifyProjectRoot(m.projectId);
      const next = structuredClone(this.current);
      next.effects[invocationId] = { ...effect, state: 'DISPATCHED' };
      this.revise(next, m.missionId);
      await this.commit(next);
      return next.effects[invocationId]!;
    });
  }
  /**
   * Production dispatch barrier: the trusted native executor STARTS synchronously
   * while the Mission's serialized admission/Stop queue is held. Never accept a
   * model-supplied callback, or an async starter that hides a second dispatch.
   * The effect state is persisted BEFORE this synchronous callback runs; if
   * launch throws or its outcome is ambiguous, reconciliation is mandatory.
   */
  dispatchWithStarter(ctx: MissionCaller, invocationId: string, nativeStart: () => void): Promise<Effect> {
    return this.serialized(async () => {
      if (typeof nativeStart !== 'function') conflict('TRUSTED_STARTER_REQUIRED');
      const effect = this.current.effects[invocationId];
      if (!effect || !['write', 'command'].includes(effect.capability)) conflict('EFFECT_NOT_DISPATCHABLE');
      const m = await this.scope(ctx, effect.capability, true);
      if (effect.missionId !== m.missionId || effect.epoch !== m.epoch ||
          effect.state !== 'ADMITTED') conflict('EFFECT_NOT_DISPATCHABLE');
      await this.verifyProjectRoot(m.projectId);
      const next = structuredClone(this.current);
      next.effects[invocationId] = { ...effect, state: 'DISPATCHED' };
      this.revise(next, m.missionId);
      await this.commit(next);
      try {
        const result: unknown = nativeStart();
        if (result && typeof result === 'object' && 'then' in result) {
          conflict('ASYNC_STARTER_FORBIDDEN');
        }
      } catch {
        const uncertain = structuredClone(this.current);
        uncertain.effects[invocationId] = { ...next.effects[invocationId]!, state: 'UNKNOWN_EFFECT' };
        // If this write fails, commit() locks the registry and restart will
        // turn any DISPATCHED operation into UNKNOWN_EFFECT anyway.
        await this.commit(uncertain);
        conflict('DISPATCH_EFFECT_UNKNOWN');
      }
      return next.effects[invocationId]!;
    });
  }

  /** Receipt must be generated by a trusted executor, not the remote ChatGPT model. */
  observeEffect(ctx: MissionCaller, invocationId: string, evidenceDigest: string,
    localReceipt: unknown): Promise<Effect> {
    return this.serialized(async () => {
      const m = await this.scope(ctx, 'command', true);
      const effect = this.current.effects[invocationId];
      if (!validDigest(evidenceDigest) || !effect ||
          effect.missionId !== m.missionId || effect.epoch !== m.epoch ||
          !['DISPATCHED', 'UNKNOWN_EFFECT'].includes(effect.state)) conflict('UNTRUSTED_EFFECT_RECEIPT');
      let verified = false;
      try { verified = await this.verifier.verifyEffect(localReceipt, m.missionId, invocationId, evidenceDigest); }
      catch { /* verifier not available -> fail closed */ }
      if (!verified) conflict('UNTRUSTED_EFFECT_RECEIPT');
      const next = structuredClone(this.current);
      next.effects[invocationId] = { ...effect, state: 'EFFECT_OBSERVED', evidenceDigest };
      this.revise(next, m.missionId);
      await this.commit(next);
      return next.effects[invocationId]!;
    });
  }

  /**
   * Resolve, but NEVER re-dispatch, an external effect with an uncertain outcome.
   * Independent evidence is required and retained across restarts.
   */
  reconcileEffect(ctx: MissionCaller, invocationId: string, evidenceDigest: string,
    localReceipt: unknown): Promise<Effect> {
    return this.serialized(async () => {
      const m = await this.scope(ctx, 'command', false);
      const effect = this.current.effects[invocationId];
      if (!validDigest(evidenceDigest) || !effect || effect.missionId !== m.missionId ||
          effect.epoch > m.epoch || effect.state !== 'UNKNOWN_EFFECT') conflict('EFFECT_NOT_RECONCILABLE');
      let trusted = false;
      try { trusted = await this.verifier.verifyEffect(localReceipt, m.missionId, invocationId, evidenceDigest); }
      catch { /* fail closed */ }
      if (!trusted) conflict('UNTRUSTED_EFFECT_RECEIPT');
      const next = structuredClone(this.current);
      next.effects[invocationId] = { ...effect, state: 'RECONCILED', evidenceDigest };
      this.revise(next, m.missionId);
      await this.commit(next);
      return next.effects[invocationId]!;
    });
  }

  delegate(ctx: MissionCaller, expectedRevision: number, agentId: string, taskDigest: string): Promise<Worker> {
    return this.serialized(async () => {
      const m = await this.scope(ctx, 'agents', true);
      this.compare(m, expectedRevision);
      if (!validId(agentId) || !validDigest(taskDigest)) conflict('INVALID_AGENT');
      const known = this.current.workers[agentId];
      if (known) {
        if (known.missionId !== m.missionId || known.taskDigest !== taskDigest) conflict('AGENT_REPLAY_CONFLICT');
        return known;
      }
      const next = structuredClone(this.current);
      const worker: Worker = { agentId, missionId: m.missionId, epoch: m.epoch, state: 'QUEUED',
        taskDigest, reportDigest: null };
      next.workers[agentId] = worker;
      this.revise(next, m.missionId);
      await this.commit(next);
      return worker;
    });
  }

  /** Only a locally attested executor can acquire its own queued Worker task. */
  claimWorker(ctx: MissionCaller, agentId: string, localExecutorReceipt: unknown): Promise<Worker> {
    return this.serialized(async () => {
      const m = await this.scope(ctx, 'agents', true);
      const worker = this.current.workers[agentId];
      if (!worker || worker.missionId !== m.missionId || worker.epoch !== m.epoch ||
          worker.state !== 'QUEUED') conflict('WORKER_NOT_CLAIMABLE');
      let trusted = false;
      try { trusted = await this.verifier.verifyWorkerClaim(localExecutorReceipt, m.missionId, agentId, m.epoch); }
      catch { /* fail closed */ }
      if (!trusted) conflict('WORKER_CLAIM_UNVERIFIED');
      const next = structuredClone(this.current);
      next.workers[agentId] = { ...worker, state: 'CLAIMED' };
      this.revise(next, m.missionId);
      await this.commit(next);
      return next.workers[agentId]!;
    });
  }

  /** A Worker cannot declare completion via a plain model-generated ACK. */
  finishWorker(ctx: MissionCaller, agentId: string, reportDigest: string,
    localExecutorReceipt: unknown): Promise<Worker> {
    return this.serialized(async () => {
      const m = await this.scope(ctx, 'agents', true);
      const worker = this.current.workers[agentId];
      if (!validDigest(reportDigest) || !worker || worker.missionId !== m.missionId ||
          worker.epoch !== m.epoch || worker.state !== 'CLAIMED') conflict('WORKER_NOT_REPORTABLE');
      let trusted = false;
      try { trusted = await this.verifier.verifyWorkerReport(localExecutorReceipt, m.missionId, agentId, reportDigest); }
      catch { /* fail closed */ }
      if (!trusted) conflict('WORKER_REPORT_UNVERIFIED');
      const next = structuredClone(this.current);
      next.workers[agentId] = { ...worker, state: 'FINISHED', reportDigest };
      this.revise(next, m.missionId);
      await this.commit(next);
      return next.workers[agentId]!;
    });
  }

  /** Fail closed on an ambiguous active model delivery; no auto retry. */
  markWorkerDeliveryUnknown(ctx: MissionCaller, agentId: string): Promise<Worker> {
    return this.serialized(async () => {
      const m = await this.scope(ctx, 'agents', true);
      const worker = this.current.workers[agentId];
      if (!worker || worker.missionId !== m.missionId || worker.epoch !== m.epoch ||
          worker.state !== 'CLAIMED') conflict('WORKER_NOT_UNCERTAIN');
      const next = structuredClone(this.current);
      next.workers[agentId] = { ...worker, state: 'DELIVERY_UNKNOWN' };
      this.revise(next, m.missionId);
      await this.commit(next);
      return next.workers[agentId]!;
    });
  }

  /** A previously claimed Worker is never run twice; reconcile its effect out of band. */
  reconcileWorker(ctx: MissionCaller, agentId: string, outcome: 'FINISHED' | 'CANCELLED',
    reportDigest: string, localReceipt: unknown): Promise<Worker> {
    return this.serialized(async () => {
      const m = await this.scope(ctx, 'agents', false);
      const worker = this.current.workers[agentId];
      if (!worker || worker.missionId !== m.missionId || worker.epoch > m.epoch ||
          worker.state !== 'DELIVERY_UNKNOWN' || !validDigest(reportDigest)) conflict('WORKER_NOT_RECONCILABLE');
      let trusted = false;
      try { trusted = await this.verifier.verifyWorkerReconciliation(localReceipt, m.missionId,
        agentId, outcome, reportDigest); }
      catch { /* fail closed */ }
      if (!trusted) conflict('UNTRUSTED_WORKER_RECONCILIATION');
      const next = structuredClone(this.current);
      next.workers[agentId] = { ...worker, state: outcome, reportDigest };
      this.revise(next, m.missionId);
      await this.commit(next);
      return next.workers[agentId]!;
    });
  }

  armWait(ctx: MissionCaller, expectedRevision: number, obligationId: string, sourceEventId: string,
    kind: Obligation['kind']): Promise<Obligation> {
    return this.serialized(async () => {
      const m = await this.scope(ctx, 'wait', true);
      if (!validId(obligationId) || !validId(sourceEventId) ||
          !['process', 'ci', 'model', 'user'].includes(kind)) conflict('INVALID_WAIT');
      const known = Object.values(this.current.obligations).find(x => x.obligationId === obligationId ||
        (x.missionId === m.missionId && x.sourceEventId === sourceEventId && x.kind === kind && x.epoch === m.epoch));
      if (known) {
        if (known.obligationId !== obligationId || known.missionId !== m.missionId ||
            known.sourceEventId !== sourceEventId || known.kind !== kind || known.epoch !== m.epoch)
          conflict('OBLIGATION_REPLAY_CONFLICT');
        return known;
      }
      this.compare(m, expectedRevision);
      const next = structuredClone(this.current);
      const obligation: Obligation = { obligationId, missionId: m.missionId, epoch: m.epoch,
        state: 'ARMED', kind, sourceEventId, evidenceDigest: null,
        outcome: 'PENDING', continuation: 'NONE' };
      next.obligations[obligationId] = obligation;
      this.revise(next, m.missionId);
      await this.commit(next);
      return obligation;
    });
  }

  /** External callback evidence is only accepted after independent verifier attestation. */
  resolveWait(ctx: MissionCaller, obligationId: string, proofHash: string, localReceipt: unknown,
    outcome: 'SUCCESS' | 'FAILURE'): Promise<Obligation> {
    return this.serialized(async () => {
      const m = await this.scope(ctx, 'wait', true);
      const o = this.current.obligations[obligationId];
      if (!validDigest(proofHash) || !['SUCCESS', 'FAILURE'].includes(outcome) || !o ||
          o.missionId !== m.missionId || o.epoch !== m.epoch || o.state !== 'ARMED')
        conflict('INVALID_OBLIGATION_PROOF');
      let verified = false;
      try { verified = await this.verifier.verifyWait(localReceipt, m.missionId, obligationId, proofHash); }
      catch { /* verifier not available -> fail closed */ }
      if (!verified) conflict('INVALID_OBLIGATION_PROOF');
      const next = structuredClone(this.current);
      next.obligations[obligationId] = { ...o, state: 'RESOLVED', evidenceDigest: proofHash,
        outcome, continuation: 'OWED' };
      this.revise(next, m.missionId);
      await this.commit(next);
      return next.obligations[obligationId]!;
    });
  }

  /** Continuation is ACKED only after a *trusted*, observed model/host turn. */
  ackContinuation(ctx: MissionCaller, obligationId: string, localReceipt: unknown): Promise<Obligation> {
    return this.serialized(async () => {
      const m = await this.scope(ctx, 'wait', true);
      const o = this.current.obligations[obligationId];
      if (!o || o.missionId !== m.missionId || o.epoch !== m.epoch ||
          o.state !== 'RESOLVED' || o.continuation !== 'OWED' || !o.evidenceDigest)
        conflict('CONTINUATION_NOT_OWED');
      let trusted = false;
      try { trusted = await this.verifier.verifyContinuation(localReceipt, m.missionId,
        obligationId, o.evidenceDigest); } catch { /* no verifier, no ACK */ }
      if (!trusted) conflict('CONTINUATION_ACK_NOT_VERIFIED');
      const next = structuredClone(this.current);
      next.obligations[obligationId] = { ...o, continuation: 'ACKED' };
      this.revise(next, m.missionId);
      await this.commit(next);
      return next.obligations[obligationId]!;
    });
  }

  /**
   * A model's "done" message cannot complete a Mission. All completion checks
   * must be independently asserted by the locally authorized verifier.
   */
  complete(ctx: MissionCaller, expectedRevision: number, checks: Record<string, boolean>,
    localReceipt: unknown): Promise<Mission> {
    return this.serialized(async () => {
      const m = await this.scope(ctx, 'command', true);
      this.compare(m, expectedRevision);
      if (m.completionChecks.length === 0 || !checks || typeof checks !== 'object' ||
          !m.completionChecks.every(id => checks[id] === true)) conflict('COMPLETION_NOT_VERIFIED');
      let verified = false;
      try { verified = await this.verifier.verifyCompletion(localReceipt, m.missionId, checks); }
      catch { /* verifier not available -> fail closed */ }
      if (!verified) conflict('COMPLETION_NOT_VERIFIED');
      if (Object.values(this.current.effects).some(x => x.missionId === m.missionId &&
          (x.state === 'ADMITTED' || x.state === 'DISPATCHED' || x.state === 'UNKNOWN_EFFECT'))) conflict('PENDING_EFFECTS');
      if (Object.values(this.current.obligations).some(x => x.missionId === m.missionId &&
          (x.state === 'ARMED' || x.state === 'FIRED')))
        conflict('OBLIGATIONS_PENDING');
      if (Object.values(this.current.obligations).some(x => x.missionId === m.missionId &&
          x.continuation === 'OWED')) conflict('CONTINUATION_PENDING');
      if (Object.values(this.current.workers).some(x => x.missionId === m.missionId &&
          (x.state === 'QUEUED' || x.state === 'CLAIMED' || x.state === 'DELIVERY_UNKNOWN'))) conflict('WORKERS_PENDING');
      const next = structuredClone(this.current);
      next.missions[m.missionId] = { ...m, state: 'DONE', revision: m.revision + 1 };
      await this.commit(next);
      return next.missions[m.missionId]!;
    });
  }
}
