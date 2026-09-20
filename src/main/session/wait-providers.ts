import { runCommand } from '../exec.js';
import { backgroundExecObligations, execOwner } from '../codex/ownership.js';
import type { LongRunWaitContract, LongRunWaitKind } from './long-run.js';

export type LongRunWaitVerdict =
  | { kind: 'pending'; nextCheckAt?: number }
  | { kind: 'resolved'; result: string; failed: boolean }
  | { kind: 'error'; error: string };

export interface LongRunWaitProvider {
  kind: LongRunWaitKind;
  inspect(wait: LongRunWaitContract, now: number): Promise<LongRunWaitVerdict>;
  describe(wait: LongRunWaitContract, detail: string): string;
}

const providers = new Map<string, LongRunWaitProvider>();

export function registerLongRunWaitProvider(provider: LongRunWaitProvider): void {
  if (!/^[a-z][a-z0-9_.-]{1,63}$/.test(provider.kind)) throw new Error('invalid_long_run_provider_kind');
  if (providers.has(provider.kind)) throw new Error(`long_run_provider_already_registered:${provider.kind}`);
  providers.set(provider.kind, provider);
}

export function longRunWaitProvider(kind: string): LongRunWaitProvider | null {
  return providers.get(kind) ?? null;
}

export function registeredLongRunWaitProviders(): string[] {
  return [...providers.keys()].sort();
}

function describeGithub(wait: LongRunWaitContract, detail: string): string {
  return `GitHub Actions run ${wait.runId} for ${wait.repository}: ${detail}`;
}

registerLongRunWaitProvider({
  kind: 'github_run',
  describe: describeGithub,
  async inspect(wait) {
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
        result: describeGithub(wait, `completed with conclusion ${conclusion}`),
        failed: conclusion !== 'success'
      };
    } catch {
      return { kind: 'error', error: 'GitHub status response was not valid JSON.' };
    }
  }
});

registerLongRunWaitProvider({
  kind: 'process',
  describe: (wait, detail) => `Background process session ${wait.processId}: ${detail}`,
  async inspect(wait) {
    const state = backgroundExecObligations(wait.sessionId);
    if (state.running.includes(wait.processId!)) return { kind: 'pending' };
    const exited = state.exitedUnread.find((row) => row.processId === wait.processId);
    if (exited) {
      return {
        kind: 'resolved',
        result: `Background process session ${wait.processId}: exited with code ${exited.exitCode ?? 'unknown'}; its retained output will be delivered by the normal exec result channel`,
        failed: exited.exitCode !== 0
      };
    }
    const owner = execOwner(wait.processId!);
    return {
      kind: 'resolved',
      result: `Background process session ${wait.processId}: ${owner && owner !== wait.sessionId
        ? 'is no longer owned by this durable session; reconcile state before acting'
        : 'is no longer retained by this CoS process; reconcile files/process state before deciding whether any command needs to run again'}`,
      failed: true
    };
  }
});

registerLongRunWaitProvider({
  kind: 'timer',
  describe: (_wait, detail) => `Timer wait completed: ${detail}`,
  async inspect(wait, now) {
    if ((wait.dueAt ?? Number.MAX_SAFE_INTEGER) > now) {
      return { kind: 'pending', nextCheckAt: wait.dueAt! };
    }
    return { kind: 'resolved', result: 'Timer wait completed: deadline reached', failed: false };
  }
});
