/**
 * Local long-run supervisor.
 *
 * The model may register a durable external wait and finish its turn.  This process owns the
 * polling afterwards, then publishes one stable continuation through the existing input outbox.
 * No provider turn has to remain open merely to poll CI or a long-running local process.
 */

import { runCommand } from '../exec.js';
import { goalSwitchFor } from '../goal.js';
import { logInfo, logWarn } from '../logger.js';
import { backgroundExecObligations, execOwner } from '../codex/ownership.js';
import { enqueueInput } from './input.js';
import { getSession } from './store.js';
import {
  captureExecutionTicket,
  deferLongRunWaitNow,
  dispatchableLongRunWork,
  dueLongRunWaits,
  executionTicketCurrent,
  leaseLongRunWorkNow,
  markLongRunWorkQueuedNow,
  resolveLongRunWaitNow,
  type ExecutionTicket,
  type LongRunWaitContract,
  type WorkObligation
} from './long-run.js';

const LONG_RUN_POLL_MS = 5_000;
const RECOVERY_CONTINUATION_GRACE_MS = 90_000;
const WAIT_RETRY_BASE_MS = 5_000;
const WAIT_RETRY_MAX_MS = 60_000;
const WAIT_FAILURE_LIMIT = 6;

let timer: NodeJS.Timeout | null = null;
let pollInFlight: Promise<void> | null = null;
let stopped = true;

function retryDelay(attempts: number): number {
  return Math.min(WAIT_RETRY_MAX_MS, WAIT_RETRY_BASE_MS * 2 ** Math.min(4, Math.max(0, attempts)));
}

function waitResultText(wait: LongRunWaitContract, detail: string): string {
  if (wait.kind === 'github_run') return `GitHub Actions run ${wait.runId} for ${wait.repository}: ${detail}`;
  if (wait.kind === 'process') return `Background process session ${wait.processId}: ${detail}`;
  return `Timer wait completed: ${detail}`;
}

async function inspectGithubRun(wait: LongRunWaitContract): Promise<
  { kind: 'pending' } | { kind: 'resolved'; result: string; failed: boolean } | { kind: 'error'; error: string }
> {
  const result = await runCommand(
    'gh',
    ['run', 'view', String(wait.runId), '--repo', wait.repository!, '--json', 'status,conclusion'],
    process.cwd(),
    10_000
  );
  if (result.timedOut) return { kind: 'error', error: 'GitHub status check timed out.' };
  if (result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout || 'gh run view failed').trim().slice(0, 500);
    return { kind: 'error', error: detail };
  }
  try {
    const row = JSON.parse(result.stdout) as { status?: string; conclusion?: string | null };
    if (row.status !== 'completed') return { kind: 'pending' };
    const conclusion = row.conclusion || 'unknown';
    return {
      kind: 'resolved',
      result: waitResultText(wait, `completed with conclusion ${conclusion}`),
      failed: conclusion !== 'success'
    };
  } catch {
    return { kind: 'error', error: 'GitHub status response was not valid JSON.' };
  }
}

function inspectProcess(wait: LongRunWaitContract):
  { kind: 'pending' } | { kind: 'resolved'; result: string; failed: boolean } {
  const state = backgroundExecObligations(wait.sessionId);
  if (state.running.includes(wait.processId!)) return { kind: 'pending' };
  const exited = state.exitedUnread.find((row) => row.processId === wait.processId);
  if (exited) {
    return {
      kind: 'resolved',
      result: waitResultText(wait, `exited with code ${exited.exitCode ?? 'unknown'}; its retained output will be delivered by the normal exec result channel`),
      failed: exited.exitCode !== 0
    };
  }
  const owner = execOwner(wait.processId!);
  return {
    kind: 'resolved',
    result: waitResultText(
      wait,
      owner && owner !== wait.sessionId
        ? 'is no longer owned by this durable session; reconcile state before acting'
        : 'is no longer retained by this CoS process; reconcile files/process state before deciding whether any command needs to run again'
    ),
    failed: true
  };
}

