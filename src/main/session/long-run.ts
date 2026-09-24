/**
 * Durable long-run execution control.
 *
 * ChatGPT conversations are disposable executors.  This ledger is the small piece of state that
 * says what the durable session still owes, which provider conversation currently holds that
 * authority, and which generation every delayed side effect was admitted under.
 *
 * It deliberately does not inspect DOM/provider liveness.  Observations may supply evidence, but
 * only transitions in this file grant or revoke long-run execution authority.
 */

import { randomUUID } from 'node:crypto';
import {
  readDurableResult,
  writeDurableCheckpointNow,
  writeDurableNow,
  writeDurableSoon
} from '../durable.js';
import {
  durableRecoveryPaused,
  noteDurableRecoveryIncident,
  resolveDurableRecoveryIncident
} from '../durable-recovery.js';

export const LONG_RUN_STATE = 'long-run';
const LONG_RUN_RECOVERY_DOMAIN = 'long-run' as const;

export const LONG_RUN_RECOVERY_REFUSAL =
  'DURABLE_RECOVERY_PAUSED: the long-run execution ledger could not be read safely, so CoS cannot ' +
  'prove wait debt, execution generation, or old-executor fences. No local tool was run. Resolve ' +
  'the durable recovery incident before continuing automated work.';

export type LongRunWorkReason =
  | 'recovery_resume'
  | 'wait_resolved'
  | 'wait_failed';

export type LongRunWorkState =
  | 'waiting'
  | 'owed'
  | 'dispatching'
  | 'queued'
  | 'fulfilled'
  | 'cancelled';

export interface ExecutionEpoch {
  sessionId: string;
  conversationId: string;
  generation: number;
  updatedAt: number;
}

export interface ExecutionTicket {
  sessionId: string;
  conversationId: string;
  generation: number;
}

/** Certified evidence that the durable task, not merely its browser transport, advanced. */
export interface ProgressCertificate {
  sessionId: string;
  conversationId: string;
  observedAt: number;
  turnId: string | null;
  evidence: 'mcp' | 'terminal';
  requestId?: string | null;
}

export interface WorkObligation {
  id: string;
  sessionId: string;
  conversationId: string;
  epochGeneration: number;
  reason: LongRunWorkReason;
  state: LongRunWorkState;
  sourceTurnId: string | null;
  /** Exact ChatGPT MCP workflow id for the source provider turn. New wait admissions always set it. */
  sourceRequestId?: string | null;
  source: string | null;
  inputId: string | null;
  result: string | null;
  createdAt: number;
  /** Mutable provider-ready budget anchor for recovery probation; evidence remains createdAt. */
  providerBudgetAt?: number;
  /**
   * Durable one-shot claim for automatic Project Runtime completion evaluation.
   *
   * This is written before any project verifier command may start. If the process crashes after
   * the claim, the recovered obligation fails open to ordinary continuation instead of replaying
   * an ambiguous command-backed check.
   */
  completionCheckClaimedAt?: number | null;
  updatedAt: number;
  issuedAt: number | null;
}

export type BuiltinLongRunWaitKind = 'github_run' | 'process' | 'timer';
/** Adapter id. Built-ins are above; projects/plugins may register additional stable kinds. */
export type LongRunWaitKind = BuiltinLongRunWaitKind | (string & {});
export type LongRunWaitState = 'waiting' | 'resolved' | 'failed' | 'cancelled';

export interface LongRunWaitContract {
  id: string;
  sessionId: string;
  conversationId: string;
  epochGeneration: number;
  obligationId: string;
  kind: LongRunWaitKind;
  /** Stable semantic identity for retry/idempotency; adapters define its contents. */
  providerKey?: string | null;
  /** Bounded JSON payload owned by the wait adapter, never interpreted by the scheduler core. */
  providerData?: Record<string, unknown> | null;
  repository: string | null;
  runId: number | null;
  processId: number | null;
  dueAt: number | null;
  description: string | null;
  state: LongRunWaitState;
  attempts: number;
  nextCheckAt: number;
  lastError: string | null;
  result: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface LongRunSnapshot {
  version: 1;
  savedAt: number;
  epochs: ExecutionEpoch[];
  obligations: WorkObligation[];
  waits: LongRunWaitContract[];
  /** Durable proof that provider-time budgets were paused when this WAL was written. */
  transportPausedAt?: number | null;
}

export interface ArmLongRunWaitInput {
  sessionId: string;
  conversationId: string;
  sourceTurnId: string;
  sourceRequestId?: string | null;
  kind: LongRunWaitKind;
  providerKey?: string | null;
  providerData?: Record<string, unknown> | null;
  repository?: string | null;
  runId?: number | null;
  processId?: number | null;
  dueAt?: number | null;
  description?: string | null;
}

const epochs = new Map<string, ExecutionEpoch>();
const obligations = new Map<string, WorkObligation>();
const waits = new Map<string, LongRunWaitContract>();
let transportPausedAt: number | null = null;
let chain: Promise<unknown> = Promise.resolve();

export function longRunRecoveryPaused(): boolean {
  return durableRecoveryPaused(LONG_RUN_RECOVERY_DOMAIN);
}

function serial<T>(work: () => Promise<T>): Promise<T> {
  const guarded = (): Promise<T> => {
    if (longRunRecoveryPaused()) return Promise.reject(new Error('long_run_durable_recovery_required'));
    return work();
  };
  const next = chain.then(guarded, guarded);
  chain = next.then(() => undefined, () => undefined);
  return next;
}

function validSessionId(value: unknown): value is string {
  return typeof value === 'string' && /^[\w-]{8,64}$/.test(value);
}

function validConversationId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-z-]{8,256}$/i.test(value);
}

