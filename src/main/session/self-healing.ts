/**
 * Durable provider-independent recovery for one local session.
 *
 * A ChatGPT conversation is an executor lease. The local session is the durable identity. This
 * module records why a lease is being replaced and commits the replacement through the same
 * `rebindSession()` primitive used by Compact & Resume. It never asks the failed model for a
 * handoff and never treats a browser Retry button as mutation-safe authority.
 */

import { randomUUID } from 'node:crypto';
import type {
  RecoveryMutationSafety,
  SelfHealingAgentLineage,
  SelfHealingDestinationCheckpoint,
  SelfHealingFailureKind,
  SelfHealingRecoveryState
} from '../../shared/recovery.js';
import { SELF_HEAL_COOLDOWN_MS } from '../../shared/recovery.js';
import type { AgentInfo, SessionEvent } from '../../shared/session.js';
import {
  PRIME_ID,
  agentInfoForOwnedConversation,
  beginPrimeTransfer,
  cancelPrimeTransfer,
  commitPrimeTransfer,
  freezePrimeTransfer,
  persistCriticalSwarmNow,
  repairPrimeConversationAfterRecovery,
  repairWorkerConversationAfterRecovery,
  swarmTransferActive,
  thawPrimeTransfer
} from '../agents.js';
import { goalObjectiveFor, goalSwitchFor } from '../goal.js';
import { ensureRecoveryWorkNow } from './long-run.js';
import { logInfo, logWarn } from '../logger.js';
import { bindAgentWorkspace } from '../workspace.js';
import { publishRecoveryRebindProjectionDurably } from './rebind.js';
import { armRecoveryFence, disarmRecoveryFence } from './recovery-fence.js';
import { endResumeClaim, noteResumeOpening } from './resume-gate.js';
import {
  claimSessionReplacementTransfer,
  commitSelfHealingRebind,
  getSession,
  indexedSessions,
  readLatestUserMessage,
  readRecentEvents,
  releaseSessionReplacementTransfer,
  setSessionRecoveryState
} from './store.js';

const PROVEN_READ_ONLY_TOOLS = new Set(['read', 'find', 'view_image', 'observe']);
const MAX_RECOVERY_BRIEF_CHARS = 24_000;

const durableFenceOwner = (episodeId: string, generation: number): string =>
  `durable:${episodeId}:${generation}`;
const replacementFenceOwner = (episodeId: string, generation: number): string =>
  `replacement:${episodeId}:${generation}`;
const recoveryTransfer = (conversationId: string, episodeId: string, generation: number) => ({
  kind: 'recovery' as const,
  transactionId: episodeId,
  sourceConversationId: conversationId,
  recoveryGeneration: generation
});

type SelfHealingRecoveryHooks = {
  afterSessionRebind?: (sessionId: string, fromConversationId: string, toConversationId: string) => Promise<void> | void;
};
let recoveryHooks: SelfHealingRecoveryHooks = {};

export function setSelfHealingRecoveryHooksForTests(hooks: SelfHealingRecoveryHooks): void {
  recoveryHooks = hooks;
}

function lineageFor(agent: AgentInfo | null, conversationId: string): SelfHealingAgentLineage | null {
  if (!agent?.runId) return null;
  const primeConversationId = agent.role === 'prime' ? conversationId : agent.primeConversationId;
  if (!primeConversationId) return null;
  return {
    role: agent.role === 'prime' ? 'prime' : 'worker',
    agentId: agent.id,
    runId: agent.runId,
    primeConversationId,
    task: agent.role === 'worker' ? agent.task : '',
    createdAt: agent.createdAt
  };
}

function agentMatchesLineage(agent: AgentInfo | null, lineage: SelfHealingAgentLineage): boolean {
  if (!agent) return false;
  return agent.role === lineage.role &&
    agent.id === lineage.agentId &&
    agent.runId === lineage.runId &&
    agent.createdAt === lineage.createdAt &&
    (agent.role !== 'worker' || agent.task === lineage.task) &&
    (agent.role === 'prime' ? agent.conversationId : agent.primeConversationId) === lineage.primeConversationId;
}

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/**
 * Conservative turn safety classifier.
 *
 * Absence of mutation evidence is not proof of read-only work. A turn is SAFE_RETRY only when
 * every recorded local call since its newest start is a small explicit read-only allowlist and
 * no call reports file changes. Everything else, including no recorded call, is ambiguous.
 */
export function recoveryMutationSafety(events: readonly SessionEvent[]): RecoveryMutationSafety {
  let start = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.kind === 'turn_start') { start = i; break; }
  }
  if (start < 0) return 'mutating_or_ambiguous';
  const calls = events.slice(start + 1).filter((event): event is Extract<SessionEvent, { kind: 'tool_call' }> => event.kind === 'tool_call');
  if (calls.length === 0) return 'mutating_or_ambiguous';
  return calls.every(({ call }) => PROVEN_READ_ONLY_TOOLS.has(call.tool) && (call.changes?.length ?? 0) === 0)
    ? 'read_only_safe_retry'
    : 'mutating_or_ambiguous';
}

async function currentSafety(sessionId: string): Promise<RecoveryMutationSafety> {
  const events = await readRecentEvents(sessionId, 120, { maxBytes: 768 * 1024 });
  return recoveryMutationSafety(events);
}

