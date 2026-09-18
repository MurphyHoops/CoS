import { z } from 'zod';
import { backgroundExecObligations, execOwner } from '../codex/ownership.js';
import {
  armLongRunWaitNow,
  cancelLongRunNow,
  longRunStatus
} from '../session/long-run.js';
import { getSession } from '../session/store.js';
import { currentCaller, runningToolCalls } from './call-context.js';
import { fail, failIdentity, guard, ok, type SurfaceRegistrar } from './kernel.js';
import { toolDeclaration } from './tool-declarations.js';

const repoPattern = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

/**
 * Registers a local durable wait primitive.
 *
 * This is intentionally a session tool rather than an exec primitive: its job is to end the
 * provider turn while CoS waits locally, then wake the same durable task when the condition
 * changes.  The condition carries no mutation authority of its own.
 */
export function registerLongRunWaitTool(reg: SurfaceRegistrar): void {
  reg.register('session_wait', toolDeclaration('session_wait', () => ({
    title: 'Wait outside this turn',
    description:
      'Hand a long external wait to the local CoS supervisor, then finish this turn instead of polling. ' +
      'Use action=arm for GitHub Actions runs, a background exec session, or a timer. CoS durably monitors it and queues one continuation when it resolves. ' +
      'Arming is a hard provider-turn boundary: ordinary tools from this executor are refused until resolution or cancel. Use status to inspect the durable wait/work obligation and cancel to revoke it.',
    inputSchema: z.object({
      action: z.enum(['arm', 'status', 'cancel']),
      kind: z.enum(['github_run', 'process', 'timer']).optional(),
      repository: z.string().max(201).optional().describe('github_run: owner/repo.'),
      run_id: z.number().int().positive().optional().describe('github_run: GitHub Actions run id.'),
      process_session_id: z.number().int().positive().optional().describe('process: session_id returned by this durable session’s exec_command.'),
      seconds: z.number().int().min(1).max(86400).optional().describe('timer: local wait duration in seconds.'),
      description: z.string().max(300).optional()
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  })), input => guard('session_wait', async () => {
    if (!reg.sessionToolsLive) return reg.featureDisabled('Session recording', 'Settings → Chat');
    const caller = currentCaller();
    if (!caller.sessionId || !caller.conversationId) {
      return failIdentity('Exact durable session and conversation identity are required for long-run wait control.');
    }
    const session = await getSession(caller.sessionId);
    if (!session || session.conversationId !== caller.conversationId) {
      return fail('This conversation no longer owns the durable session. No wait state was changed.');
    }

    // Once this exact provider request has armed a wait, it has surrendered ordinary execution
    // authority. Do not let it keep the provider turn alive by replacing gh/write_stdin polling
    // with session_wait status (or repeated arm calls). Cancel is the sole escape hatch because
    // it explicitly revokes the durable wait and resumes this executor.
    const held = longRunStatus(caller.sessionId);
    const sourceWaitStillActive =
      held.wait?.state === 'waiting' &&
      held.work?.state === 'waiting' &&
      !!held.work.sourceRequestId &&
      held.work.sourceRequestId === caller.requestId;
    if (sourceWaitStillActive && input.action !== 'cancel') {
      return fail(
        'WAIT_ARMED_FINISH_TURN: this provider turn already handed its external wait to CoS. ' +
        'Do not poll status or repeat arm from this turn. Finish the turn now; use session_wait cancel only if you intend to revoke the wait.'
      );
    }

    if (input.action === 'status') {
      const status = longRunStatus(caller.sessionId);
      return {
        content: [{ type: 'text' as const, text: status.wait
          ? `Durable wait ${status.wait.kind} is ${status.wait.state}; continuation work is ${status.work?.state ?? 'none'}.`
          : `No durable external wait is active; continuation work is ${status.work?.state ?? 'none'}.` }],
        structuredContent: status
      };
    }

    if (input.action === 'cancel') {
      const changed = await cancelLongRunNow(caller.sessionId, caller.conversationId, 'cancelled_by_executor');
      return changed ? ok('Durable long-run wait/work obligation cancelled.') : fail('The durable executor changed; no long-run state was cancelled.');
    }

    if (!input.kind) return fail('action=arm requires kind.');
    if (!caller.requestId) {
      return failIdentity(
        'WAIT_REQUEST_ID_PENDING: this provider turn has no exact MCP request identity yet, so no external wait was armed. Retry session_wait once; no wait state changed.'
      );
    }
    // The source provider turn is the causality boundary for this wait. Without a durable turn id
    // the old turn's eventual final cannot be distinguished from the future continuation, so fail
    // closed and let the model retry this one idempotent admission after recorder attribution lands.
    if (!session.activeTurnId) {
      return fail(
        'WAIT_TURN_ID_PENDING: this turn is not durably identified yet, so no external wait was armed. ' +
        'Retry session_wait once; do not start a polling loop or run replacement work.'
      );
    }
    // An armed wait is a turn cut. Do not publish that cut while a sibling handler from the same
    // executor is still capable of mutating local state; the current session_wait itself accounts
    // for one running call. Background exec sessions are not counted here because their launching
    // MCP call has already returned and the process wait explicitly names their durable session id.
    if (runningToolCalls(caller.conversationId) > 1) {
      return fail(
        'WAIT_INFLIGHT_TOOLS: another local tool from this conversation is still running, so no wait was armed. ' +
        'Let that call settle, reconcile its result, then retry session_wait once.'
      );
    }
    if (input.kind === 'github_run') {
      if (!input.repository || !repoPattern.test(input.repository) || !input.run_id) {
        return fail('github_run requires repository=owner/repo and run_id.');
      }
    } else if (input.kind === 'process') {
      if (!input.process_session_id) return fail('process requires process_session_id.');
      if (execOwner(input.process_session_id) !== caller.sessionId) {
        return fail('That process session is not owned by this durable session.');
      }
      const state = backgroundExecObligations(caller.sessionId);
      if (!state.running.includes(input.process_session_id) &&
          !state.exitedUnread.some((row) => row.processId === input.process_session_id)) {
        return fail('That process session is no longer retained by this durable session.');
      }
    } else if (!input.seconds) {
      return fail('timer requires seconds.');
    }

    const wait = await armLongRunWaitNow({
      sessionId: caller.sessionId,
      conversationId: caller.conversationId,
      sourceTurnId: session.activeTurnId,
      sourceRequestId: caller.requestId,
      kind: input.kind,
      repository: input.kind === 'github_run' ? input.repository! : null,
      runId: input.kind === 'github_run' ? input.run_id! : null,
      processId: input.kind === 'process' ? input.process_session_id! : null,
      dueAt: input.kind === 'timer' ? Date.now() + input.seconds! * 1000 : null,
      description: input.description ?? null
    });

    return {
      content: [{
        type: 'text' as const,
        text:
          `Durable ${wait.kind} wait armed. Finish this turn now; CoS will monitor it locally and queue exactly one continuation when it resolves. ` +
          'Ordinary tools in this executor are now fenced; only session_wait status/cancel remains available until the wait resolves.'
      }],
      structuredContent: {
        wait_id: wait.id,
        kind: wait.kind,
        state: wait.state,
        next_check_at: wait.nextCheckAt
      }
    };
  }));
}