function validGeneration(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function validWaitKind(value: unknown): value is LongRunWaitKind {
  return typeof value === 'string' && /^[a-z][a-z0-9_.-]{1,63}$/.test(value);
}

function validProviderData(value: unknown): value is Record<string, unknown> | null | undefined {
  if (value === null || value === undefined) return true;
  if (typeof value !== 'object' || Array.isArray(value)) return false;
  try { return Buffer.byteLength(JSON.stringify(value), 'utf8') <= 16_384; }
  catch { return false; }
}

function clip(value: string | null | undefined, max = 500): string | null {
  if (!value) return null;
  return value.slice(0, max);
}

function cloneEpoch(row: ExecutionEpoch): ExecutionEpoch { return { ...row }; }
function cloneWork(row: WorkObligation): WorkObligation { return { ...row }; }
function cloneWait(row: LongRunWaitContract): LongRunWaitContract { return { ...row }; }

function validRequiredString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function validNullableString(value: unknown, max: number): value is string | null {
  return value === null || (typeof value === 'string' && value.length <= max);
}

function validPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function validLongRunInputId(value: unknown): value is string {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function noteLongRunRecovery(
  copy: 'primary' | 'backup',
  failure: 'json_corrupt' | 'schema_invalid' | 'io_error' | 'checkpoint_degraded' | 'orphan_backup',
  disposition: 'pause' | 'degraded',
  detail?: string
): void {
  noteDurableRecoveryIncident({
    domain: LONG_RUN_RECOVERY_DOMAIN,
    ledger: LONG_RUN_STATE,
    copy,
    failure,
    disposition,
    detail
  });
}

async function checkpointAcceptedLongRun(value: LongRunSnapshot): Promise<void> {
  try {
    await writeDurableCheckpointNow(LONG_RUN_STATE, value);
    resolveDurableRecoveryIncident(LONG_RUN_RECOVERY_DOMAIN, LONG_RUN_STATE, 'backup');
  } catch (error) {
    noteLongRunRecovery(
      'backup',
      'checkpoint_degraded',
      'degraded',
      error instanceof Error ? error.message : String(error)
    );
  }
}

async function commitLongRunNow(): Promise<void> {
  const accepted = snapshotLongRunState();
  await writeDurableNow(LONG_RUN_STATE, accepted);
  await checkpointAcceptedLongRun(accepted);
}

export function snapshotLongRunState(): LongRunSnapshot {
  return {
    version: 1,
    savedAt: Date.now(),
    epochs: [...epochs.values()].map(cloneEpoch),
    obligations: [...obligations.values()].map(cloneWork),
    waits: [...waits.values()].map(cloneWait),
    transportPausedAt
  };
}

function decodeLongRunSnapshot(value: unknown): LongRunSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as {
    version?: unknown;
    savedAt?: unknown;
    epochs?: unknown;
    obligations?: unknown;
    waits?: unknown;
    transportPausedAt?: unknown;
  };
  if (raw.version !== 1 || !validPositiveInteger(raw.savedAt) ||
      !Array.isArray(raw.epochs) || !Array.isArray(raw.obligations) || !Array.isArray(raw.waits) ||
      !(raw.transportPausedAt === undefined || raw.transportPausedAt === null ||
        validPositiveInteger(raw.transportPausedAt))) return null;

  const decodedEpochs: ExecutionEpoch[] = [];
  const epochBySession = new Map<string, ExecutionEpoch>();
  for (const candidate of raw.epochs) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
    const epoch = candidate as Partial<ExecutionEpoch>;
    if (!validSessionId(epoch.sessionId) || !validConversationId(epoch.conversationId) ||
        !validGeneration(epoch.generation) || !validPositiveInteger(epoch.updatedAt) ||
        epochBySession.has(epoch.sessionId)) return null;
    const normalized: ExecutionEpoch = {
      sessionId: epoch.sessionId,
      conversationId: epoch.conversationId,
      generation: epoch.generation,
      updatedAt: epoch.updatedAt
    };
    decodedEpochs.push(normalized);
    epochBySession.set(normalized.sessionId, normalized);
  }

  const decodedWork: WorkObligation[] = [];
  const workBySession = new Map<string, WorkObligation>();
  const historicalWorkBySession = new Map<string, WorkObligation>();
  const seenWorkSessions = new Set<string>();
  for (const candidate of raw.obligations) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
    const work = candidate as Partial<WorkObligation>;
    if (!validRequiredString(work.id, 200) ||
        !validSessionId(work.sessionId) || !validConversationId(work.conversationId) ||
        !validGeneration(work.epochGeneration) ||
        !['recovery_resume', 'wait_resolved', 'wait_failed'].includes(String(work.reason)) ||
        !['waiting', 'owed', 'dispatching', 'queued', 'fulfilled', 'cancelled'].includes(String(work.state)) ||
        !((work.sourceTurnId === null && work.reason === 'recovery_resume') || validRequiredString(work.sourceTurnId, 256)) ||
        !(work.sourceRequestId === undefined || work.sourceRequestId === null ||
          validRequiredString(work.sourceRequestId, 200)) ||
        !validNullableString(work.source, 500) ||
        !(work.inputId === null || validLongRunInputId(work.inputId)) ||
        !validNullableString(work.result, 2_000) ||
        !validPositiveInteger(work.createdAt) || !validPositiveInteger(work.updatedAt) ||
        Number(work.updatedAt) < Number(work.createdAt) ||
        !(work.providerBudgetAt === undefined ||
          (typeof work.providerBudgetAt === 'number' && Number.isFinite(work.providerBudgetAt) && work.providerBudgetAt > 0)) ||
        !(work.completionCheckClaimedAt === undefined || work.completionCheckClaimedAt === null ||
          validPositiveInteger(work.completionCheckClaimedAt)) ||
        !(work.issuedAt === null || validPositiveInteger(work.issuedAt)) ||
        seenWorkSessions.has(work.sessionId)) return null;
    seenWorkSessions.add(work.sessionId);
    if ((work.state === 'dispatching' || work.state === 'queued') && !work.inputId) return null;
    if (work.reason !== 'wait_resolved' && work.state === 'waiting') return null;
    const epoch = epochBySession.get(work.sessionId);
    if (!epoch) return null;
    const exactLineage =
      epoch.conversationId === work.conversationId && epoch.generation === work.epochGeneration;
    // Completed/revoked work is deliberately not rebound when its disposable conversation moves.
    // The legacy restore path discarded that historical row because only the newer epoch can grant
    // authority. Accept that exact shape, but never publish the stale work back into live maps.
    const staleTerminalLineage =
      (work.state === 'fulfilled' || work.state === 'cancelled') &&
      work.epochGeneration < epoch.generation && work.updatedAt <= epoch.updatedAt;
    if (!exactLineage && !staleTerminalLineage) return null;

    const normalized: WorkObligation = {
      id: work.id,
      sessionId: work.sessionId,
      conversationId: work.conversationId,
      epochGeneration: work.epochGeneration,
      reason: work.reason as LongRunWorkReason,
      state: work.state as LongRunWorkState,
      sourceTurnId: work.sourceTurnId,
      sourceRequestId: work.sourceRequestId ?? null,
      source: work.source,
      inputId: work.inputId,
      result: work.result,
      createdAt: work.createdAt,
      ...(work.providerBudgetAt !== undefined ? { providerBudgetAt: work.providerBudgetAt } : {}),
      completionCheckClaimedAt: work.completionCheckClaimedAt ?? null,
      updatedAt: work.updatedAt,
      issuedAt: work.issuedAt
    };
    if (exactLineage) {
      decodedWork.push(normalized);
      workBySession.set(normalized.sessionId, normalized);
    } else {
      historicalWorkBySession.set(normalized.sessionId, normalized);
    }
  }

  const decodedWaits: LongRunWaitContract[] = [];
  const waitBySession = new Map<string, LongRunWaitContract>();
  const historicalWaitBySession = new Set<string>();
  const seenWaitSessions = new Set<string>();
  for (const candidate of raw.waits) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
    const wait = candidate as Partial<LongRunWaitContract>;
    if (!validRequiredString(wait.id, 200) ||
        !validSessionId(wait.sessionId) || !validConversationId(wait.conversationId) ||
        !validGeneration(wait.epochGeneration) || !validRequiredString(wait.obligationId, 200) ||
        !validWaitKind(wait.kind) ||
        !(wait.providerKey === undefined || wait.providerKey === null ||
          validRequiredString(wait.providerKey, 500)) ||
        !validProviderData(wait.providerData) ||
        !validNullableString(wait.repository, 201) ||
        !(wait.runId === null || validPositiveInteger(wait.runId)) ||
        !(wait.processId === null || validPositiveInteger(wait.processId)) ||
        !(wait.dueAt === null || validPositiveInteger(wait.dueAt)) ||
        !validNullableString(wait.description, 300) ||
        !['waiting', 'resolved', 'failed', 'cancelled'].includes(String(wait.state)) ||
        !Number.isSafeInteger(wait.attempts) || Number(wait.attempts) < 0 ||
        !Number.isSafeInteger(wait.nextCheckAt) || Number(wait.nextCheckAt) < 0 ||
        !validNullableString(wait.lastError, 500) ||
        !validNullableString(wait.result, 2_000) ||
        !validPositiveInteger(wait.createdAt) || !validPositiveInteger(wait.updatedAt) ||
        Number(wait.updatedAt) < Number(wait.createdAt) ||
        seenWaitSessions.has(wait.sessionId)) return null;
    seenWaitSessions.add(wait.sessionId);

    if (wait.kind === 'github_run' &&
        (!wait.repository || !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(wait.repository) ||
          !validPositiveInteger(wait.runId))) return null;
    if (wait.kind === 'process' && !validPositiveInteger(wait.processId)) return null;
    if (wait.kind === 'timer' && !validPositiveInteger(wait.dueAt)) return null;
    if (!['github_run', 'process', 'timer'].includes(wait.kind) && !wait.providerKey) return null;

    const epoch = epochBySession.get(wait.sessionId);
    const currentWork = workBySession.get(wait.sessionId);
    const historicalWork = historicalWorkBySession.get(wait.sessionId);
    const work = currentWork ?? historicalWork;
    if (!epoch || !work || work.id !== wait.obligationId) return null;
    const exactLineage =
      !!currentWork &&
      epoch.conversationId === wait.conversationId &&
      epoch.generation === wait.epochGeneration &&
      currentWork.conversationId === wait.conversationId &&
      currentWork.epochGeneration === wait.epochGeneration;
    const staleTerminalLineage =
      wait.state !== 'waiting' &&
      wait.epochGeneration < epoch.generation &&
      wait.updatedAt <= epoch.updatedAt &&
      (!!currentWork ||
        (!!historicalWork && historicalWork.conversationId === wait.conversationId &&
          historicalWork.epochGeneration === wait.epochGeneration));
    if (!exactLineage && !staleTerminalLineage) return null;
    if (wait.state === 'waiting' && work.state !== 'waiting') return null;
    if (wait.state === 'resolved' && (work.reason !== 'wait_resolved' || work.state === 'waiting')) return null;
    if (wait.state === 'failed' && (work.reason !== 'wait_failed' || work.state === 'waiting')) return null;
    if (wait.state === 'cancelled' && work.state !== 'cancelled') return null;

    const normalized: LongRunWaitContract = {
      id: wait.id,
      sessionId: wait.sessionId,
      conversationId: wait.conversationId,
      epochGeneration: wait.epochGeneration,
      obligationId: wait.obligationId,
      kind: wait.kind,
      providerKey: wait.providerKey ?? null,
      providerData: wait.providerData ? { ...wait.providerData } : null,
      repository: wait.repository,
      runId: wait.runId,
      processId: wait.processId,
      dueAt: wait.dueAt,
      description: wait.description,
      state: wait.state as LongRunWaitState,
      attempts: Number(wait.attempts),
      nextCheckAt: Number(wait.nextCheckAt),
      lastError: wait.lastError,
      result: wait.result,
      createdAt: wait.createdAt,
      updatedAt: wait.updatedAt
    };
    if (exactLineage) {
      decodedWaits.push(normalized);
      waitBySession.set(normalized.sessionId, normalized);
    } else {
      historicalWaitBySession.add(normalized.sessionId);
    }
  }

  for (const work of decodedWork) {
    const wait = waitBySession.get(work.sessionId);
    if (work.reason === 'recovery_resume') {
      if (wait || historicalWaitBySession.has(work.sessionId) || work.state === 'waiting') return null;
    } else if ((!wait || wait.obligationId !== work.id) && !historicalWaitBySession.has(work.sessionId)) {
      return null;
    }
  }
  for (const work of historicalWorkBySession.values()) {
    if (work.reason === 'recovery_resume') {
      if (historicalWaitBySession.has(work.sessionId)) return null;
    } else if (!historicalWaitBySession.has(work.sessionId)) {
      return null;
    }
  }

  return {
    version: 1,
    savedAt: Number(raw.savedAt),
    epochs: decodedEpochs,
    obligations: decodedWork,
    waits: decodedWaits,
    ...(raw.transportPausedAt !== undefined ? { transportPausedAt: raw.transportPausedAt as number | null } : {})
  };
}