export async function beginSelfHealingEpisode(
  sessionId: string,
  conversationId: string,
  failureKind: SelfHealingFailureKind,
  lastProgressAt: number | null = null
): Promise<SelfHealingRecoveryState | null> {
  const session = await getSession(sessionId);
  if (!session || session.conversationId !== conversationId || session.lastTurnOutcome === 'stopped') return null;
  // Compact & Resume and Emergency Resume share one provider-replacement owner. Once a
  // continuation owns it, Self-Healing must not create a competing reload/replacement episode.
  if (session.replacementTransfer?.kind === 'continuation') return null;
  const previous = session.recovery;
  const now = Date.now();
  // Recovery progress is a monotonic evidence frontier, not a precedence chain. Using `??`
  // here let an older tool-call timestamp mask a newer terminal/final timestamp, so replayed
  // activity after a reload could appear to advance the episode. Freeze the newest canonical
  // boundary that was already durable when this failure generation began.
  const observedProgress = Math.max(
    0,
    lastProgressAt ?? 0,
    session.lastToolCallAt ?? 0,
    session.lastTurnEndAt ?? 0,
    session.lastAssistantFinalAt ?? 0
  ) || null;
  if (previous?.previousConversationId === conversationId) {
    if (previous.phase === 'hard_recovery' || previous.phase === 'reconciling') return previous;
    if (previous.phase === 'suspected_stall' || previous.phase === 'soft_recovery') {
      // The same dead evidence belongs to the same episode. Any newer canonical progress means
      // the old episode recovered and a later stall is a different failure generation with a
      // freshly computed mutation-safety verdict.
      if (!observedProgress || observedProgress <= (previous.lastProgressAt ?? 0)) return previous;
    }
    // A failed episode may not restart itself from the same dead evidence. New durable progress
    // is what earns another episode; the cooldown prevents a rapid failure/retry storm even then.
    if (previous.phase === 'recovery_failed') {
      if (!observedProgress || observedProgress <= (previous.lastProgressAt ?? 0)) return null;
      if (now - (previous.lastRecoveryAt ?? previous.updatedAt) < SELF_HEAL_COOLDOWN_MS) return null;
    }
  }
  const recovery: SelfHealingRecoveryState = {
    phase: 'suspected_stall',
    failureEpisodeId: randomUUID(),
    recoveryGeneration: (previous?.recoveryGeneration ?? 0) + 1,
    recoveryAttempts: 0,
    lastRecoveryAt: previous?.lastRecoveryAt ?? null,
    lastProgressAt: observedProgress,
    previousConversationId: conversationId,
    replacementConversationId: null,
    failureKind,
    mutationSafety: await currentSafety(sessionId),
    agentLineage: lineageFor(agentInfoForOwnedConversation(conversationId), conversationId),
    destinationSend: {
      state: 'not-attempted',
      commandId: null,
      dispatchedAt: null,
      conversationId: null,
      messageId: null
    },
    updatedAt: now,
    error: null
  };
  return (await setSessionRecoveryState(sessionId, conversationId, recovery, {
    failureEpisodeId: previous?.failureEpisodeId ?? null,
    recoveryGeneration: previous?.recoveryGeneration ?? null,
    events: session.events,
    ...(previous ? {
      phases: [previous.phase],
      previousConversationId: previous.previousConversationId,
      replacementConversationId: previous.replacementConversationId
    } : {})
  })) ? recovery : null;
}

/**
 * Retires a non-committing recovery episode after canonical current-chat progress is durable.
 *
 * Browser polling/prose changes never call this. The bridge supplies only recorder-confirmed
 * work/final activity. Hard recovery and reconciliation are intentionally monotonic: once A is
 * fenced or session metadata has moved to B, late A activity cannot cancel the transfer.
 */
export async function noteSelfHealingProgress(
  sessionId: string,
  conversationId: string,
  progressAt: number
): Promise<boolean> {
  if (!Number.isFinite(progressAt) || progressAt <= 0) return false;
  const session = await getSession(sessionId);
  const held = session?.recovery;
  if (!session || session.conversationId !== conversationId || !held) return false;
  if (held.phase === 'hard_recovery' || held.phase === 'reconciling') return false;
  // A recovery phase is authority-bearing state. Re-observing the same provider work after a
  // reload must never retire it. Only evidence strictly beyond the episode's durable frontier
  // can do so; bridge-level probation decides which kinds of evidence are strong enough while
  // soft recovery is active.
  if (progressAt <= (held.lastProgressAt ?? 0)) return false;
  const next: SelfHealingRecoveryState = {
    ...held,
    phase: 'healthy',
    lastProgressAt: Math.max(progressAt, held.lastProgressAt ?? 0),
    updatedAt: Date.now(),
    error: null
  };
  return setSessionRecoveryState(sessionId, conversationId, next, {
    failureEpisodeId: held.failureEpisodeId,
    recoveryGeneration: held.recoveryGeneration,
    phases: [held.phase],
    previousConversationId: held.previousConversationId,
    replacementConversationId: held.replacementConversationId
  });
}

export async function markSoftRecovery(
  sessionId: string,
  conversationId: string,
  episodeId: string,
  generation: number
): Promise<SelfHealingRecoveryState | null> {
  const session = await getSession(sessionId);
  const held = session?.recovery;
  if (!session || session.conversationId !== conversationId || !held || held.failureEpisodeId !== episodeId ||
      held.recoveryGeneration !== generation || session.replacementTransfer?.kind === 'continuation') return null;
  if (session.lastTurnOutcome === 'stopped') return null;
  if (held.phase === 'soft_recovery') return held;
  if (held.phase !== 'suspected_stall') return null;
  const next: SelfHealingRecoveryState = {
    ...held,
    phase: 'soft_recovery',
    recoveryAttempts: held.recoveryAttempts + 1,
    lastRecoveryAt: Date.now(),
    updatedAt: Date.now(),
    error: null
  };
  return (await setSessionRecoveryState(sessionId, conversationId, next, {
    failureEpisodeId: held.failureEpisodeId,
    recoveryGeneration: held.recoveryGeneration,
    events: session.events,
    phases: ['suspected_stall'],
    previousConversationId: held.previousConversationId,
    replacementConversationId: held.replacementConversationId
  })) ? next : null;
}

