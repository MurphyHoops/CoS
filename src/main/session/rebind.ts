/**
 * Converges the secondary projections of an already-durable session rebind.
 *
 * This function owns no transaction and grants no authority to move a session. Callers must
 * first prove `rebindSession()` committed A→B (or recover that fact from session metadata).
 * Durable Goal/Loop owners cross their own commit barriers here; recorder/workspace remain
 * rebuildable process projections. Keeping the moves together prevents Compact & Resume and
 * Emergency Resume from drifting on which session-owned facts follow the durable identity.
 */

import {
  moveGoalObjectiveNow,
  moveGoalReplyNow,
  moveGoalSwitchNow,
  retireGoalDraftsFor,
  retireGoalDraftsForNow
} from '../goal.js';
import { moveChatWorkspace } from '../workspace.js';
import { moveLongRunState, moveLongRunStateNow } from './long-run.js';
import { rebindConversation } from './recorder.js';

export async function publishSessionRebindProjection(
  sessionId: string,
  fromConversationId: string,
  toConversationId: string
): Promise<void> {
  // Goal/Loop rows are durable control state. Commit them under their owning serializers before
  // publishing rebuildable process projections so a successful continuation never falls back to
  // debounced best-effort writes for the authority that crossed A→B.
  if (!(await moveGoalObjectiveNow(fromConversationId, toConversationId))) {
    throw new Error('Goal objective projection refused the session rebind');
  }
  if (!(await moveGoalSwitchNow(fromConversationId, toConversationId))) {
    throw new Error('Goal/Loop switch projection refused the session rebind');
  }
  rebindConversation(sessionId, fromConversationId, toConversationId);
  moveChatWorkspace(fromConversationId, toConversationId);
  moveLongRunState(sessionId, fromConversationId, toConversationId);
  // A's final belongs to the executor that was retired. B earns its own Goal/Loop reply debt.
  await retireGoalDraftsForNow(fromConversationId);
}

/**
 * Crash-consistent projection used only by Emergency Resume.
 *
 * Session metadata is already authoritative when this runs. Recorder/workspace are rebuildable
 * process projections; Goal/Loop are durable chat-owned state and therefore must cross their own
 * fsync boundaries before the recovery WAL may advance to `recovered`. Repeating after a crash is
 * idempotent: an already-moved Goal row is accepted as the committed projection.
 */
export async function publishRecoveryRebindProjectionDurably(
  sessionId: string,
  fromConversationId: string,
  toConversationId: string
): Promise<void> {
  rebindConversation(sessionId, fromConversationId, toConversationId);
  moveChatWorkspace(fromConversationId, toConversationId);
  if (!(await moveGoalObjectiveNow(fromConversationId, toConversationId))) {
    throw new Error('Goal objective projection refused the recovery rebind');
  }
  if (!(await moveGoalSwitchNow(fromConversationId, toConversationId))) {
    throw new Error('Goal/Loop switch projection refused the recovery rebind');
  }
  if (!(await moveGoalReplyNow(fromConversationId, toConversationId, sessionId))) {
    throw new Error('Goal reply projection refused the recovery rebind');
  }
  if (!(await moveLongRunStateNow(sessionId, fromConversationId, toConversationId))) {
    throw new Error('Long-run execution projection refused the recovery rebind');
  }
  // Provider-generated draft text is disposable; the durable reply obligation above is not.
  retireGoalDraftsFor(fromConversationId, true);
}