async function inspectLongRunBackupHealth(): Promise<'missing' | 'valid' | 'invalid'> {
  const result = await readDurableResult<unknown>(LONG_RUN_STATE, 'backup');
  if (result.kind === 'missing') {
    resolveDurableRecoveryIncident(LONG_RUN_RECOVERY_DOMAIN, LONG_RUN_STATE, 'backup');
    return 'missing';
  }
  if (result.kind === 'io_error') {
    noteLongRunRecovery('backup', 'io_error', 'degraded', result.error);
    return 'invalid';
  }
  if (result.kind === 'corrupt') {
    noteLongRunRecovery('backup', 'json_corrupt', 'degraded', result.error);
    return 'invalid';
  }
  if (!decodeLongRunSnapshot(result.value)) {
    noteLongRunRecovery('backup', 'schema_invalid', 'degraded', 'backup snapshot failed long-run schema validation');
    return 'invalid';
  }
  resolveDurableRecoveryIncident(LONG_RUN_RECOVERY_DOMAIN, LONG_RUN_STATE, 'backup');
  return 'valid';
}

function persistSoon(): void {
  writeDurableSoon(LONG_RUN_STATE, snapshotLongRunState());
}

export async function pauseLongRunTransportNow(now = Date.now()): Promise<void> {
  return serial(async () => {
    if (transportPausedAt !== null) return;
    transportPausedAt = now;
    try { await commitLongRunNow(); }
    catch (error) { persistSoon(); throw error; }
  });
}