export const selfHealingSendUnattempted = (checkpoint: SelfHealingDestinationCheckpoint): boolean =>
  checkpoint.state === 'not-attempted' || checkpoint.state === 'attempted-unresolved';

export async function beginEmergencyResumeDestinationSend(
  sessionId: string,
  episodeId: string,
  generation: number,
  commandId: string
): Promise<{ allowed: boolean; checkpoint: SelfHealingDestinationCheckpoint } | null> {
  const session = await getSession(sessionId);
  const held = session?.recovery;
  if (!session || !held || session.conversationId !== held.previousConversationId ||
      held.failureEpisodeId !== episodeId || held.recoveryGeneration !== generation ||
      held.phase !== 'hard_recovery') return null;
  const checkpoint = held.destinationSend;
  if (checkpoint.state === 'attempted-unresolved' && checkpoint.commandId === commandId) {
    return { allowed: true, checkpoint: { ...checkpoint } };
  }
  if (checkpoint.state !== 'not-attempted') return { allowed: false, checkpoint: { ...checkpoint } };
  const next: SelfHealingRecoveryState = {
    ...held,
    destinationSend: {
      state: 'attempted-unresolved',
      commandId,
      dispatchedAt: null,
      conversationId: null,
      messageId: null
    },
    updatedAt: Date.now(),
    error: null
  };
  const committed = await setSessionRecoveryState(sessionId, session.conversationId, next, {
    failureEpisodeId: held.failureEpisodeId,
    recoveryGeneration: held.recoveryGeneration,
    phases: ['hard_recovery'],
    previousConversationId: held.previousConversationId,
    replacementConversationId: null,
    destinationSendState: 'not-attempted',
    destinationCommandId: checkpoint.commandId
  });
  if (committed) return { allowed: true, checkpoint: { ...next.destinationSend } };
  const current = (await getSession(sessionId))?.recovery;
  return current?.failureEpisodeId === episodeId && current.recoveryGeneration === generation
    ? { allowed: current.destinationSend.state === 'attempted-unresolved' && current.destinationSend.commandId === commandId,
        checkpoint: { ...current.destinationSend } }
    : null;
}

export async function dispatchEmergencyResumeDestinationSend(
  sessionId: string,
  episodeId: string,
  generation: number,
  commandId: string
): Promise<boolean> {
  const session = await getSession(sessionId);
  const held = session?.recovery;
  if (!session || !held || session.conversationId !== held.previousConversationId ||
      held.failureEpisodeId !== episodeId || held.recoveryGeneration !== generation ||
      held.phase !== 'hard_recovery') return false;
  if (held.destinationSend.state === 'dispatched-unresolved' && held.destinationSend.commandId === commandId) return true;
  if (held.destinationSend.state !== 'attempted-unresolved' || held.destinationSend.commandId !== commandId) return false;
  const next: SelfHealingRecoveryState = {
    ...held,
    destinationSend: {
      ...held.destinationSend,
      state: 'dispatched-unresolved',
      dispatchedAt: Date.now()
    },
    updatedAt: Date.now(),
    error: null
  };
  return setSessionRecoveryState(sessionId, session.conversationId, next, {
    failureEpisodeId: held.failureEpisodeId,
    recoveryGeneration: held.recoveryGeneration,
    phases: ['hard_recovery'],
    previousConversationId: held.previousConversationId,
    replacementConversationId: null,
    destinationSendState: 'attempted-unresolved',
    destinationCommandId: commandId
  });
}

/** Release is allowed only on positive page proof that native Send was never attempted. */
export async function releaseEmergencyResumeDestinationSend(
  sessionId: string,
  episodeId: string,
  generation: number,
  commandId: string
): Promise<boolean> {
  const session = await getSession(sessionId);
  const held = session?.recovery;
  if (!session || !held || session.conversationId !== held.previousConversationId ||
      held.failureEpisodeId !== episodeId || held.recoveryGeneration !== generation || held.phase !== 'hard_recovery') return false;
  if (!['attempted-unresolved', 'dispatched-unresolved'].includes(held.destinationSend.state) ||
      held.destinationSend.commandId !== commandId || held.destinationSend.conversationId || held.destinationSend.messageId) return false;
  const next: SelfHealingRecoveryState = {
    ...held,
    destinationSend: {
      state: 'not-attempted',
      commandId: null,
      dispatchedAt: null,
      conversationId: null,
      messageId: null
    },
    updatedAt: Date.now()
  };
  return setSessionRecoveryState(sessionId, session.conversationId, next, {
    failureEpisodeId: held.failureEpisodeId,
    recoveryGeneration: held.recoveryGeneration,
    phases: ['hard_recovery'],
    previousConversationId: held.previousConversationId,
    replacementConversationId: null,
    destinationSendState: held.destinationSend.state,
    destinationCommandId: commandId
  });
}

