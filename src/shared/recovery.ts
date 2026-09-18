/** Read-only projection of an existing recovery deadline. Never authorizes an action. */
export type RecoveryCountdown = {
  kind: 'unattributed' | 'unattributed-wait' | 'thinking-failed' | 'native-busy' | 'silence' | 'post-reload';
  deadline: number;
  /** The existing UI clock reveals this row without needing a new backend event. */
  visibleAt?: number;
  next?: 'queue' | 'goal' | 'loop';
};

/** Durable phase of one provider-failure episode for a local session. */
export type SelfHealingPhase =
  | 'healthy'
  | 'suspected_stall'
  | 'soft_recovery'
  | 'hard_recovery'
  | 'reconciling'
  | 'recovered'
  | 'recovery_failed';

/** Why a recovery episode exists. These are canonical evidence classes, not scraped prose. */
export type SelfHealingFailureKind =
  | 'silence'
  | 'turn-stalled'
  | 'turn-unknown'
  | 'provider-error'
  | 'tab-missing'
  | 'tunnel-interrupted'
  | 'worker-unresponsive'
  | 'prime-unresponsive';

/** Whether retrying the interrupted model work could duplicate a side effect. */
export type RecoveryMutationSafety = 'read_only_safe_retry' | 'mutating_or_ambiguous';

/** Durable broker lineage captured before a provider executor is replaced. */
export interface SelfHealingAgentLineage {
  role: 'prime' | 'worker';
  agentId: string;
  runId: string;
  /** Prime conversation that owns this run at the time recovery begins. */
  primeConversationId: string;
  /** Stable worker assignment identity; empty for Prime. */
  task: string;
  /** Distinguishes a reused friendly worker id from an older incarnation. */
  createdAt: number;
}

/** Durable positions of the Emergency Resume bootstrap around the native Send boundary. */
export type SelfHealingSendState =
  | 'not-attempted'
  | 'attempted-unresolved'
  | 'dispatched-unresolved'
  | 'sent';

export interface SelfHealingDestinationCheckpoint {
  state: SelfHealingSendState;
  /** Bridge command whose page owns this send attempt. Null before any page prepares Send. */
  commandId: string | null;
  /** Durable pre-click timestamp used to bound ambiguous post-dispatch custody. */
  dispatchedAt: number | null;
  /** Provider destination once ACK or the stable Emergency Resume marker proves it. */
  conversationId: string | null;
  /** Stable provider-authored user-message id when marker reconciliation supplied one. */
  messageId: string | null;
}

/**
 * Constant-size recovery WAL kept in session metadata.
 *
 * The session remains the sole authority for its current conversation. This record explains
 * why that attachment is being repaired and gives restart enough evidence to finish or refuse
 * the recovery without inventing a second owner.
 */
export interface SelfHealingRecoveryState {
  phase: SelfHealingPhase;
  failureEpisodeId: string;
  recoveryGeneration: number;
  recoveryAttempts: number;
  lastRecoveryAt: number | null;
  lastProgressAt: number | null;
  previousConversationId: string;
  replacementConversationId: string | null;
  failureKind: SelfHealingFailureKind;
  mutationSafety: RecoveryMutationSafety;
  /**
   * Null means this session was not broker-owned when the failure episode was admitted. Once
   * present it is the only authority restart reconciliation may use to move Prime/worker state;
   * a conversation currently bound to B is never accepted as substitute lineage proof.
   */
  agentLineage: SelfHealingAgentLineage | null;
  /**
   * Browser-send custody. `dispatched-unresolved` is deliberately non-replayable: the click may
   * have crossed even when neither the provider route nor the command ACK reached the app.
   */
  destinationSend: SelfHealingDestinationCheckpoint;
  updatedAt: number;
  error: string | null;
}

/** Named policy constants keep recovery timing reviewable and prevent retry storms. */
export const SELF_HEAL_SUSPECT_MS = 3 * 60_000;
export const SELF_HEAL_WORKER_NO_PROGRESS_MS = 5 * 60_000;
export const SELF_HEAL_POST_RELOAD_MS = 75_000;
export const SELF_HEAL_COOLDOWN_MS = 3 * 60_000;
export const SELF_HEAL_MAX_SOFT_RELOADS = 1;
/** After an irreversible recovery Send dispatch, wait for ACK/marker proof without replaying it. */
export const SELF_HEAL_MARKER_RECONCILE_MS = 5 * 60_000;