export async function resumeLongRunTransportNow(now = Date.now()): Promise<void> {
  return serial(async () => {
    const pausedAt = transportPausedAt;
    if (pausedAt === null) return;
    transportPausedAt = null;
    for (const [sessionId, work] of obligations) {
      if (work.reason !== 'recovery_resume' || work.state !== 'owed') continue;
      const anchor = work.providerBudgetAt ?? work.createdAt;
      const overlap = Math.max(0, now - Math.max(pausedAt, anchor));
      obligations.set(sessionId, { ...work, providerBudgetAt: anchor + overlap });
    }
    try { await commitLongRunNow(); }
    catch (error) { persistSoon(); throw error; }
  });
}

export function longRunProviderBudgetAge(work: WorkObligation, now = Date.now()): number {
  const budgetNow = transportPausedAt === null ? now : Math.min(now, transportPausedAt);
  return Math.max(0, budgetNow - (work.providerBudgetAt ?? work.createdAt));
}

export function restoreLongRunState(snapshot: LongRunSnapshot | null): boolean {
  epochs.clear();
  obligations.clear();
  waits.clear();
  transportPausedAt = null;
  if (!snapshot) return true;

  const decoded = decodeLongRunSnapshot(snapshot);
  if (!decoded) return false;

  const now = Date.now();
  const persistedPauseAt = typeof decoded.transportPausedAt === 'number'
    ? decoded.transportPausedAt
    : null;
  transportPausedAt = persistedPauseAt === null ? null : now;

  for (const epoch of decoded.epochs) {
    epochs.set(epoch.sessionId, cloneEpoch(epoch));
  }
  for (const raw of decoded.obligations) {
    let providerBudgetAt = raw.providerBudgetAt ?? raw.createdAt;
    if (raw.reason === 'recovery_resume' && raw.state === 'owed' && persistedPauseAt !== null) {
      providerBudgetAt += Math.max(0, now - Math.max(persistedPauseAt, providerBudgetAt));
    }
    obligations.set(raw.sessionId, cloneWork({
      ...raw,
      providerBudgetAt,
      completionCheckClaimedAt: raw.completionCheckClaimedAt ?? null,
      sourceRequestId: raw.sourceRequestId ?? null
    }));
  }
  for (const wait of decoded.waits) {
    waits.set(wait.sessionId, cloneWait(wait));
  }
  return true;
}

/**
 * Restores the long-run authority ledger from disk without interpreting corruption as emptiness.
 * Backup state is diagnostic recovery evidence only: a stale wait/dispatch checkpoint can never
 * be permission to replay an external mutation.
 */
export async function restoreLongRunDurableState(): Promise<void> {
  restoreLongRunState(null);
  const primary = await readDurableResult<unknown>(LONG_RUN_STATE);
  if (primary.kind === 'missing') {
    const backup = await inspectLongRunBackupHealth();
    if (backup === 'missing') {
      resolveDurableRecoveryIncident(LONG_RUN_RECOVERY_DOMAIN, LONG_RUN_STATE, 'primary');
      return;
    }
    noteLongRunRecovery(
      'primary',
      'orphan_backup',
      'pause',
      'primary long-run ledger is missing while recovery evidence still exists'
    );
    return;
  }
  if (primary.kind === 'io_error') {
    noteLongRunRecovery('primary', 'io_error', 'pause', primary.error);
    await inspectLongRunBackupHealth();
    return;
  }
  if (primary.kind === 'corrupt') {
    noteLongRunRecovery('primary', 'json_corrupt', 'pause', primary.error);
    await inspectLongRunBackupHealth();
    return;
  }

  const decoded = decodeLongRunSnapshot(primary.value);
  if (!decoded || !restoreLongRunState(decoded)) {
    restoreLongRunState(null);
    noteLongRunRecovery('primary', 'schema_invalid', 'pause', 'primary snapshot failed long-run schema validation');
    await inspectLongRunBackupHealth();
    return;
  }

  resolveDurableRecoveryIncident(LONG_RUN_RECOVERY_DOMAIN, LONG_RUN_STATE, 'primary');
  // Checkpoint the validated, authority-equivalent primary generation. The decoder may drop stale
  // terminal history that the legacy restore path never republished, but it preserves savedAt and
  // every live authority row. Restart-only budget normalization stays in memory until a later owner
  // commit, so the recovery copy never invents a generation that was not primary durable authority.
  await checkpointAcceptedLongRun(decoded);
}

function epochForWrite(sessionId: string, conversationId: string, bump: boolean): ExecutionEpoch {
  const current = epochs.get(sessionId);
  if (current && current.conversationId !== conversationId) {
    throw new Error('long_run_executor_mismatch');
  }
  const now = Date.now();
  const next: ExecutionEpoch = current
    ? { ...current, generation: bump ? current.generation + 1 : current.generation, updatedAt: now }
    : { sessionId, conversationId, generation: 1, updatedAt: now };
  epochs.set(sessionId, next);
  return next;
}

export function executionEpochFor(sessionId: string): ExecutionEpoch | null {
  const row = epochs.get(sessionId);
  return row ? cloneEpoch(row) : null;
}

export function captureExecutionTicket(sessionId: string, conversationId: string): ExecutionTicket | null {
  if (longRunRecoveryPaused()) return null;
  const row = epochs.get(sessionId);
  if (!row || row.conversationId !== conversationId) return null;
  return { sessionId, conversationId, generation: row.generation };
}

export function executionTicketCurrent(ticket: ExecutionTicket): boolean {
  if (longRunRecoveryPaused()) return false;
  const row = epochs.get(ticket.sessionId);
  return !!row && row.conversationId === ticket.conversationId && row.generation === ticket.generation;
}

export function longRunWorkFor(sessionId: string): WorkObligation | null {
  if (longRunRecoveryPaused()) return null;
  const row = obligations.get(sessionId);
  return row ? cloneWork(row) : null;
}

export function longRunWaitFor(sessionId: string): LongRunWaitContract | null {
  if (longRunRecoveryPaused()) return null;
  const row = waits.get(sessionId);
  return row ? cloneWait(row) : null;
}

/**
 * Exact stale-workflow fence that does not depend on browser/request-correlation recovery.
 *
 * session_wait durably captured this request id while its caller identity was proven. If a crash
 * loses the separately-debounced correlation index, the same server-side workflow may still call
 * the connector after restart. Matching the durable source id is sufficient to reject that old
 * executor; a different request id is never classified by this helper.
 */
