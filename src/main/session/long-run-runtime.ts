/**
 * Local long-run supervisor.
 *
 * The model may register a durable external wait and finish its turn.  This process owns the
 * polling afterwards, then publishes one stable continuation through the existing input outbox
 * or, for a worker, through the existing durable agent-revival broker. No provider turn has to
 * remain open merely to poll CI or a long-running local process.
 */

import {
  agentInfoForOwnedConversation,
  persistCriticalSwarmNow,
  requestWorkerRevivals,
  retireWorkerContinuationIfUnsent,
  stageWorkerContinuation
} from '../agents.js';
import { goalSwitchFor } from '../goal.js';
import { effectiveCapabilities, getConfig } from '../config.js';
import { logInfo, logWarn } from '../logger.js';
import {
  evaluateSessionProjectCompletion,
  loadSessionProjectRuntimeProfile,
  ProjectRuntimeAuthorityError
} from '../project-runtime.js';
import { enqueueInput } from './input.js';
import { providerTransportReady } from './connectivity.js';
import { getSession, sessionAutonomyPaused } from './store.js';
import {
  captureExecutionTicket,
  claimProjectCompletionCheckNow,
  deferLongRunWaitNow,
  dispatchableLongRunWork,
  dueLongRunWaits,
  executionTicketCurrent,
  fulfillOwedLongRunWorkNow,
  leaseLongRunWorkNow,
  longRunProviderBudgetAge,
  longRunRecoveryPaused,
  longRunWorkFor,
  markLongRunWorkQueuedNow,
  resolveLongRunWaitNow,
  snapshotLongRunState,
  type ExecutionTicket,
  type LongRunWaitContract,
  type WorkObligation
} from './long-run.js';
import { longRunWaitProvider } from './wait-providers.js';

const LONG_RUN_POLL_MS = 5_000;
const RECOVERY_CONTINUATION_GRACE_MS = 90_000;
const WAIT_PENDING_MS = 30_000;
const WAIT_RETRY_BASE_MS = 5_000;
const WAIT_RETRY_MAX_MS = 60_000;
const WAIT_FAILURE_LIMIT = 6;

let timer: NodeJS.Timeout | null = null;
let pollInFlight: Promise<void> | null = null;
let stopped = true;

async function stopAtSatisfiedProjectCompletion(work: WorkObligation): Promise<boolean> {
  if (work.state !== 'owed' || (work.completionCheckClaimedAt ?? null) !== null) return false;
  const ticket = captureExecutionTicket(work.sessionId, work.conversationId);
  if (!ticket || ticket.generation !== work.epochGeneration) return false;
  const currentAuthority = () => {
    if (!executionTicketCurrent(ticket)) return false;
    const current = longRunWorkFor(work.sessionId);
    return !!current && current.id === work.id && current.state === 'owed' &&
      current.conversationId === work.conversationId && current.epochGeneration === ticket.generation;
  };
  try {
    if (!currentAuthority()) return false;
    const caps = effectiveCapabilities(getConfig());
    // The profile is project-owned policy, not a capability grant. When the current runtime has
    // disabled file read/metadata/command access, auto-stop fails open and normal continuation wins.
    if (!caps.read) return false;
    const loaded = await loadSessionProjectRuntimeProfile(work.sessionId);
    if (!currentAuthority() || !loaded?.profile?.completion?.autoStop) return false;
    // The claim is the crash boundary. It must be durable before evaluateSessionProjectCompletion
    // can start a command-backed task_success check. If persistence fails or another executor
    // already claimed this obligation, fail open to the ordinary continuation path.
    if (!(await claimProjectCompletionCheckNow(work.sessionId, work.id, ticket))) return false;
    if (!currentAuthority()) return false;
    const result = await evaluateSessionProjectCompletion(work.sessionId, {
      allowCommands: caps.command,
      allowMetadata: caps.metadata,
      authority: currentAuthority
    });
    if (result.state !== 'satisfied') {
      logInfo(`long-run: project completion for ${work.sessionId} is ${result.state}; continuation remains owed`);
      return false;
    }
    if (!currentAuthority()) return false;
    if (!(await fulfillOwedLongRunWorkNow(work.sessionId, work.id, ticket))) return false;
    logInfo(`long-run: machine completion satisfied for session ${work.sessionId}; no continuation queued`);
    return true;
  } catch (error) {
    if (error instanceof ProjectRuntimeAuthorityError) return false;
    // A malformed profile or unavailable verification environment must not strand durable work.
    // The explicit project_runtime tool reports the error; the supervisor proceeds normally.
    logWarn(
      `long-run: project completion gate for ${work.sessionId} could not be evaluated — ${error instanceof Error ? error.message : String(error)}`
    );
    return false;
  }
}

