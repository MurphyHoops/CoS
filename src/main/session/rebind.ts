/**
 * Publishes the in-memory projections of an already-durable session rebind.
 *
 * This function owns no transaction and grants no authority to move a session. Callers must
 * first prove `rebindSession()` committed A→B (or recover that fact from session metadata).
 * Keeping these total map moves together prevents Compact & Resume and Emergency Resume from
 * drifting on which session-owned projections follow the durable identity.
 */

import {
  moveGoalObjective,
  moveGoalObjectiveNow,
  moveGoalReplyNow,
  moveGoalSwitch,
  moveGoalSwitchNow,
  retireGoalDraftsFor
} from '../goal.js';
import { moveChatWorkspace } from '../workspace.js';
import { rebindConversation } from './recorder.js';

export function publishSessionRebindProjection(
  sessionId: string,
  fromConversationId: string,
  toConversationId: string
): void {
  rebindConversation(sessionId, fromConversationId, toConversationId);
  moveChatWorkspace(fromConversationId, toConversationId);
  moveGoalObjective(fromConversationId, toConversationId);
  moveGoalSwitch(fromConversationId, toConversationId);
  // A's final belongs to the executor that was retired. B earns its own Goal/Loop reply debt.
  retireGoalDraftsFor(fromConversationId);
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
  // Provider-generated draft text is disposable; the durable reply obligation above is not.
  retireGoalDraftsFor(fromConversationId, true);
}