export function longRunSourceRequestFenced(requestId: string | null | undefined): boolean {
  if (!requestId) return false;
  if (longRunRecoveryPaused()) return true;
  for (const work of obligations.values()) {
    if (work.sourceRequestId !== requestId) continue;
    if (work.reason !== 'wait_resolved' && work.reason !== 'wait_failed') continue;
    if (work.state !== 'cancelled') return true;
  }
  return false;
}

export function longRunStatus(sessionId: string): {
  epoch: ExecutionEpoch | null;
  work: WorkObligation | null;
  wait: LongRunWaitContract | null;
} {
  return {
    epoch: executionEpochFor(sessionId),
    work: longRunWorkFor(sessionId),
    wait: longRunWaitFor(sessionId)
  };
}

/** Whether any durable wait/debt can still fence its original provider turn. */
export function anyLongRunWaitActive(): boolean {
  if (longRunRecoveryPaused()) return false;
  for (const work of obligations.values()) {
    const epoch = epochs.get(work.sessionId);
    const wait = waits.get(work.sessionId);
    if (!epoch || !wait ||
        epoch.conversationId !== work.conversationId ||
        wait.conversationId !== work.conversationId ||
        wait.obligationId !== work.id ||
        wait.epochGeneration !== epoch.generation ||
        work.epochGeneration !== epoch.generation) continue;
    if (wait.state === 'waiting' && work.state === 'waiting') return true;
    if (
      (work.reason === 'wait_resolved' || work.reason === 'wait_failed') &&
      !!work.sourceTurnId &&
      (work.state === 'owed' || work.state === 'dispatching' || work.state === 'queued')
    ) return true;
  }
  return false;
}

/**
 * Hard provider-turn boundary for a WaitContract.
 *
 * Waiting always fences ordinary tools. Resolution does not hand authority back to the old source
 * turn: the continuation may already be queued while that provider turn is still winding down.
 * Once the durable recorder proves a different active turn, that new executor may consume the
 * continuation normally.
 */
export function longRunWaitBlocksTools(
  sessionId: string,
  conversationId: string,
  activeTurnId: string | null = null,
  requestId: string | null = null
): boolean {
  if (longRunRecoveryPaused()) return true;
  const epoch = epochs.get(sessionId);
  const work = obligations.get(sessionId);
  const wait = waits.get(sessionId);
  const exact = !!epoch &&
    !!work &&
    !!wait &&
    epoch.conversationId === conversationId &&
    work.conversationId === conversationId &&
    wait.conversationId === conversationId &&
    wait.obligationId === work.id &&
    wait.epochGeneration === epoch.generation &&
    work.epochGeneration === epoch.generation;
  if (!exact) return false;
  if (wait!.state === 'waiting' && work!.state === 'waiting') return true;
  if (
    (work!.reason !== 'wait_resolved' && work!.reason !== 'wait_failed') ||
    (work!.state !== 'owed' && work!.state !== 'dispatching' &&
      work!.state !== 'queued' && work!.state !== 'fulfilled')
  ) return false;
  // New waits pin the exact ChatGPT MCP workflow id. The correlation contract guarantees
  // every connector call in one provider turn carries that same request id, while activeTurnId is
  // a browser/recorder projection that may lag the first call of the replacement turn. Therefore a
  // different proven request id is sufficient to admit the continuation immediately. Only legacy
  // snapshots that predate sourceRequestId fall back to activeTurnId.
  if (work!.sourceRequestId) return !requestId || requestId === work!.sourceRequestId;
  return !!work!.sourceTurnId && activeTurnId === work!.sourceTurnId;
}

export type LongRunMessageAuthority = 'unmanaged' | 'current' | 'stale';

/**
 * Final delivery fence for app-owned worker revival messages.
 *
 * Ordinary agent messages use short random ids. Long-run worker continuations use the full v4
 * UUID minted as WorkObligation.inputId. Treat an orphaned UUID as stale rather than unmanaged:
 * if one durable ledger was lost/corrupt while the broker survived, fail closed instead of
 * turning an old automatic continuation into an ordinary prime message.
 */
export function longRunMessageAuthority(
  inputId: string,
  conversationId: string
): LongRunMessageAuthority {
  const longRunId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(inputId);
  if (!longRunId) return 'unmanaged';
  if (longRunRecoveryPaused()) return 'stale';
  const work = [...obligations.values()].find((row) => row.inputId === inputId);
  if (!work) return 'stale';
  const epoch = epochs.get(work.sessionId);
  return work.conversationId === conversationId &&
    (work.state === 'dispatching' || work.state === 'queued') &&
    !!epoch &&
    epoch.conversationId === conversationId &&
    epoch.generation === work.epochGeneration
    ? 'current'
    : 'stale';
}