/**
 * Binds the irreversible recovery dispatch to exactly one provider destination. This is the
 * competing B/C ACK CAS: the first destination wins the session queue; a different later one is
 * rejected without touching the canonical A→B attachment.
 */
export async function bindEmergencyResumeDestination(
  sessionId: string,
  episodeId: string,
  generation: number,
  commandId: string | null,
  toConversationId: string,
  messageId: string | null
): Promise<boolean> {
  if (!toConversationId || !episodeId || !Number.isSafeInteger(generation) || generation < 1) return false;
  const session = await getSession(sessionId);
  const held = session?.recovery;
  if (!session || !held || held.failureEpisodeId !== episodeId || held.recoveryGeneration !== generation) return false;
  const checkpoint = held.destinationSend;
  if (checkpoint.state === 'sent') {
    if (checkpoint.conversationId !== toConversationId) return false;
    if (checkpoint.messageId && messageId && checkpoint.messageId !== messageId) return false;
    if (!checkpoint.messageId && messageId) {
      const next: SelfHealingRecoveryState = {
        ...held,
        destinationSend: { ...checkpoint, messageId },
        updatedAt: Date.now()
      };
      return setSessionRecoveryState(sessionId, session.conversationId!, next, {
        failureEpisodeId: held.failureEpisodeId,
        recoveryGeneration: held.recoveryGeneration,
        phases: [held.phase],
        previousConversationId: held.previousConversationId,
        replacementConversationId: held.replacementConversationId,
        destinationSendState: 'sent',
        destinationCommandId: checkpoint.commandId
      });
    }
    return true;
  }
  if (checkpoint.state !== 'dispatched-unresolved') return false;
  if (commandId !== null && checkpoint.commandId !== commandId) return false;
  if (session.conversationId !== held.previousConversationId || held.phase !== 'hard_recovery' || held.replacementConversationId !== null) return false;
  const next: SelfHealingRecoveryState = {
    ...held,
    destinationSend: {
      ...checkpoint,
      state: 'sent',
      conversationId: toConversationId,
      messageId
    },
    updatedAt: Date.now(),
    error: null
  };
  return setSessionRecoveryState(sessionId, session.conversationId, next, {
    failureEpisodeId: held.failureEpisodeId,
    recoveryGeneration: held.recoveryGeneration,
    phases: ['hard_recovery'],
    previousConversationId: held.previousConversationId,
    replacementConversationId: null,
    destinationSendState: 'dispatched-unresolved',
    destinationCommandId: checkpoint.commandId
  });
}

export interface EmergencyResumeBootstrap {
  state: SelfHealingRecoveryState;
  text: string;
  agent: AgentInfo | null;
  lineage: SelfHealingAgentLineage | null;
}

