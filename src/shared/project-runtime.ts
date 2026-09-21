/**
 * Project-owned runtime contract.
 *
 * A project profile is optional. When absent, CoS behaves exactly as it did before project
 * profiles existed. When present, it names reusable direct-exec tasks and machine-verifiable
 * completion checks without moving mission authority out of the durable session runtime.
 */

export const PROJECT_RUNTIME_PROFILE_PATH = '.cos/project.json';
export const PROJECT_RUNTIME_PROFILE_VERSION = 1 as const;

export interface ProjectRuntimeTask {
  argv: string[];
  timeoutMs: number;
  description?: string;
}

export type ProjectCompletionCheck =
  | { kind: 'task_success'; task: string }
  | { kind: 'path_exists'; path: string }
  | { kind: 'path_absent'; path: string };

export interface ProjectCompletionRule {
  mode: 'all' | 'any';
  /** Opt-in: the Long-Run supervisor may evaluate this rule before auto-continuing. */
  autoStop: boolean;
  checks: ProjectCompletionCheck[];
}

export interface ProjectRuntimeProfile {
  version: typeof PROJECT_RUNTIME_PROFILE_VERSION;
  tasks: Record<string, ProjectRuntimeTask>;
  completion: ProjectCompletionRule | null;
}

export type ProjectCompletionCheckState = 'satisfied' | 'unsatisfied' | 'blocked';

export interface ProjectCompletionCheckResult {
  check: ProjectCompletionCheck;
  state: ProjectCompletionCheckState;
  detail: string;
  durationMs?: number;
  exitCode?: number | null;
  timedOut?: boolean;
}

export type ProjectCompletionState =
  | 'unconfigured'
  | 'satisfied'
  | 'unsatisfied'
  | 'blocked';

export interface ProjectCompletionResult {
  state: ProjectCompletionState;
  projectId: string | null;
  projectName: string | null;
  profilePath: string | null;
  mode: 'all' | 'any' | null;
  checks: ProjectCompletionCheckResult[];
}