export async function armLongRunWaitNow(input: ArmLongRunWaitInput): Promise<LongRunWaitContract> {
  return serial(async () => {
    if (!validSessionId(input.sessionId) || !validConversationId(input.conversationId)) {
      throw new Error('long_run_identity_invalid');
    }
    if (typeof input.sourceTurnId !== 'string' || input.sourceTurnId.length === 0 || input.sourceTurnId.length > 256) {
      throw new Error('long_run_source_turn_invalid');
    }
    if (input.sourceRequestId !== undefined && input.sourceRequestId !== null &&
        (typeof input.sourceRequestId !== 'string' || input.sourceRequestId.length === 0 || input.sourceRequestId.length > 200)) {
      throw new Error('long_run_source_request_invalid');
    }
    if (!validWaitKind(input.kind) || !validProviderData(input.providerData)) {
      throw new Error('long_run_provider_invalid');
    }
    if (input.providerKey !== undefined && input.providerKey !== null &&
        (typeof input.providerKey !== 'string' || input.providerKey.length === 0 || input.providerKey.length > 500)) {
      throw new Error('long_run_provider_key_invalid');
    }
    if (input.kind === 'github_run') {
      if (!input.repository || !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(input.repository) ||
          typeof input.runId !== 'number' || !Number.isSafeInteger(input.runId) || input.runId <= 0) {
        throw new Error('long_run_github_wait_invalid');
      }
    } else if (input.kind === 'process') {
      if (typeof input.processId !== 'number' || !Number.isSafeInteger(input.processId) || input.processId <= 0) {
        throw new Error('long_run_process_wait_invalid');
      }
    } else if (input.kind === 'timer') {
      if (typeof input.dueAt !== 'number' || !Number.isSafeInteger(input.dueAt) || input.dueAt <= Date.now()) {
        throw new Error('long_run_timer_wait_invalid');
      }
    } else if (!input.providerKey) {
      // Custom wait adapters must provide a stable semantic key so ACK loss/retries cannot create
      // multiple waits for the same external condition.
      throw new Error('long_run_custom_wait_key_required');
    }

    const providerKey = input.providerKey ??
      (input.kind === 'github_run' ? `github:${input.repository}:${input.runId}`
        : input.kind === 'process' ? `process:${input.processId}`
          : `timer:${input.dueAt}`);

    const beforeEpoch = epochs.get(input.sessionId);
    const beforeWork = obligations.get(input.sessionId);
    const beforeWait = waits.get(input.sessionId);
    if (beforeWait?.state === 'waiting') {
      // A lost tool response may cause the model to repeat the exact session_wait call. The source
      // turn and external target are the semantic identity. Timer retries intentionally ignore a
      // freshly recomputed dueAt, otherwise one transport retry silently extends the deadline.
      const heldProviderKey = beforeWait.providerKey ??
        (beforeWait.kind === 'github_run' ? `github:${beforeWait.repository}:${beforeWait.runId}`
          : beforeWait.kind === 'process' ? `process:${beforeWait.processId}`
            : beforeWait.kind === 'timer' ? `timer:${beforeWait.dueAt}`
              : null);
      const sameProviderTarget = input.kind === 'timer'
        // Timer retries recompute "now + seconds"; the already-durable original deadline wins.
        ? true
        : heldProviderKey === providerKey;
      const sameTarget =
        beforeWait.conversationId === input.conversationId &&
        beforeWait.kind === input.kind &&
        sameProviderTarget &&
        beforeWork?.state === 'waiting' &&
        beforeWait.obligationId === beforeWork.id &&
        beforeWork.sourceTurnId === input.sourceTurnId &&
        (input.sourceRequestId == null || beforeWork.sourceRequestId === input.sourceRequestId);
      if (sameTarget) return cloneWait(beforeWait);
      throw new Error('long_run_wait_already_active');
    }
    const epoch = epochForWrite(input.sessionId, input.conversationId, true);
    const now = Date.now();
    const obligation: WorkObligation = {
      id: randomUUID(),
      sessionId: input.sessionId,
      conversationId: input.conversationId,
      epochGeneration: epoch.generation,
      reason: 'wait_resolved',
      state: 'waiting',
      sourceTurnId: input.sourceTurnId,
      sourceRequestId: input.sourceRequestId ?? null,
      source: providerKey,
      inputId: null,
      result: null,
      createdAt: now,
      updatedAt: now,
      issuedAt: null
    };
    const wait: LongRunWaitContract = {
      id: randomUUID(),
      sessionId: input.sessionId,
      conversationId: input.conversationId,
      epochGeneration: epoch.generation,
      obligationId: obligation.id,
      kind: input.kind,
      providerKey,
      providerData: input.providerData ? { ...input.providerData } : null,
      repository: input.kind === 'github_run' ? input.repository! : null,
      runId: input.kind === 'github_run' ? input.runId! : null,
      processId: input.kind === 'process' ? input.processId! : null,
      dueAt: input.kind === 'timer' ? input.dueAt! : null,
      description: clip(input.description, 300),
      state: 'waiting',
      attempts: 0,
      nextCheckAt: now,
      lastError: null,
      result: null,
      createdAt: now,
      updatedAt: now
    };
    obligations.set(input.sessionId, obligation);
    waits.set(input.sessionId, wait);
    try {
      await commitLongRunNow();
    } catch (error) {
      if (beforeEpoch) epochs.set(input.sessionId, beforeEpoch); else epochs.delete(input.sessionId);
      if (beforeWork) obligations.set(input.sessionId, beforeWork); else obligations.delete(input.sessionId);
      if (beforeWait) waits.set(input.sessionId, beforeWait); else waits.delete(input.sessionId);
      persistSoon();
      throw error;
    }
    return cloneWait(wait);
  });
}

export async function deferLongRunWaitNow(
  sessionId: string,
  waitId: string,
  ticket: ExecutionTicket,
  nextCheckAt: number,
  error: string | null
): Promise<boolean> {
  return serial(async () => {
    const wait = waits.get(sessionId);
    if (!wait || wait.id !== waitId || wait.state !== 'waiting' || !executionTicketCurrent(ticket) ||
        wait.epochGeneration !== ticket.generation) return false;
    const before = cloneWait(wait);
    const next = {
      ...wait,
      // attempts is the consecutive monitor-failure budget. A successful observation that merely
      // says "still pending" resets that budget; otherwise a long healthy CI run would make one
      // later transient gh/process error look like the sixth failure.
      attempts: error ? wait.attempts + 1 : 0,
      nextCheckAt: Math.max(Date.now(), nextCheckAt),
      lastError: clip(error, 500),
      updatedAt: Date.now()
    };
    waits.set(sessionId, next);
    try { await commitLongRunNow(); }
    catch (err) { waits.set(sessionId, before); persistSoon(); throw err; }
    return true;
  });
}

export async function resolveLongRunWaitNow(
  sessionId: string,
  waitId: string,
  ticket: ExecutionTicket,
  result: string,
  failed = false
): Promise<boolean> {
  return serial(async () => {
    const wait = waits.get(sessionId);
    const work = obligations.get(sessionId);
    if (!wait || !work || wait.id !== waitId || wait.obligationId !== work.id ||
        wait.state !== 'waiting' || work.state !== 'waiting' || !executionTicketCurrent(ticket) ||
        wait.epochGeneration !== ticket.generation || work.epochGeneration !== ticket.generation) return false;
    const beforeWait = cloneWait(wait);
    const beforeWork = cloneWork(work);
    const now = Date.now();
    waits.set(sessionId, {
      ...wait,
      state: failed ? 'failed' : 'resolved',
      result: clip(result, 2_000),
      lastError: failed ? clip(result, 500) : null,
      updatedAt: now
    });
    obligations.set(sessionId, {
      ...work,
      reason: failed ? 'wait_failed' : 'wait_resolved',
      state: 'owed',
      result: clip(result, 2_000),
      updatedAt: now
    });
    try { await commitLongRunNow(); }
    catch (err) {
      waits.set(sessionId, beforeWait);
      obligations.set(sessionId, beforeWork);
      persistSoon();
      throw err;
    }
    return true;
  });
}

