import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { rawPromises as fs } from './rawfs.js';
import { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, runCommand } from './exec.js';
import { getProject, projectWorkspace } from './projects.js';
import { resolvePath, SandboxError } from './sandbox.js';
import { getSession } from './session/store.js';
import type { Root } from '../shared/types.js';
import {
  PROJECT_RUNTIME_PROFILE_PATH,
  PROJECT_RUNTIME_PROFILE_VERSION,
  type ProjectCompletionCheck,
  type ProjectCompletionCheckResult,
  type ProjectCompletionResult,
  type ProjectRuntimeProfile,
  type ProjectRuntimeTask
} from '../shared/project-runtime.js';

export const MAX_PROJECT_RUNTIME_PROFILE_BYTES = 64 * 1024;
export const MAX_PROJECT_RUNTIME_TASKS = 32;
export const MAX_PROJECT_RUNTIME_CHECKS = 32;
export const MAX_PROJECT_RUNTIME_ARGV = 64;
export const MAX_PROJECT_RUNTIME_ARG_CHARS = 4_096;

export interface ProjectRuntimeEvaluationOptions {
  allowCommands: boolean;
  allowMetadata?: boolean;
  authority?: () => boolean | Promise<boolean>;
}

export class ProjectRuntimeAuthorityError extends Error {
  constructor() {
    super('This executor no longer owns the durable session/project. No further project runtime check was started.');
    this.name = 'ProjectRuntimeAuthorityError';
  }
}

async function requireEvaluationAuthority(options: ProjectRuntimeEvaluationOptions): Promise<void> {
  if (options.authority && !await options.authority()) throw new ProjectRuntimeAuthorityError();
}

const taskNameSchema = z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/);
const relativeProjectPathSchema = z.string().min(1).max(4_096).refine(value => {
  if (value.startsWith('/') || value.includes('\\') || /^[A-Za-z]:/.test(value)) return false;
  const parts = value.split('/');
  return parts.every(part => part.length > 0 && part !== '.' && part !== '..' && !part.includes('\0'));
}, 'Use a project-relative forward-slash path without . or .. segments');

const taskSchema = z.object({
  argv: z.array(z.string().min(1).max(MAX_PROJECT_RUNTIME_ARG_CHARS)).min(1).max(MAX_PROJECT_RUNTIME_ARGV),
  timeout_ms: z.number().int().min(1_000).max(MAX_TIMEOUT_MS).optional(),
  description: z.string().min(1).max(300).optional()
}).strict();

const completionCheckSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('task_success'), task: taskNameSchema }).strict(),
  z.object({ kind: z.literal('path_exists'), path: relativeProjectPathSchema }).strict(),
  z.object({ kind: z.literal('path_absent'), path: relativeProjectPathSchema }).strict()
]);

const profileSchema = z.object({
  version: z.literal(PROJECT_RUNTIME_PROFILE_VERSION),
  tasks: z.record(taskNameSchema, taskSchema).optional().default({}),
  completion: z.object({
    mode: z.enum(['all', 'any']).optional().default('all'),
    auto_stop: z.boolean().optional().default(false),
    checks: z.array(completionCheckSchema).min(1).max(MAX_PROJECT_RUNTIME_CHECKS)
  }).strict().optional()
}).strict().superRefine((value, ctx) => {
  const names = Object.keys(value.tasks);
  if (names.length > MAX_PROJECT_RUNTIME_TASKS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['tasks'],
      message: `Too many tasks (limit ${MAX_PROJECT_RUNTIME_TASKS})`
    });
  }
  for (const [index, check] of (value.completion?.checks ?? []).entries()) {
    if (check.kind === 'task_success' && !Object.prototype.hasOwnProperty.call(value.tasks, check.task)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['completion', 'checks', index, 'task'],
        message: `Unknown task "${check.task}"`
      });
    }
  }
});