function retryDelay(attempts: number): number {
  return Math.min(WAIT_RETRY_MAX_MS, WAIT_RETRY_BASE_MS * 2 ** Math.min(4, Math.max(0, attempts)));
}

async function inspectWait(wait: LongRunWaitContract, ticket: ExecutionTicket, now: number): Promise<void> {
  if (!executionTicketCurrent(ticket)) return;

  const provider = longRunWaitProvider(wait.kind);
  if (!provider) {
    const error = `No long-run wait provider is registered for kind "${wait.kind}".`;
    if (wait.attempts + 1 >= WAIT_FAILURE_LIMIT) {
      await resolveLongRunWaitNow(
        wait.sessionId,
        wait.id,
        ticket,
        `Local wait monitor could not verify the external condition after ${WAIT_FAILURE_LIMIT} attempts: ${error} Reconcile it manually once, then continue the durable task.`,
        true
      );
      logWarn(`long-run: wait ${wait.id} has no registered provider and failed closed`);
      return;
    }
    await deferLongRunWaitNow(wait.sessionId, wait.id, ticket, now + retryDelay(wait.attempts), error);
    return;
  }

  if (provider.requiresConnectivity !== false && !providerTransportReady()) {
    // Transport suspension is not a provider failure. Park the same durable wait without
    // spending its consecutive-error budget; local timer/process providers opt out above.
    await deferLongRunWaitNow(wait.sessionId, wait.id, ticket, now + WAIT_PENDING_MS, null);
    return;
  }

  const verdict = await provider.inspect(wait, now);

  if (!executionTicketCurrent(ticket)) return;
  if (verdict.kind === 'pending') {
    await deferLongRunWaitNow(
      wait.sessionId,
      wait.id,
      ticket,
      verdict.nextCheckAt ?? now + WAIT_PENDING_MS,
      null
    );
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
  // A durable obligation may become owed while offline (timer/process completion, restored
  // state, or a wait that resolved just before the outage). Provider delivery is parked until
  // the one transport authority says connected; the debt itself remains durable.
  if (!providerTransportReady()) return;
  // A user pause is the master autonomous-execution fence. External waits may keep being
  // observed and become owed, but no continuation is leased/enqueued until the same durable
  // session is explicitly resumed.
  if (sessionAutonomyPaused(session)) return;
  const recovery = session.recovery;
  // recovery_failed can still mean an ambiguous native Send with admission fences restored on
  // restart. It is not authority to start another provider message. Only a healthy/recovered
  // executor may receive autonomous long-run work; the recovery subsystem owns every failed
  // transaction until it is explicitly reconciled or superseded.
  if (recovery && recovery.phase !== 'healthy' && recovery.phase !== 'recovered') return;

  if (work.reason === 'recovery_resume') {
    if (!goalSwitchFor(work.conversationId).enabled && !agentInfoForOwnedConversation(work.conversationId)) return;
    // The Emergency Resume bootstrap itself is already an executing continuation. Give it one
    // bounded probation window to produce certified progress before filing a second message.
    if (longRunProviderBudgetAge(work, now) < RECOVERY_CONTINUATION_GRACE_MS) return;
  }

  if (await stopAtSatisfiedProjectCompletion(work)) return;

  const leased = await leaseLongRunWorkNow(work.sessionId, work.conversationId);
  if (!leased?.work.inputId || !executionTicketCurrent(leased.ticket)) return;
  const inputId = leased.work.inputId;
  const text = continuationText(leased.work);
  const agent = agentInfoForOwnedConversation(work.conversationId);

  if (agent?.role === 'worker') {
    // Turning multi-agent mode off is an explicit user authority boundary. Keep the durable debt
    // parked rather than waking a worker through an internal path the public broker has disabled.
    if (!getConfig().multiAgent.enabled) return;
    // Worker chats have their own durable wake transaction and configured slot limit. Never
    // bypass that broker by dropping an ordinary after-turn browser input into a sleeping worker.
    // The long-run input UUID is reused as the broker message id, closing the crash window where
    // the swarm fsync succeeds but this work ledger has not yet recorded queued.
    let staged: ReturnType<typeof stageWorkerContinuation>;
    try {
      staged = stageWorkerContinuation(work.conversationId, inputId, text);
    } catch (error) {
      // These are ordinary broker backpressure states, not faults. The five-second supervisor
      // loop simply leaves the same stable obligation parked until the slot/transaction clears.
      const detail = error instanceof Error ? error.message : String(error);
      if (!/NO_FREE_SLOT|REVIVE_IN_PROGRESS|FINISH_IN_PROGRESS|OWNER_TRANSITION_IN_PROGRESS|switched off/i.test(detail)) {
        logWarn(`long-run: worker continuation for ${work.sessionId} will retry — ${detail}`);
      }
      return;
    }
    // An active/detached worker is still executing the turn that registered the wait, or has not
    // yet crossed its ordinary sleep lifecycle. Certified progress can satisfy the debt meanwhile;
    // otherwise a later poll reaches the same worker after it becomes sleeping.
    if (!staged) return;

    let accepted = false;
    try {
      if (!(await persistCriticalSwarmNow())) {
        throw new Error('the worker broker has no immediate durable persistence sink');
      }
      staged.commit();
      accepted = true;
    } catch (error) {
      if (!accepted) staged.rollback();
      logWarn(
        `long-run: worker continuation durability for ${work.sessionId} will retry — ${error instanceof Error ? error.message : String(error)}`
      );
      return;
    }

    // A rebind/cancel that won while the swarm fsync was in flight invalidates the old executor.
    // The broker row is already durable under the stable UUID; do not wake the old chat. A later
    // pass under the new epoch finds that same row and safely resumes from there.
    if (!executionTicketCurrent(leased.ticket)) return;
    const current = await getSession(work.sessionId);
    if (!current?.conversationId || current.conversationId !== work.conversationId) return;
    const currentRecovery = current.recovery;
    if (currentRecovery && currentRecovery.phase !== 'healthy' && currentRecovery.phase !== 'recovered') return;

    if (await markLongRunWorkQueuedNow(work.sessionId, leased.work.id, leased.ticket, inputId)) {
      // Browser publication happens only after both durable authorities agree: the worker inbox
      // is fsynced and this execution epoch has recorded the stable continuation as queued.
      if (staged.waking.length > 0) requestWorkerRevivals(staged.waking, staged.runId);
      logInfo(`long-run: queued ${leased.work.reason} worker continuation for session ${work.sessionId}`);
    }
    return;
  }

  // A session known to be a worker whose broker lineage is temporarily unavailable must fail
  // closed. Treating it as an ordinary chat would bypass worker-slot and revival authority.
  if (session.origin?.kind === 'worker') return;

  try {
    await enqueueInput({
      id: inputId,
      sessionId: work.sessionId,
      text,
      authoredSource: 'none',
      mode: 'after-turn',
      afterTurn: true,
      dueAt: Date.now(),
      model: null,
      reasoningEffort: null
    }, undefined, leased.work.id);
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

async function reconcileRevokedWorkerContinuations(): Promise<void> {
  let retiredAny = false;
  for (const work of snapshotLongRunState().obligations) {
    if (!work.inputId || (work.state !== 'fulfilled' && work.state !== 'cancelled')) continue;
    const retired = retireWorkerContinuationIfUnsent(
      work.conversationId,
      work.inputId,
      `long-run obligation ${work.id} is ${work.state}`
    );
    if (retired === 'retired') retiredAny = true;
  }
  if (!retiredAny) return;
  try {
    if (!(await persistCriticalSwarmNow())) {
      logWarn('long-run: revoked worker-continuation cleanup has no immediate durable broker sink');
    }
  } catch (error) {
    // The execution fence already makes stale rows non-deliverable. A failed hygiene fsync may
    // resurrect them after restart, but they remain stale and a later supervisor pass retries
    // cleanup rather than converting persistence failure into duplicate work.
    logWarn(
      `long-run: could not persist revoked worker-continuation cleanup — ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export async function pollLongRunRuntime(now = Date.now()): Promise<void> {
  // A corrupt authority ledger is not an empty queue. Do not even run broker hygiene while the
  // owner is paused: deleting a UUID message would itself be a durability decision made without
  // the ledger that proves whether the message was stale or current.
  if (longRunRecoveryPaused()) return;
  await reconcileRevokedWorkerContinuations();
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