async function inspectWait(wait: LongRunWaitContract, ticket: ExecutionTicket, now: number): Promise<void> {
  if (!executionTicketCurrent(ticket)) return;

  if (wait.kind === 'timer') {
    if ((wait.dueAt ?? Number.MAX_SAFE_INTEGER) > now) {
      await deferLongRunWaitNow(wait.sessionId, wait.id, ticket, wait.dueAt!, null);
      return;
    }
    await resolveLongRunWaitNow(wait.sessionId, wait.id, ticket, waitResultText(wait, 'deadline reached'), false);
    return;
  }

  let verdict:
    | { kind: 'pending' }
    | { kind: 'resolved'; result: string; failed: boolean }
    | { kind: 'error'; error: string };
  if (wait.kind === 'github_run') verdict = await inspectGithubRun(wait);
  else verdict = inspectProcess(wait);

  if (!executionTicketCurrent(ticket)) return;
  if (verdict.kind === 'pending') {
    await deferLongRunWaitNow(wait.sessionId, wait.id, ticket, now + retryDelay(wait.attempts), null);
    return;
  }
  if (verdict.kind === 'resolved') {
    await resolveLongRunWaitNow(wait.sessionId, wait.id, ticket, verdict.result, verdict.failed);
    logInfo(`long-run: wait ${wait.id} resolved for session ${wait.sessionId}`);
    return;
  }

  if (wait.attempts + 1 >= WAIT_FAILURE_LIMIT) {
    await resolveLongRunWaitNow(
      wait.sessionId,
      wait.id,
      ticket,
      `Local wait monitor could not verify the external condition after ${WAIT_FAILURE_LIMIT} attempts: ${verdict.error}. Reconcile it manually once, then continue the durable task.`,
      true
    );
    logWarn(`long-run: wait ${wait.id} monitor failed closed after ${WAIT_FAILURE_LIMIT} attempts`);
    return;
  }
  await deferLongRunWaitNow(
    wait.sessionId,
    wait.id,
    ticket,
    now + retryDelay(wait.attempts),
    verdict.error
  );
}

function continuationText(work: WorkObligation): string {
  if (work.reason === 'recovery_resume') {
    return (
      `[[CLF-CONTINUE:${work.id}]]\n` +
      'The durable Goal/task remains active after executor recovery. Continue autonomously from current durable state. ' +
      'Reconcile completed tool receipts, git/files/processes, CI and worker state before mutations. ' +
      'Do not repeat completed or ambiguous side effects. Proceed from the first still-needed action.'
    );
  }
  const result = work.result ?? 'The local wait condition changed.';
  return (
    `[[CLF-WAIT-RESOLVED:${work.id}]]\n` +
    `${result}\n\n` +
    'Continue the same durable task from the first still-needed action. Reconcile current state before mutations and do not repeat completed or ambiguous side effects.'
  );
}

async function dispatchWork(work: WorkObligation, now: number): Promise<void> {
  const session = await getSession(work.sessionId);
  if (!session?.conversationId || session.conversationId !== work.conversationId) return;
  const recovery = session.recovery;
  if (recovery && !['healthy', 'recovered', 'recovery_failed'].includes(recovery.phase)) return;

  if (work.reason === 'recovery_resume') {
    if (!goalSwitchFor(work.conversationId).enabled) return;
    // The Emergency Resume bootstrap itself is already an executing continuation. Give it one
    // bounded probation window to produce certified progress before filing a second message.
    if (now - work.createdAt < RECOVERY_CONTINUATION_GRACE_MS) return;
  }

  const leased = await leaseLongRunWorkNow(work.sessionId, work.conversationId);
  if (!leased?.work.inputId || !executionTicketCurrent(leased.ticket)) return;
  const inputId = leased.work.inputId;
  try {
    await enqueueInput({
      id: inputId,
      sessionId: work.sessionId,
      text: continuationText(leased.work),
      authoredSource: 'none',
      mode: 'after-turn',
      afterTurn: true,
      dueAt: Date.now(),
      model: null,
      reasoningEffort: null
    });
  } catch (error) {
    // The obligation stays dispatching with the same stable input id. A later pass retries the
    // idempotent enqueue; if the outbox already committed before a lost response it returns the
    // exact existing row rather than creating another message.
    logWarn(`long-run: continuation enqueue for ${work.sessionId} will retry — ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (!executionTicketCurrent(leased.ticket)) return;
  if (await markLongRunWorkQueuedNow(work.sessionId, leased.work.id, leased.ticket, inputId)) {
    logInfo(`long-run: queued ${leased.work.reason} continuation for session ${work.sessionId}`);
  }
}

export async function pollLongRunRuntime(now = Date.now()): Promise<void> {
  for (const wait of dueLongRunWaits(now)) {
    const ticket = captureExecutionTicket(wait.sessionId, wait.conversationId);
    if (!ticket || ticket.generation !== wait.epochGeneration) continue;
    try {
      await inspectWait(wait, ticket, now);
    } catch (error) {
      logWarn(`long-run: wait ${wait.id} check failed — ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (const work of dispatchableLongRunWork()) {
    try {
      await dispatchWork(work, now);
    } catch (error) {
      logWarn(`long-run: work ${work.id} dispatch failed — ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function runPoll(): void {
  if (stopped || pollInFlight) return;
  pollInFlight = pollLongRunRuntime().finally(() => {
    pollInFlight = null;
  });
}

export function startLongRunRuntime(): void {
  if (!stopped) return;
  stopped = false;
  runPoll();
  timer = setInterval(runPoll, LONG_RUN_POLL_MS);
  timer.unref?.();
}

export async function stopLongRunRuntime(): Promise<void> {
  stopped = true;
  if (timer) clearInterval(timer);
  timer = null;
  const running = pollInFlight;
  if (running) await running.catch(() => {});
}

export function resetLongRunRuntimeForTests(): void {
  stopped = true;
  if (timer) clearInterval(timer);
  timer = null;
  pollInFlight = null;
}