/** Builds model context exclusively from durable local evidence. */
export async function prepareEmergencyResume(
  sessionId: string,
  conversationId: string,
  episodeId: string
): Promise<EmergencyResumeBootstrap | null> {
  const session = await getSession(sessionId);
  const held = session?.recovery;
  if (!session || session.conversationId !== conversationId || !held || held.failureEpisodeId !== episodeId) return null;
  if (session.lastTurnOutcome === 'stopped') return null;
  if (held.phase !== 'soft_recovery' && held.phase !== 'suspected_stall' && held.phase !== 'hard_recovery') return null;

  const now = Date.now();
  if (session.lastTurnOutcome === 'completed' && !session.activeTurnId) return null;
  const observedAgent = agentInfoForOwnedConversation(conversationId);
  const capturedLineage = held.agentLineage ?? lineageFor(observedAgent, conversationId);
  const needsWrite = held.phase !== 'hard_recovery' || capturedLineage !== held.agentLineage;
  const state: SelfHealingRecoveryState = needsWrite
    ? {
        ...held,
        phase: 'hard_recovery',
        mutationSafety: await currentSafety(sessionId),
        agentLineage: capturedLineage,
        recoveryAttempts: held.phase === 'hard_recovery' ? held.recoveryAttempts : held.recoveryAttempts + 1,
        lastRecoveryAt: held.phase === 'hard_recovery' ? held.lastRecoveryAt : now,
        updatedAt: now,
        error: null
      }
    : held;
  const transfer = recoveryTransfer(conversationId, held.failureEpisodeId, held.recoveryGeneration);
  // Claim the session-wide replacement slot before publishing hard recovery. Compact & Resume and
  // Emergency Resume are different WALs but one browser side effect; whichever transaction owns
  // this durable CAS is the only one allowed to create a replacement executor.
  const attemptFence = `prepare:${randomUUID()}`;
  armRecoveryFence(conversationId, attemptFence);
  let ownsTransfer = false;
  try {
    ownsTransfer = await claimSessionReplacementTransfer(sessionId, transfer);
    if (!ownsTransfer) {
      // A pre-existing hard recovery without its transfer claim can occur after upgrading a dirty
      // development build. If another transaction already owns replacement, retire this recovery
      // rather than deadlocking that proven owner behind a hard-recovery phase.
      if (held.phase === 'hard_recovery') {
        await failSelfHealingRecovery(
          sessionId,
          conversationId,
          held.failureEpisodeId,
          held.recoveryGeneration,
          'hard_recovery',
          'Another provider-replacement transaction owns this session.'
        ).catch(() => false);
      }
      return null;
    }
    if (needsWrite && !(await setSessionRecoveryState(sessionId, conversationId, state, {
      failureEpisodeId: held.failureEpisodeId,
      recoveryGeneration: held.recoveryGeneration,
      phases: [held.phase],
      previousConversationId: held.previousConversationId,
      replacementConversationId: held.replacementConversationId,
      events: session.events
    }))) {
      await releaseSessionReplacementTransfer(sessionId, transfer).catch(() => false);
      return null;
    }
    armRecoveryFence(conversationId, durableFenceOwner(state.failureEpisodeId, state.recoveryGeneration));
  } catch (error) {
    // Before hard recovery is durable no browser command can have been returned to the caller, so
    // an exact claim acquired by this attempt is safe to release. Once hard recovery is durable,
    // retain the claim; restart reconstruction owns the transaction from there.
    const current = await getSession(sessionId).catch(() => null);
    if (ownsTransfer && current?.recovery?.phase !== 'hard_recovery') {
      await releaseSessionReplacementTransfer(sessionId, transfer).catch(() => false);
    }
    throw error;
  } finally {
    disarmRecoveryFence(conversationId, attemptFence);
  }

  const latest = await readLatestUserMessage(sessionId);
  const agent = state.agentLineage && agentMatchesLineage(observedAgent, state.agentLineage) ? observedAgent : null;
  const objective = goalObjectiveFor(conversationId);
  const goal = goalSwitchFor(conversationId);
  const safety = state.mutationSafety === 'read_only_safe_retry'
    ? 'The interrupted local tool activity is durably proven read-only. Re-read state if useful, but still reconcile before acting.'
    : 'A mutation may already have occurred, or dispatch outcome is ambiguous. Assume side effects may have landed until durable evidence proves otherwise.';
  const identity = state.agentLineage?.role === 'worker'
    ? `You are still ${state.agentLineage.agentId} in run ${state.agentLineage.runId}, continuing the same durable worker task.\nWorker task: ${clip(state.agentLineage.task, 4_000)}`
    : state.agentLineage?.role === 'prime'
      ? `You are the replacement executor for the same durable Prime session in run ${state.agentLineage.runId}.`
      : 'You are the replacement executor for the same durable local session.';
  const goalText = objective
    ? `Goal/Loop remains ${goal.enabled ? goal.mode : 'off'} for this durable session.\nSaved goal: ${clip(objective, 4_000)}`
    : `Goal/Loop remains ${goal.enabled ? goal.mode : 'off'} for this durable session.`;
  const latestText = latest?.message?.text ? `Latest authored user request:\n${clip(latest.message.text, 8_000)}` : 'No latest authored user request was available in durable history.';

  const text = clip(
    `[[CLF-EMERGENCY-RESUME:${state.failureEpisodeId}]]\n` +
    `A provider failure retired the previous ChatGPT executor. The local session and its Goal/worker identity survived.\n\n` +
    `${identity}\n\n${goalText}\n\n${latestText}\n\n` +
    `Recovery generation: ${state.recoveryGeneration}. Failure class: ${state.failureKind}.\n${safety}\n\n` +
    `Do not blindly repeat the interrupted turn.\n` +
    `Treat completed operations as completed.\n` +
    `Only redo an operation if durable evidence proves it did not occur.\n\n` +
    `Before continuing, reconcile actual local state. Inspect completed tool receipts, running process sessions, current files, git status, git diff, git log/current branch where applicable, the durable session history, latest build/test results, and worker status. Resolve any ambiguous in-flight operation from those facts. Then continue the same Goal/task autonomously from the first still-needed action.`,
    MAX_RECOVERY_BRIEF_CHARS
  );
  return { state, text, agent, lineage: state.agentLineage };
}

export type EmergencyResumeCommitResult =
  | { status: 'committed'; conversationId: string }
  | { status: 'retryable'; reason: string }
  | { status: 'rejected'; reason: string };

/**
 * Commits a fresh provider conversation as this session's executor.
 *
 * The recovery WAL edge and canonical session rebind are committed by one store CAS. Once that
 * write lands it is the point of no return; crash recovery repairs projections from that fact.
 */