export async function cancelLongRunNow(
  sessionId: string,
  conversationId: string,
  reason = 'cancelled'
): Promise<boolean> {
  return serial(async () => {
    const epoch = epochs.get(sessionId);
    const heldWork = obligations.get(sessionId);
    const heldWait = waits.get(sessionId);
    if (!epoch && !heldWork && !heldWait) return true;
    if (epoch && epoch.conversationId !== conversationId) return false;
    // Cancellation is also retry-safe: an ACK loss must not manufacture a fresh execution
    // generation after authority was already revoked.
    if ((heldWork?.state === 'cancelled' || !heldWork) &&
        (heldWait?.state === 'cancelled' || !heldWait)) return true;
    const beforeEpoch = epoch ? cloneEpoch(epoch) : null;
    const beforeWork = heldWork ? cloneWork(heldWork) : null;
    const beforeWait = heldWait ? cloneWait(heldWait) : null;
    const nextEpoch = epochForWrite(sessionId, conversationId, true);
    const now = Date.now();
    const work = obligations.get(sessionId);
    const wait = waits.get(sessionId);
    if (work) obligations.set(sessionId, { ...work, epochGeneration: nextEpoch.generation, state: 'cancelled',
      result: clip(reason, 500), updatedAt: now });
    if (wait) waits.set(sessionId, { ...wait, epochGeneration: nextEpoch.generation, state: 'cancelled',
      result: clip(reason, 500), updatedAt: now });
    try { await commitLongRunNow(); }
    catch (err) {
      if (beforeEpoch) epochs.set(sessionId, beforeEpoch); else epochs.delete(sessionId);
      if (beforeWork) obligations.set(sessionId, beforeWork); else obligations.delete(sessionId);
      if (beforeWait) waits.set(sessionId, beforeWait); else waits.delete(sessionId);
      persistSoon();
      throw err;
    }
    return true;
  });
}

export async function ensureRecoveryWorkNow(
  sessionId: string,
  conversationId: string,
  source: string,
  sourceTurnId: string | null = null
): Promise<WorkObligation | null> {
  return serial(async () => {
    if (!validSessionId(sessionId) || !validConversationId(conversationId)) return null;
    const activeWait = waits.get(sessionId);
    if (activeWait?.state === 'waiting') return obligations.get(sessionId) ? cloneWork(obligations.get(sessionId)!) : null;

    const beforeEpoch = epochs.get(sessionId);
    const beforeWork = obligations.get(sessionId);
    const epoch = epochForWrite(sessionId, conversationId, false);
    const existing = obligations.get(sessionId);
    if (existing && existing.epochGeneration === epoch.generation &&
        existing.state !== 'cancelled' && existing.state !== 'fulfilled') {
      // A resolved/failed external wait is already the concrete continuation this durable task
      // owes. Recovery must not replace its CI/process/timer result with a generic "continue"
      // message. Likewise, once any recovery continuation owns a stable outbox id, replacing it
      // would create a second delivery identity after an ambiguous enqueue/send boundary.
      if (existing.reason !== 'recovery_resume' ||
          existing.state === 'dispatching' || existing.state === 'queued' ||
          existing.source === source) {
        return cloneWork(existing);
      }
      // An older recovery episode that never reached dispatch may be refreshed below so the new
      // executor receives a fresh probation clock and source identity.
    }

    const now = Date.now();
    const next: WorkObligation = {
      id: randomUUID(),
      sessionId,
      conversationId,
      epochGeneration: epoch.generation,
      reason: 'recovery_resume',
      state: 'owed',
      sourceTurnId,
      sourceRequestId: null,
      source: clip(source, 300),
      inputId: null,
      result: null,
      createdAt: now,
      providerBudgetAt: now,
      updatedAt: now,
      issuedAt: null
    };
    obligations.set(sessionId, next);
    try { await commitLongRunNow(); }
    catch (err) {
      if (beforeEpoch) epochs.set(sessionId, beforeEpoch); else epochs.delete(sessionId);
      if (beforeWork) obligations.set(sessionId, beforeWork); else obligations.delete(sessionId);
      persistSoon();
      throw err;
    }
    return cloneWork(next);
  });
}

export async function moveLongRunStateNow(
  sessionId: string,
  fromConversationId: string,
  toConversationId: string
): Promise<boolean> {
  return serial(async () => {
    const current = epochs.get(sessionId);
    if (!current) return true;
    if (current.conversationId === toConversationId) {
      // This API is a durability barrier, not merely an in-memory move. A previous attempt may
      // have published B in memory after its fsync failed; an idempotent retry must therefore
      // write the current snapshot now rather than treating "already B" as proof of durability.
      await commitLongRunNow();
      return true;
    }
    if (current.conversationId !== fromConversationId) return false;

    const beforeEpoch = cloneEpoch(current);
    const beforeWork = obligations.get(sessionId) ? cloneWork(obligations.get(sessionId)!) : null;
    const beforeWait = waits.get(sessionId) ? cloneWait(waits.get(sessionId)!) : null;
    const now = Date.now();
    const generation = current.generation + 1;
    epochs.set(sessionId, { sessionId, conversationId: toConversationId, generation, updatedAt: now });
    const work = obligations.get(sessionId);
    const wait = waits.get(sessionId);
    if (work && work.state !== 'fulfilled' && work.state !== 'cancelled') {
      obligations.set(sessionId, { ...work, conversationId: toConversationId, epochGeneration: generation, updatedAt: now });
    }
    if (wait && wait.state === 'waiting') {
      waits.set(sessionId, { ...wait, conversationId: toConversationId, epochGeneration: generation, updatedAt: now });
    }
    try { await commitLongRunNow(); }
    catch (err) {
      epochs.set(sessionId, beforeEpoch);
      if (beforeWork) obligations.set(sessionId, beforeWork); else obligations.delete(sessionId);
      if (beforeWait) waits.set(sessionId, beforeWait); else waits.delete(sessionId);
      persistSoon();
      throw err;
    }
    return true;
  });
}

/** Non-blocking projection for Compact & Resume; Emergency Resume uses the fsynced variant above. */
export function moveLongRunState(
  sessionId: string,
  fromConversationId: string,
  toConversationId: string
): boolean {
  if (longRunRecoveryPaused()) return false;
  const current = epochs.get(sessionId);
  if (!current) return true;
  if (current.conversationId === toConversationId) return true;
  if (current.conversationId !== fromConversationId) return false;
  const generation = current.generation + 1;
  const now = Date.now();
  epochs.set(sessionId, { sessionId, conversationId: toConversationId, generation, updatedAt: now });
  const work = obligations.get(sessionId);
  const wait = waits.get(sessionId);
  if (work && work.state !== 'fulfilled' && work.state !== 'cancelled') {
    obligations.set(sessionId, { ...work, conversationId: toConversationId, epochGeneration: generation, updatedAt: now });
  }
  if (wait && wait.state === 'waiting') {
    waits.set(sessionId, { ...wait, conversationId: toConversationId, epochGeneration: generation, updatedAt: now });
  }
  persistSoon();
  return true;
}

export function dueLongRunWaits(now = Date.now()): LongRunWaitContract[] {
  if (longRunRecoveryPaused()) return [];
  return [...waits.values()]
    .filter((row) => row.state === 'waiting' && row.nextCheckAt <= now)
    .map(cloneWait);
}