export interface LoadedProjectRuntimeProfile {
  projectId: string;
  projectName: string;
  projectReal: string;
  profilePath: string;
  profile: ProjectRuntimeProfile | null;
}

function normalizeTask(raw: z.infer<typeof taskSchema>): ProjectRuntimeTask {
  return {
    argv: [...raw.argv],
    timeoutMs: raw.timeout_ms ?? DEFAULT_TIMEOUT_MS,
    ...(raw.description ? { description: raw.description } : {})
  };
}

export function parseProjectRuntimeProfile(raw: unknown): ProjectRuntimeProfile {
  const parsed = profileSchema.parse(raw);
  return {
    version: PROJECT_RUNTIME_PROFILE_VERSION,
    tasks: Object.fromEntries(Object.entries(parsed.tasks).map(([name, task]) => [name, normalizeTask(task)])),
    completion: parsed.completion
      ? {
          mode: parsed.completion.mode,
          autoStop: parsed.completion.auto_stop,
          checks: parsed.completion.checks.map(check => ({ ...check })) as ProjectCompletionCheck[]
        }
      : null
  };
}

function projectRoot(projectReal: string): Root {
  return { name: 'project', path: projectReal };
}

function sameFilesystemPath(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function sameFileIdentity(
  left: { dev: number; ino: number },
  right: { dev: number; ino: number }
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function readBoundedProjectFile(
  projectReal: string,
  relativePath: string,
  maxBytes: number
): Promise<Buffer | null> {
  const virtual = `/project/${relativePath}`;
  const resolved = await resolvePath([projectRoot(projectReal)], virtual, { allowMissing: true });
  let before;
  try {
    before = await fs.lstat(resolved.real);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`${relativePath} must be a regular file`);
  }

  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(resolved.real, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFileIdentity(before, opened)) {
      throw new SandboxError('Project runtime profile changed during sandbox validation');
    }
    if (opened.size > maxBytes) {
      throw new Error(`${relativePath} is too large (limit ${maxBytes} bytes)`);
    }

    // Read at most one byte beyond the contract limit from the already-open descriptor. This
    // bounds memory even if the file grows after fstat and lets us reject that race explicitly.
    const limit = maxBytes + 1;
    const scratch = Buffer.allocUnsafe(Math.min(16 * 1024, limit));
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const remaining = limit - total;
      if (remaining <= 0) break;
      const { bytesRead } = await handle.read(scratch, 0, Math.min(scratch.length, remaining), null);
      if (bytesRead === 0) break;
      chunks.push(Buffer.from(scratch.subarray(0, bytesRead)));
      total += bytesRead;
    }
    if (total > maxBytes) {
      throw new Error(`${relativePath} is too large (limit ${maxBytes} bytes)`);
    }

    const openedAfterRead = await handle.stat();
    const rechecked = await resolvePath([projectRoot(projectReal)], virtual, { allowMissing: false });
    const after = await fs.lstat(rechecked.real);
    if (
      after.isSymbolicLink() ||
      !after.isFile() ||
      !sameFilesystemPath(rechecked.real, resolved.real) ||
      !sameFileIdentity(opened, openedAfterRead) ||
      !sameFileIdentity(opened, after) ||
      openedAfterRead.size !== opened.size ||
      after.size !== opened.size ||
      openedAfterRead.mtimeMs !== opened.mtimeMs ||
      openedAfterRead.ctimeMs !== opened.ctimeMs
    ) {
      throw new SandboxError('Project runtime profile changed during sandbox validation');
    }
    return Buffer.concat(chunks, total);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readProfileFile(projectReal: string): Promise<ProjectRuntimeProfile | null> {
  const bytes = await readBoundedProjectFile(
    projectReal,
    PROJECT_RUNTIME_PROFILE_PATH,
    MAX_PROJECT_RUNTIME_PROFILE_BYTES
  );
  if (!bytes) return null;
  const text = bytes.toString('utf8');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`${PROJECT_RUNTIME_PROFILE_PATH} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return parseProjectRuntimeProfile(raw);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const detail = error.issues.slice(0, 4).map(issue =>
        `${issue.path.join('.') || 'profile'}: ${issue.message}`
      ).join('; ');
      throw new Error(`${PROJECT_RUNTIME_PROFILE_PATH} is invalid: ${detail}`);
    }
    throw error;
  }
}

export async function loadProjectRuntimeProfile(projectId: string): Promise<LoadedProjectRuntimeProfile> {
  const project = await getProject(projectId);
  if (!project) throw new Error('Project not found');
  const workspace = await projectWorkspace(projectId);
  return {
    projectId: project.id,
    projectName: project.name,
    projectReal: workspace.real,
    profilePath: PROJECT_RUNTIME_PROFILE_PATH,
    profile: await readProfileFile(workspace.real)
  };
}

export async function loadSessionProjectRuntimeProfile(sessionId: string): Promise<LoadedProjectRuntimeProfile | null> {
  const session = await getSession(sessionId);
  if (!session?.projectId) return null;
  return loadProjectRuntimeProfile(session.projectId);
}

async function checkedProjectPathExists(projectReal: string, relativePath: string): Promise<boolean> {
  const virtual = `/project/${relativePath}`;
  const first = await resolvePath([projectRoot(projectReal)], virtual, { allowMissing: true });
  let before;
  try {
    before = await fs.lstat(first.real);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // Re-resolve at the actual decision boundary. A target which appeared in the meantime is
    // evaluated as the current target, and an escaping link is rejected by resolvePath.
    const current = await resolvePath([projectRoot(projectReal)], virtual, { allowMissing: true });
    try {
      const now = await fs.lstat(current.real);
      if (now.isSymbolicLink()) throw new SandboxError('Completion path changed into a link during validation');
      return true;
    } catch (retryError) {
      if ((retryError as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw retryError;
    }
  }
  if (before.isSymbolicLink()) {
    throw new SandboxError('Completion path changed into a link during validation');
  }

  const current = await resolvePath([projectRoot(projectReal)], virtual, { allowMissing: true });
  let after;
  try {
    after = await fs.lstat(current.real);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  if (
    after.isSymbolicLink() ||
    !sameFilesystemPath(current.real, first.real) ||
    !sameFileIdentity(before, after)
  ) {
    throw new SandboxError('Completion path changed during sandbox validation');
  }
  return true;
}

async function evaluatePathCheck(
  projectReal: string,
  check: Extract<ProjectCompletionCheck, { kind: 'path_exists' | 'path_absent' }>,
  options: ProjectRuntimeEvaluationOptions
): Promise<ProjectCompletionCheckResult> {
  await requireEvaluationAuthority(options);
  if (options.allowMetadata === false) {
    return {
      check: { ...check },
      state: 'blocked',
      detail: 'Filesystem metadata access is disabled by the current CoS permissions.'
    };
  }
  try {
    const exists = await checkedProjectPathExists(projectReal, check.path);
    const satisfied = check.kind === 'path_exists' ? exists : !exists;
    return {
      check: { ...check },
      state: satisfied ? 'satisfied' : 'unsatisfied',
      detail: check.kind === 'path_exists'
        ? (exists ? 'path exists' : 'path does not exist')
        : (exists ? 'path still exists' : 'path is absent')
    };
  } catch (error) {
    return {
      check: { ...check },
      state: 'blocked',
      // Sandbox errors are deliberately virtual/path-neutral. Raw OS filesystem errors can carry
      // hidden native roots, so do not echo them into the model-facing structured result.
      detail: error instanceof SandboxError
        ? error.message
        : 'Filesystem metadata could not be evaluated safely.'
    };
  }
}

async function evaluateTaskCheck(
  projectReal: string,
  taskName: string,
  task: ProjectRuntimeTask,
  options: ProjectRuntimeEvaluationOptions
): Promise<ProjectCompletionCheckResult> {
  const check: ProjectCompletionCheck = { kind: 'task_success', task: taskName };
  await requireEvaluationAuthority(options);
  if (!options.allowCommands) {
    return {
      check,
      state: 'blocked',
      detail: 'Command execution is disabled by the current CoS permissions.'
    };
  }
  // The prior predicate or permission check may have yielded. Revalidate immediately before the
  // process custody boundary so a superseded executor cannot start a later verifier command.
  await requireEvaluationAuthority(options);
  try {
    const result = await runCommand(task.argv[0]!, task.argv.slice(1), projectReal, task.timeoutMs);
    const satisfied = !result.timedOut && result.exitCode === 0;
    return {
      check,
      state: satisfied ? 'satisfied' : 'unsatisfied',
      // A verifier is project-owned executable input. Its argv and output may contain local paths,
      // tokens or other secrets, so machine status exposes only bounded execution metadata.
      detail: result.timedOut
        ? `task timed out after ${task.timeoutMs} ms`
        : `task exited with code ${result.exitCode ?? 'unknown'}`,
      durationMs: result.durationMs,
      exitCode: result.exitCode,
      timedOut: result.timedOut
    };
  } catch {
    return {
      check,
      state: 'blocked',
      detail: 'task could not be started or completed'
    };
  }
}

function summarizeCompletion(
  mode: 'all' | 'any',
  checks: ProjectCompletionCheckResult[]
): ProjectCompletionResult['state'] {
  if (mode === 'all') {
    if (checks.every(check => check.state === 'satisfied')) return 'satisfied';
    if (checks.some(check => check.state === 'unsatisfied')) return 'unsatisfied';
    return 'blocked';
  }
  if (checks.some(check => check.state === 'satisfied')) return 'satisfied';
  if (checks.every(check => check.state === 'unsatisfied')) return 'unsatisfied';
  return 'blocked';
}

export async function evaluateProjectCompletion(
  projectId: string,
  options: ProjectRuntimeEvaluationOptions
): Promise<ProjectCompletionResult> {
  await requireEvaluationAuthority(options);
  const loaded = await loadProjectRuntimeProfile(projectId);
  await requireEvaluationAuthority(options);
  if (!loaded.profile?.completion) {
    return {
      state: 'unconfigured',
      projectId: loaded.projectId,
      projectName: loaded.projectName,
      profilePath: loaded.profilePath,
      mode: null,
      checks: []
    };
  }
  const checks: ProjectCompletionCheckResult[] = [];
  for (const check of loaded.profile.completion.checks) {
    if (check.kind === 'task_success') {
      const task = loaded.profile.tasks[check.task]!;
      checks.push(await evaluateTaskCheck(loaded.projectReal, check.task, task, options));
    } else {
      checks.push(await evaluatePathCheck(loaded.projectReal, check, options));
    }
    await requireEvaluationAuthority(options);
  }
  await requireEvaluationAuthority(options);
  return {
    state: summarizeCompletion(loaded.profile.completion.mode, checks),
    projectId: loaded.projectId,
    projectName: loaded.projectName,
    profilePath: loaded.profilePath,
    mode: loaded.profile.completion.mode,
    checks
  };
}

export async function evaluateSessionProjectCompletion(
  sessionId: string,
  options: ProjectRuntimeEvaluationOptions
): Promise<ProjectCompletionResult> {
  await requireEvaluationAuthority(options);
  const session = await getSession(sessionId);
  await requireEvaluationAuthority(options);
  if (!session?.projectId) {
    return {
      state: 'unconfigured',
      projectId: null,
      projectName: null,
      profilePath: null,
      mode: null,
      checks: []
    };
  }
  const projectId = session.projectId;
  const outerAuthority = options.authority;
  return evaluateProjectCompletion(projectId, {
    ...options,
    authority: async () => {
      if (outerAuthority && !await outerAuthority()) return false;
      const current = await getSession(sessionId);
      return current?.projectId === projectId;
    }
  });
}
