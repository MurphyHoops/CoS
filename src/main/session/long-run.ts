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
import { writeDurableNow, writeDurableSoon } from '../durable.js';

export const LONG_RUN_STATE = 'long-run';

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

export interface WorkObligation {
  id: string;
  sessionId: string;
  conversationId: string;
  epochGeneration: number;
  reason: LongRunWorkReason;
  state: LongRunWorkState;
  sourceTurnId: string | null;
  source: string | null;
  inputId: string | null;
  result: string | null;
  createdAt: number;
  updatedAt: number;
  issuedAt: number | null;
}

export type LongRunWaitKind = 'github_run' | 'process' | 'timer';
export type LongRunWaitState = 'waiting' | 'resolved' | 'failed' | 'cancelled';

export interface LongRunWaitContract {
  id: string;
  sessionId: string;
  conversationId: string;
  epochGeneration: number;
  obligationId: string;
  kind: LongRunWaitKind;
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
}

export interface ArmLongRunWaitInput {
  sessionId: string;
  conversationId: string;
  sourceTurnId: string | null;
  kind: LongRunWaitKind;
  repository?: string | null;
  runId?: number | null;
  processId?: number | null;
  dueAt?: number | null;
  description?: string | null;
}

const epochs = new Map<string, ExecutionEpoch>();
const obligations = new Map<string, WorkObligation>();
const waits = new Map<string, LongRunWaitContract>();
let chain: Promise<unknown> = Promise.resolve();