export function dispatchableLongRunWork(): WorkObligation[] {
  if (longRunRecoveryPaused()) return [];
  return [...obligations.values()]
    .filter((row) => row.state === 'owed' || row.state === 'dispatching')
    .map(cloneWork);
}

/**
 * Persists the automatic Project Runtime evaluation intent before any verifier command can run.
 *
 * The claim intentionally survives executor rebinds for the same obligation. A rebind may happen
 * while an old verifier process is already running, so clearing the claim would make the new
 * executor replay an ambiguous side effect. New obligations receive new ids and therefore a fresh
 * completion opportunity.
 */
export async function claimProjectCompletionCheckNow(
  sessionId: string,
  obligationId: string,
  ticket: ExecutionTicket
): Promise<boolean> {
  return serial(async () => {
    const work = obligations.get(sessionId);
    if (!work || work.id !== obligationId || work.state !== 'owed' ||
        !executionTicketCurrent(ticket) || work.epochGeneration !== ticket.generation ||
        (work.completionCheckClaimedAt ?? null) !== null) return false;
    const before = cloneWork(work);
    obligations.set(sessionId, {
      ...work,
      completionCheckClaimedAt: Date.now(),
      updatedAt: Date.now()
    });
    try { await commitLongRunNow(); }
    catch (err) { obligations.set(sessionId, before); persistSoon(); throw err; }
    return true;
  });
}

/**
 * Closes an owed continuation before publication when independent machine evidence proves the
 * project is already complete. Only the pre-dispatch state is eligible: once input dispatch has
 * begun, the outbox/broker owns reconciliation and this function must not retract it.
 */
export async function fulfillOwedLongRunWorkNow(
  sessionId: string,
  obligationId: string,
  ticket: ExecutionTicket
): Promise<boolean> {
  return serial(async () => {
    const work = obligations.get(sessionId);
    if (!work || work.id !== obligationId || work.state !== 'owed' ||
        !executionTicketCurrent(ticket) || work.epochGeneration !== ticket.generation) return false;
    const before = cloneWork(work);
    obligations.set(sessionId, { ...work, state: 'fulfilled', updatedAt: Date.now() });
    try { await commitLongRunNow(); }
    catch (err) { obligations.set(sessionId, before); persistSoon(); throw err; }
    return true;
  });
}

export async function leaseLongRunWorkNow(
  sessionId: string,
  conversationId: string
): Promise<{ work: WorkObligation; ticket: ExecutionTicket } | null> {
  return serial(async () => {
    const epoch = epochs.get(sessionId);
    const work = obligations.get(sessionId);
    if (!epoch || !work || epoch.conversationId !== conversationId ||
        work.conversationId !== conversationId || work.epochGeneration !== epoch.generation ||
        (work.state !== 'owed' && work.state !== 'dispatching')) return null;

    if (work.state === 'dispatching' && work.inputId) {
      return { work: cloneWork(work), ticket: { sessionId, conversationId, generation: epoch.generation } };
    }

    const before = cloneWork(work);
    const next: WorkObligation = {
      ...work,
      state: 'dispatching',
      inputId: work.inputId ?? randomUUID(),
      issuedAt: work.issuedAt ?? Date.now(),
      updatedAt: Date.now()
    };
    obligations.set(sessionId, next);
    try { await commitLongRunNow(); }
    catch (err) { obligations.set(sessionId, before); persistSoon(); throw err; }
    return {
      work: cloneWork(next),
      ticket: { sessionId, conversationId, generation: epoch.generation }
    };
  });
}

export async function markLongRunWorkQueuedNow(
  sessionId: string,
  obligationId: string,
  ticket: ExecutionTicket,
  inputId: string
): Promise<boolean> {
  return serial(async () => {
    const work = obligations.get(sessionId);
    if (!work || work.id !== obligationId || work.state !== 'dispatching' ||
        work.inputId !== inputId || !executionTicketCurrent(ticket) ||
        work.epochGeneration !== ticket.generation) return false;
    const before = cloneWork(work);
    obligations.set(sessionId, { ...work, state: 'queued', updatedAt: Date.now() });
    try { await commitLongRunNow(); }
    catch (err) { obligations.set(sessionId, before); persistSoon(); throw err; }
    return true;
  });
}

export async function certifyLongRunProgressNow(certificate: ProgressCertificate): Promise<boolean> {
  const {
    sessionId,
    conversationId,
    observedAt: progressAt,
    turnId,
    evidence,
    requestId = null
  } = certificate;
  return serial(async () => {
    const epoch = epochs.get(sessionId);
    const work = obligations.get(sessionId);
    if (!epoch || !work || epoch.conversationId !== conversationId || work.conversationId !== conversationId ||
        work.epochGeneration !== epoch.generation ||
        !['owed', 'dispatching', 'queued'].includes(work.state) ||
        !Number.isFinite(progressAt) || progressAt <= work.createdAt) return false;
    // Recovery continuation is proven only by a new local MCP call. A provider final can be the
    // short "recovered" answer that exposed the original liveness bug and must not erase debt.
    if (work.reason === 'recovery_resume' && evidence !== 'mcp') return false;
    if (work.reason === 'wait_resolved' || work.reason === 'wait_failed') {
      // MCP progress follows the same exact workflow boundary as admission. For new waits, a
      // different proven request id certifies the replacement provider turn even if the browser's
      // activeTurnId projection still names the source briefly. Legacy waits without request
      // identity retain the conservative source-turn check. Terminal-only evidence has no request
      // id, so it must still prove a different durable turn.
      if (evidence === 'mcp' && work.sourceRequestId) {
        if (!requestId || requestId === work.sourceRequestId) return false;
      } else if (work.sourceTurnId && (!turnId || turnId === work.sourceTurnId)) {
        return false;
      }
    }

    const before = cloneWork(work);
    obligations.set(sessionId, { ...work, state: 'fulfilled', updatedAt: Date.now() });
    try { await commitLongRunNow(); }
    catch (err) { obligations.set(sessionId, before); persistSoon(); throw err; }
    return true;
  });
}

/** Backward-compatible adapter for existing browser/MCP progress call sites. */
export function noteLongRunProgressNow(
  sessionId: string,
  conversationId: string,
  progressAt: number,
  turnId: string | null,
  evidence: 'mcp' | 'terminal',
  requestId: string | null = null
): Promise<boolean> {
  return certifyLongRunProgressNow({
    sessionId,
    conversationId,
    observedAt: progressAt,
    turnId,
    evidence,
    requestId
  });
}

export function resetLongRunStateForTests(): void {
  epochs.clear();
  obligations.clear();
  waits.clear();
  transportPausedAt = null;
  chain = Promise.resolve();
}