export async function commitEmergencyResume(
  sessionId: string,
  episodeId: string,
  toConversationId: string
): Promise<EmergencyResumeCommitResult> {
  const session = await getSession(sessionId);
  const held = session?.recovery;
  if (!session || !session.conversationId || !held || held.failureEpisodeId !== episodeId)
    return { status: 'rejected', reason: 'recovery episode is no longer current' };
  if (held.destinationSend.state !== 'sent' || held.destinationSend.conversationId !== toConversationId)
    return { status: 'rejected', reason: 'replacement destination has not crossed the durable Send boundary' };
  if (held.replacementConversationId && held.replacementConversationId !== toConversationId)
    return { status: 'rejected', reason: 'another replacement conversation already owns this episode' };

  const from = held.previousConversationId;
  // Lost ACK after a durable A→B commit is idempotent.
  if (session.conversationId === toConversationId) {
    return (await reconcileCommittedRecovery(sessionId, held, toConversationId))
      ? { status: 'committed', conversationId: toConversationId }
      : { status: 'retryable', reason: 'recovery committed; projection reconciliation is pending' };
  }
  if (held.phase !== 'hard_recovery' && held.phase !== 'reconciling')
    return { status: 'rejected', reason: 'recovery is not ready to rebind' };
  if (session.conversationId !== from) return { status: 'rejected', reason: 'session attachment changed during recovery' };

  const lineage = held.agentLineage;
  const agent = lineage ? agentInfoForOwnedConversation(from) : null;
  let primeFrozen = false;
  if (lineage?.role === 'prime' && agentMatchesLineage(agent, lineage)) {
    if (swarmTransferActive(lineage.runId)) return { status: 'retryable', reason: 'another Prime transfer is active' };
    if (!beginPrimeTransfer(from)) return { status: 'retryable', reason: 'Prime transfer could not be reserved' };
    const frozen = freezePrimeTransfer(from);
    if (frozen === 'unavailable') {
      cancelPrimeTransfer(from);
      return { status: 'retryable', reason: 'Prime transfer could not be frozen' };
    }
    primeFrozen = frozen === 'frozen';
  }

  try {
    const candidate = await commitSelfHealingRebind(
      sessionId,
      from,
      toConversationId,
      held.failureEpisodeId,
      held.recoveryGeneration
    );
    if (!candidate) {
      if (primeFrozen) thawPrimeTransfer(from);
      else if (agent?.role === 'prime') cancelPrimeTransfer(from);
      const current = await getSession(sessionId);
      if (current?.conversationId === toConversationId && current.recovery?.failureEpisodeId === episodeId &&
          current.recovery.replacementConversationId === toConversationId) {
        const reconciled = await reconcileCommittedRecovery(sessionId, current.recovery, toConversationId);
        return reconciled
          ? { status: 'committed', conversationId: toConversationId }
          : { status: 'retryable', reason: 'recovery committed; projection reconciliation is pending' };
      }
      return { status: 'rejected', reason: 'session recovery compare-and-swap no longer owns this attachment' };
    }

    // The durable attachment now names B, but A stays fenced until every projection and the final
    // recovery WAL edge are durable. B is fenced as well while Goal/agent state is converging.
    // This makes the whole A→B window non-executable instead of relying on one projection being
    // updated before another.
    armRecoveryFence(toConversationId, replacementFenceOwner(candidate.failureEpisodeId, candidate.recoveryGeneration));
    await recoveryHooks.afterSessionRebind?.(sessionId, from, toConversationId);
    try {
      await publishRecoveryRebindProjectionDurably(sessionId, from, toConversationId);
    } catch (error) {
      await noteRetryableProjectionFailure(sessionId, toConversationId, candidate, error);
      return { status: 'retryable', reason: 'recovery committed; Goal/Loop projection is not durable yet' };
    }
    let projectionDurable = lineage === null;
    if (lineage?.role === 'prime') {
      const moved = primeFrozen
        ? commitPrimeTransfer(from, toConversationId)
        : repairPrimeConversationAfterRecovery(from, toConversationId, lineage);
      if (!moved) projectionDurable = false;
      else projectionDurable = await persistCriticalSwarmNow().catch(() => false);
    } else if (lineage?.role === 'worker') {
      const moved = repairWorkerConversationAfterRecovery(
        lineage.agentId,
        lineage.runId,
        from,
        toConversationId,
        lineage
      );
      if (moved) bindAgentWorkspace(lineage.agentId, toConversationId, lineage.runId);
      projectionDurable = moved && await persistCriticalSwarmNow().catch(() => false);
    } else if (agentInfoForOwnedConversation(from) || agentInfoForOwnedConversation(toConversationId)) {
      // No durable lineage means an agent projection cannot be proven. In particular, never
      // accept an arbitrary agent that happens to be bound to B as evidence of this A→B move.
      projectionDurable = false;
    }
    if (!projectionDurable) {
      logWarn(`self-healing: durable session moved ${from} -> ${toConversationId}, broker projection remains reconciling`);
      return { status: 'retryable', reason: 'recovery committed; broker projection is not durable yet' };
    }

    if (!(await markRecoveryRecovered(sessionId, toConversationId, candidate))) {
      return { status: 'retryable', reason: 'recovery projections committed; final recovery receipt is not durable yet' };
    }
    endResumeClaim(candidate.failureEpisodeId);
    disarmRecoveryFence(from, durableFenceOwner(candidate.failureEpisodeId, candidate.recoveryGeneration));
    disarmRecoveryFence(toConversationId, replacementFenceOwner(candidate.failureEpisodeId, candidate.recoveryGeneration));
    logInfo(`self-healing: session ${sessionId} moved from failed conversation ${from} to ${toConversationId}`);
    return { status: 'committed', conversationId: toConversationId };
  } catch (error) {
    // If durable metadata already names B, rollback is forbidden; restart reconciliation owns it.
    const after = await getSession(sessionId).catch(() => null);
    if (after?.conversationId === toConversationId) {
      logWarn(`self-healing: recovery committed durably but projection reconciliation will retry — ${error instanceof Error ? error.message : String(error)}`);
      return { status: 'retryable', reason: 'recovery committed; projection reconciliation is pending' };
    }
    if (primeFrozen) thawPrimeTransfer(from);
    else if (agent?.role === 'prime') cancelPrimeTransfer(from);
    return { status: 'retryable', reason: error instanceof Error ? error.message : String(error) };
  }
}

