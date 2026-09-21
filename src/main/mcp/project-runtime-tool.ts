import { z } from 'zod';
import {
  evaluateSessionProjectCompletion,
  loadSessionProjectRuntimeProfile,
  ProjectRuntimeAuthorityError
} from '../project-runtime.js';
import { getSession } from '../session/store.js';
import { currentCaller } from './call-context.js';
import { fail, failIdentity, guard, type SurfaceRegistrar } from './kernel.js';
import { toolDeclaration } from './tool-declarations.js';

function profileSummary(loaded: Awaited<ReturnType<typeof loadSessionProjectRuntimeProfile>>): string {
  if (!loaded) return 'No local project is bound to this durable session.';
  if (!loaded.profile) {
    return `Project ${loaded.projectName} has no .cos/project.json runtime profile. Existing behavior is unchanged.`;
  }
  const tasks = Object.keys(loaded.profile.tasks);
  const completion = loaded.profile.completion;
  return [
    `Project runtime profile loaded for ${loaded.projectName}.`,
    `Tasks: ${tasks.length ? tasks.join(', ') : 'none'}.`,
    completion
      ? `Completion: ${completion.mode} of ${completion.checks.length} configured check(s).`
      : 'Completion: not configured.'
  ].join(' ');
}

export function projectRuntimeStatusProfileForTests(
  profile: NonNullable<Awaited<ReturnType<typeof loadSessionProjectRuntimeProfile>>>['profile']
): Record<string, unknown> | null {
  if (!profile) return null;
  return {
    version: profile.version,
    // Executable argv stays local. Status exposes capability names/descriptions, not command text.
    tasks: Object.entries(profile.tasks).map(([name, task]) => ({
      name,
      ...(task.description ? { description: task.description } : {})
    })),
    completion: profile.completion
      ? {
          mode: profile.completion.mode,
          auto_stop: profile.completion.autoStop,
          checks: profile.completion.checks.map(check => ({ ...check }))
        }
      : null
  };
}

/**
 * One project procedure rather than separate task/status/completion tools.
 *
 * The profile is project-owned input. CoS validates it and keeps execution inside the already
 * bound project; task checks still require the live command capability.
 */
export function registerProjectRuntimeTool(reg: SurfaceRegistrar): void {
  reg.register(
    'project_runtime',
    toolDeclaration('project_runtime', () => ({
      title: 'Inspect project runtime',
      description:
        'Inspect or machine-check the optional .cos/project.json contract for the current local project. ' +
        'action=status only reads the validated profile. action=check evaluates its completion predicates; task_success checks run the named direct-exec argv in the bound project and therefore require current command permission. ' +
        'A missing profile is valid and leaves normal CoS behavior unchanged. This tool does not create work or change mission authority.',
      inputSchema: z.object({
        action: z.enum(['status', 'check'])
      }).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        // action=check may execute arbitrary project-owned verifier argv. A lost response is not
        // authority to replay that side effect.
        idempotentHint: false,
        openWorldHint: true
      }
    })),
    ({ action }) => guard('project_runtime', async () => {
      if (!reg.sessionToolsLive) return reg.featureDisabled('Session recording', 'Settings → Chat');
      const caller = currentCaller();
      if (!caller.sessionId || !caller.conversationId) {
        return failIdentity('Exact durable session and conversation identity are required for project runtime checks.');
      }
      const session = await getSession(caller.sessionId);
      if (!session || session.conversationId !== caller.conversationId) {
        return fail('This conversation no longer owns the durable session. No project runtime task was run.');
      }
      const projectId = session.projectId ?? null;
      const currentAuthority = async () => {
        const current = await getSession(caller.sessionId!);
        return !!current && current.conversationId === caller.conversationId &&
          (current.projectId ?? null) === projectId;
      };
      if (!reg.caps.read) {
        return fail('File read permission is disabled. The project runtime profile was not read.');
      }

      if (action === 'status') {
        const loaded = await loadSessionProjectRuntimeProfile(caller.sessionId);
        if (!await currentAuthority()) {
          return fail('This conversation no longer owns the durable session/project. No project runtime data was returned.');
        }
        return {
          content: [{ type: 'text' as const, text: profileSummary(loaded) }],
          structuredContent: loaded
            ? {
                project_id: loaded.projectId,
                project_name: loaded.projectName,
                profile_path: loaded.profilePath,
                configured: loaded.profile !== null,
                profile: projectRuntimeStatusProfileForTests(loaded.profile)
              }
            : {
                project_id: null,
                project_name: null,
                profile_path: null,
                configured: false,
                profile: null
              }
        };
      }

      let result;
      try {
        result = await evaluateSessionProjectCompletion(caller.sessionId, {
          allowCommands: reg.caps.command,
          allowMetadata: reg.caps.metadata,
          authority: currentAuthority
        });
      } catch (error) {
        if (error instanceof ProjectRuntimeAuthorityError) return fail(error.message);
        throw error;
      }
      const detail = result.state === 'satisfied'
        ? 'Project completion predicates are satisfied.'
        : result.state === 'unconfigured'
          ? 'No machine completion predicate is configured for this project.'
          : result.state === 'blocked'
            ? 'Project completion could not be fully evaluated with the current permissions/environment.'
            : 'Project completion predicates are not yet satisfied.';
      return {
        content: [{ type: 'text' as const, text: detail }],
        structuredContent: {
          state: result.state,
          project_id: result.projectId,
          project_name: result.projectName,
          profile_path: result.profilePath,
          mode: result.mode,
          checks: result.checks
        }
      };
    })
  );
}