function serial<T>(work: () => Promise<T>): Promise<T> {
  const next = chain.then(work, work);
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

function clip(value: string | null | undefined, max = 500): string | null {
  if (!value) return null;
  return value.slice(0, max);
}

function cloneEpoch(row: ExecutionEpoch): ExecutionEpoch { return { ...row }; }
function cloneWork(row: WorkObligation): WorkObligation { return { ...row }; }
function cloneWait(row: LongRunWaitContract): LongRunWaitContract { return { ...row }; }

export function snapshotLongRunState(): LongRunSnapshot {
  return {
    version: 1,
    savedAt: Date.now(),
    epochs: [...epochs.values()].map(cloneEpoch),
    obligations: [...obligations.values()].map(cloneWork),
    waits: [...waits.values()].map(cloneWait)
  };
}

function persistSoon(): void {
  writeDurableSoon(LONG_RUN_STATE, snapshotLongRunState());
}

export function restoreLongRunState(snapshot: LongRunSnapshot | null): void {
  epochs.clear();
  obligations.clear();
  waits.clear();
  if (!snapshot || snapshot.version !== 1) return;

  for (const raw of Array.isArray(snapshot.epochs) ? snapshot.epochs : []) {
    if (!validSessionId(raw?.sessionId) || !validConversationId(raw?.conversationId) ||
        !validGeneration(raw?.generation) || !Number.isSafeInteger(raw?.updatedAt) || raw.updatedAt <= 0) continue;
    const current = epochs.get(raw.sessionId);
    if (!current || raw.generation > current.generation ||
        (raw.generation === current.generation && raw.updatedAt > current.updatedAt)) {
      epochs.set(raw.sessionId, cloneEpoch(raw));
    }
  }

  for (const raw of Array.isArray(snapshot.obligations) ? snapshot.obligations : []) {
    if (!raw || !validSessionId(raw.sessionId) || !validConversationId(raw.conversationId) ||
        !validGeneration(raw.epochGeneration) || typeof raw.id !== 'string' || !raw.id ||
        !['recovery_resume', 'wait_resolved', 'wait_failed'].includes(raw.reason) ||
        !['waiting', 'owed', 'dispatching', 'queued', 'fulfilled', 'cancelled'].includes(raw.state) ||
        !Number.isSafeInteger(raw.createdAt) || raw.createdAt <= 0 ||
        !Number.isSafeInteger(raw.updatedAt) || raw.updatedAt <= 0) continue;
    const epoch = epochs.get(raw.sessionId);
    if (!epoch || epoch.conversationId !== raw.conversationId || epoch.generation !== raw.epochGeneration) continue;
    const current = obligations.get(raw.sessionId);
    if (!current || raw.updatedAt > current.updatedAt) obligations.set(raw.sessionId, cloneWork(raw));
  }

  for (const raw of Array.isArray(snapshot.waits) ? snapshot.waits : []) {
    if (!raw || !validSessionId(raw.sessionId) || !validConversationId(raw.conversationId) ||
        !validGeneration(raw.epochGeneration) || typeof raw.id !== 'string' || !raw.id ||
        !['github_run', 'process', 'timer'].includes(raw.kind) ||
        !['waiting', 'resolved', 'failed', 'cancelled'].includes(raw.state) ||
        typeof raw.obligationId !== 'string' || !raw.obligationId ||
        !Number.isSafeInteger(raw.createdAt) || raw.createdAt <= 0 ||
        !Number.isSafeInteger(raw.updatedAt) || raw.updatedAt <= 0 ||
        !Number.isSafeInteger(raw.nextCheckAt) || raw.nextCheckAt < 0) continue;
    const epoch = epochs.get(raw.sessionId);
    if (!epoch || epoch.conversationId !== raw.conversationId || epoch.generation !== raw.epochGeneration) continue;
    const current = waits.get(raw.sessionId);
    if (!current || raw.updatedAt > current.updatedAt) waits.set(raw.sessionId, cloneWait(raw));
  }
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
  const row = epochs.get(sessionId);
  if (!row || row.conversationId !== conversationId) return null;
  return { sessionId, conversationId, generation: row.generation };
}

export function executionTicketCurrent(ticket: ExecutionTicket): boolean {
  const row = epochs.get(ticket.sessionId);
  return !!row && row.conversationId === ticket.conversationId && row.generation === ticket.generation;
}

export function longRunWorkFor(sessionId: string): WorkObligation | null {
  const row = obligations.get(sessionId);
  return row ? cloneWork(row) : null;
}

export function longRunWaitFor(sessionId: string): LongRunWaitContract | null {
  const row = waits.get(sessionId);
  return row ? cloneWait(row) : null;
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

export async function armLongRunWaitNow(input: ArmLongRunWaitInput): Promise<LongRunWaitContract> {
  return serial(async () => {
    if (!validSessionId(input.sessionId) || !validConversationId(input.conversationId)) {
      throw new Error('long_run_identity_invalid');
    }
    if (input.kind === 'github_run') {
      if (!input.repository || !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(input.repository) ||
          !Number.isSafeInteger(input.runId) || Number(input.runId) <= 0) throw new Error('long_run_github_wait_invalid');
    } else if (input.kind === 'process') {
      if (!Number.isSafeInteger(input.processId) || Number(input.processId) <= 0) throw new Error('long_run_process_wait_invalid');
    } else if (input.kind === 'timer') {
      if (!Number.isSafeInteger(input.dueAt) || Number(input.dueAt) <= Date.now()) throw new Error('long_run_timer_wait_invalid');
    }

    const beforeEpoch = epochs.get(input.sessionId);
    const beforeWork = obligations.get(input.sessionId);
    const beforeWait = waits.get(input.sessionId);
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
      source: input.kind === 'github_run' ? `github:${input.repository}:${input.runId}`
        : input.kind === 'process' ? `process:${input.processId}`
          : `timer:${input.dueAt}`,
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
      await writeDurableNow(LONG_RUN_STATE, snapshotLongRunState());
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
      attempts: wait.attempts + 1,
      nextCheckAt: Math.max(Date.now(), nextCheckAt),
      lastError: clip(error, 500),
      updatedAt: Date.now()
    };
    waits.set(sessionId, next);
    try { await writeDurableNow(LONG_RUN_STATE, snapshotLongRunState()); }
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
    try { await writeDurableNow(LONG_RUN_STATE, snapshotLongRunState()); }
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
    if (epoch && epoch.conversationId !== conversationId) return false;
    const beforeEpoch = epoch ? cloneEpoch(epoch) : null;
    const beforeWork = obligations.get(sessionId) ? cloneWork(obligations.get(sessionId)!) : null;
    const beforeWait = waits.get(sessionId) ? cloneWait(waits.get(sessionId)!) : null;
    const nextEpoch = epochForWrite(sessionId, conversationId, true);
    const now = Date.now();
    const work = obligations.get(sessionId);
    const wait = waits.get(sessionId);
    if (work) obligations.set(sessionId, { ...work, epochGeneration: nextEpoch.generation, state: 'cancelled',
      result: clip(reason, 500), updatedAt: now });
    if (wait) waits.set(sessionId, { ...wait, epochGeneration: nextEpoch.generation, state: 'cancelled',
      result: clip(reason, 500), updatedAt: now });
    try { await writeDurableNow(LONG_RUN_STATE, snapshotLongRunState()); }
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
    if (existing && existing.epochGeneration === epoch.generation && existing.reason === 'recovery_resume' &&
        existing.source === source && existing.state !== 'cancelled' && existing.state !== 'fulfilled') {
      return cloneWork(existing);
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
      source: clip(source, 300),
      inputId: null,
      result: null,
      createdAt: now,
      updatedAt: now,
      issuedAt: null
    };
    obligations.set(sessionId, next);
    try { await writeDurableNow(LONG_RUN_STATE, snapshotLongRunState()); }
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
    if (current.conversationId === toConversationId) return true;
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
    try { await writeDurableNow(LONG_RUN_STATE, snapshotLongRunState()); }
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
  return [...waits.values()]
    .filter((row) => row.state === 'waiting' && row.nextCheckAt <= now)
    .map(cloneWait);
}

export function dispatchableLongRunWork(): WorkObligation[] {
  return [...obligations.values()]
    .filter((row) => row.state === 'owed' || row.state === 'dispatching')
    .map(cloneWork);
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
    try { await writeDurableNow(LONG_RUN_STATE, snapshotLongRunState()); }
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
    try { await writeDurableNow(LONG_RUN_STATE, snapshotLongRunState()); }
    catch (err) { obligations.set(sessionId, before); persistSoon(); throw err; }
    return true;
  });
}

export async function noteLongRunProgressNow(
  sessionId: string,
  conversationId: string,
  progressAt: number,
  turnId: string | null,
  evidence: 'mcp' | 'terminal'
): Promise<boolean> {
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
    if ((work.reason === 'wait_resolved' || work.reason === 'wait_failed') &&
        work.sourceTurnId && (!turnId || turnId === work.sourceTurnId)) return false;

    const before = cloneWork(work);
    obligations.set(sessionId, { ...work, state: 'fulfilled', updatedAt: Date.now() });
    try { await writeDurableNow(LONG_RUN_STATE, snapshotLongRunState()); }
    catch (err) { obligations.set(sessionId, before); persistSoon(); throw err; }
    return true;
  });
}

export function resetLongRunStateForTests(): void {
  epochs.clear();
  obligations.clear();
  waits.clear();
  chain = Promise.resolve();
}