async function markRecoveryRecovered(
  sessionId: string,
  conversationId: string,
  recovery: SelfHealingRecoveryState
): Promise<boolean> {
  // Goal/Loop is durable autonomy authority. Before the recovery fence is retired, record that the
  // same task still owes forward progress in B. The Emergency Resume bootstrap gets a grace
  // window; if it never makes a new local MCP call, the local long-run supervisor files one stable
  // continuation instead of letting the recovered conversation become an idle endpoint.
  if (goalSwitchFor(conversationId).enabled || recovery.agentLineage !== null) {
    await ensureRecoveryWorkNow(
      sessionId,
      conversationId,
      `recovery:${recovery.failureEpisodeId}:${recovery.recoveryGeneration}`
    );
  }
  const next: SelfHealingRecoveryState = {
    ...recovery,
    phase: 'recovered',
    replacementConversationId: conversationId,
    lastProgressAt: Date.now(),
    updatedAt: Date.now(),
    error: null
  };
  const marked = await setSessionRecoveryState(sessionId, conversationId, next, {
    failureEpisodeId: recovery.failureEpisodeId,
    recoveryGeneration: recovery.recoveryGeneration,
    phases: [recovery.phase],
    previousConversationId: recovery.previousConversationId,
    replacementConversationId: conversationId
  });
  if (!marked) {
    // Another concurrent ACK/marker may have won the same semantic A→B commit after this caller
    // captured its phase. Treat that exact already-recovered tuple as idempotent success; every
    // different episode/generation/destination remains a real CAS loss.
    const current = await getSession(sessionId).catch(() => null);
    const committed = current?.conversationId === conversationId &&
      current.recovery?.phase === 'recovered' &&
      current.recovery.failureEpisodeId === recovery.failureEpisodeId &&
      current.recovery.recoveryGeneration === recovery.recoveryGeneration &&
      current.recovery.previousConversationId === recovery.previousConversationId &&
      current.recovery.replacementConversationId === conversationId;
    if (!committed) return false;
  }
  // Recovery is not complete until the shared provider-replacement owner is also retired.
  // A crash here is safe: restart sees the recovered WAL edge and retries this exact release.
  return releaseSessionReplacementTransfer(
    sessionId,
    recoveryTransfer(recovery.previousConversationId, recovery.failureEpisodeId, recovery.recoveryGeneration)
  ).catch(() => false);
}

async function reconcileCommittedRecovery(
  sessionId: string,
  recovery: SelfHealingRecoveryState,
  toConversationId: string
): Promise<boolean> {
  const from = recovery.previousConversationId;
  noteResumeOpening(recovery.failureEpisodeId);
  armRecoveryFence(from, durableFenceOwner(recovery.failureEpisodeId, recovery.recoveryGeneration));
  armRecoveryFence(toConversationId, replacementFenceOwner(recovery.failureEpisodeId, recovery.recoveryGeneration));
  try {
    await publishRecoveryRebindProjectionDurably(sessionId, from, toConversationId);
  } catch (error) {
    await noteRetryableProjectionFailure(sessionId, toConversationId, recovery, error);
    return false;
  }
  const lineage = recovery.agentLineage;
  let projectionDurable = lineage === null;
  if (lineage?.role === 'prime') {
    projectionDurable = repairPrimeConversationAfterRecovery(from, toConversationId, lineage) &&
      await persistCriticalSwarmNow().catch(() => false);
  }
  else if (lineage?.role === 'worker') {
    if (repairWorkerConversationAfterRecovery(lineage.agentId, lineage.runId, from, toConversationId, lineage)) {
      bindAgentWorkspace(lineage.agentId, toConversationId, lineage.runId);
      projectionDurable = await persistCriticalSwarmNow().catch(() => false);
    } else projectionDurable = false;
  } else if (agentInfoForOwnedConversation(from) || agentInfoForOwnedConversation(toConversationId)) {
    projectionDurable = false;
  }
  if (!projectionDurable) return false;
  const recovered = await markRecoveryRecovered(
    sessionId,
    toConversationId,
    { ...recovery, replacementConversationId: toConversationId }
  );
  if (recovered) {
    endResumeClaim(recovery.failureEpisodeId);
    disarmRecoveryFence(from, durableFenceOwner(recovery.failureEpisodeId, recovery.recoveryGeneration));
    disarmRecoveryFence(toConversationId, replacementFenceOwner(recovery.failureEpisodeId, recovery.recoveryGeneration));
  }
  return recovered;
}

async function noteRetryableProjectionFailure(
  sessionId: string,
  conversationId: string,
  recovery: SelfHealingRecoveryState,
  error: unknown
): Promise<void> {
  const message = clip(error instanceof Error ? error.message : String(error), 500);
  await setSessionRecoveryState(sessionId, conversationId, {
    ...recovery,
    phase: 'reconciling',
    replacementConversationId: conversationId,
    updatedAt: Date.now(),
    error: message
  }, {
    failureEpisodeId: recovery.failureEpisodeId,
    recoveryGeneration: recovery.recoveryGeneration,
    phases: ['reconciling', 'hard_recovery'],
    previousConversationId: recovery.previousConversationId,
    replacementConversationId: conversationId
  }).catch(() => false);
}

/** Repairs crash windows where the durable A→B session move landed before projections did. */
export async function reconcileSelfHealingAfterRestart(): Promise<number> {
  // This function is also called by bridge command restore after the app-level startup barrier
  // has already rebuilt the fences. Never clear process-local owners here: MCP connect may be
  // live by that second pass, and a clear/re-arm gap would briefly re-admit old A. A true process
  // restart starts with an empty map naturally; tests that simulate one reset the map explicitly.
  let repaired = 0;
  for (const session of await indexedSessions()) {
    const recovery = session.recovery;
    if (!recovery) continue;
    if (recovery.phase === 'recovery_failed' &&
        (recovery.destinationSend.state === 'dispatched-unresolved' || recovery.destinationSend.state === 'sent')) {
      // A terminal reconciliation timeout is bounded work, not proof that native Send did not
      // happen. Restore the same fail-closed admission fences after every process restart; only a
      // later exact reconciliation or explicit user action may retire this ambiguous transaction.
      noteResumeOpening(recovery.failureEpisodeId);
      armRecoveryFence(
        recovery.previousConversationId,
        durableFenceOwner(recovery.failureEpisodeId, recovery.recoveryGeneration)
      );
      if (recovery.destinationSend.conversationId) {
        armRecoveryFence(
          recovery.destinationSend.conversationId,
          replacementFenceOwner(recovery.failureEpisodeId, recovery.recoveryGeneration)
        );
      }
      continue;
    }
    if (recovery.phase === 'hard_recovery' && !recovery.replacementConversationId &&
        session.conversationId === recovery.previousConversationId) {
      noteResumeOpening(recovery.failureEpisodeId);
      armRecoveryFence(
        recovery.previousConversationId,
        durableFenceOwner(recovery.failureEpisodeId, recovery.recoveryGeneration)
      );
      // Native Send crossed and the provider destination was already durably identified before
      // the app crashed. That checkpoint is sufficient to resume the exact A→B transaction; it is
      // explicitly *not* permission to reconstruct/open another browser command. Fence B before
      // touching any projections so its restored tab cannot become a shadow executor meanwhile.
      if (recovery.destinationSend.state === 'sent' && recovery.destinationSend.conversationId) {
        const destination = recovery.destinationSend.conversationId;
        armRecoveryFence(
          destination,
          replacementFenceOwner(recovery.failureEpisodeId, recovery.recoveryGeneration)
        );
        try {
          const result = await commitEmergencyResume(session.id, recovery.failureEpisodeId, destination);
          if (result.status === 'committed') repaired += 1;
          else if (result.status === 'retryable') {
            logWarn(`self-healing: sent recovery for ${session.id} remains pending after restart — ${result.reason}`);
          }
        } catch (error) {
          logWarn(`self-healing: sent recovery for ${session.id} could not resume after restart — ${error instanceof Error ? error.message : String(error)}`);
        }
        continue;
      }
      continue;
    }
    if (!recovery.replacementConversationId) continue;
    if (recovery.phase !== 'reconciling' && recovery.phase !== 'hard_recovery' && recovery.phase !== 'recovered') continue;
    if (session.conversationId !== recovery.replacementConversationId) continue;
    noteResumeOpening(recovery.failureEpisodeId);
    armRecoveryFence(
      recovery.previousConversationId,
      durableFenceOwner(recovery.failureEpisodeId, recovery.recoveryGeneration)
    );
    if (recovery.phase !== 'recovered') {
      armRecoveryFence(
        recovery.replacementConversationId,
        replacementFenceOwner(recovery.failureEpisodeId, recovery.recoveryGeneration)
      );
    }
    try {
      if (await reconcileCommittedRecovery(session.id, recovery, recovery.replacementConversationId)) repaired += 1;
    } catch (error) {
      await noteRetryableProjectionFailure(session.id, recovery.replacementConversationId, recovery, error);
      logWarn(`self-healing: restart reconciliation for ${session.id} will retry — ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return repaired;
}

export async function failSelfHealingRecovery(
  sessionId: string,
  conversationId: string,
  episodeId: string,
  generation: number,
  expectedPhase: SelfHealingRecoveryState['phase'],
  error: string,
  options: { retainAdmissionFences?: boolean } = {}
): Promise<boolean> {
  const session = await getSession(sessionId);
  const held = session?.recovery;
  if (!session || session.conversationId !== conversationId || !held || held.failureEpisodeId !== episodeId ||
      held.recoveryGeneration !== generation || held.phase !== expectedPhase) return false;
  const failed = await setSessionRecoveryState(sessionId, conversationId, {
    ...held,
    phase: 'recovery_failed',
    updatedAt: Date.now(),
    lastRecoveryAt: Date.now(),
    error: clip(error, 500)
  }, {
    failureEpisodeId: held.failureEpisodeId,
    recoveryGeneration: held.recoveryGeneration,
    phases: [expectedPhase],
    previousConversationId: held.previousConversationId,
    replacementConversationId: held.replacementConversationId
  });
  if (failed && options.retainAdmissionFences !== true) {
    // Terminal non-ambiguous recovery no longer owns provider replacement. Release only this exact
    // transaction; a continuation/newer recovery claim is never disturbed by a stale callback.
    await releaseSessionReplacementTransfer(
      sessionId,
      recoveryTransfer(held.previousConversationId, held.failureEpisodeId, held.recoveryGeneration)
    ).catch(() => false);
    disarmRecoveryFence(conversationId, durableFenceOwner(held.failureEpisodeId, held.recoveryGeneration));
    if (held.replacementConversationId) {
      disarmRecoveryFence(
        held.replacementConversationId,
        replacementFenceOwner(held.failureEpisodeId, held.recoveryGeneration)
      );
    }
    endResumeClaim(held.failureEpisodeId);
  }
  return failed;
}

/** Test seam for readable phase labels without duplicating policy in the renderer. */
export function recoveryStatusLabel(state: SelfHealingRecoveryState | null | undefined): string {
  switch (state?.phase) {
    case 'suspected_stall': return 'Suspected stall';
    case 'soft_recovery': return 'Reloading';
    case 'hard_recovery': return 'Rebinding';
    case 'reconciling': return 'Reconciling';
    case 'recovered': return 'Recovered';
    case 'recovery_failed': return 'Recovery failed';
    default: return 'Healthy';
  }
}

export function isPrimeRecoveryAgent(agent: AgentInfo | null): boolean {
  return agent?.id === PRIME_ID && agent.role === 'prime';
}
