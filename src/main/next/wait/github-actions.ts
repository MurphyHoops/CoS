/**
 * Trusted GitHub Actions CI wait adapter for a locally approved fixed repo.
 * Uses the GitHub CLI's existing credentials and read-only run/view command.
 * Model-supplied URLs/repository names cannot redirect this adapter.
 */
import { execFile } from 'node:child_process';
import path from 'node:path';
import type { ExternalWaitProbe, WaitProbeState } from './external-wait.js';

const OWNER_REPO = /^[A-Za-z0-9_.-]{1,100}\/[-A-Za-z0-9_.]{1,100}$/;
const SHA = /^[a-fA-F0-9]{40}$/;
const CI_ID = /^ghrun:([1-9][0-9]{0,14})$/;
const VALID_CONCLUSIONS = new Set([
  'success', 'failure', 'cancelled', 'timed_out', 'action_required',
  'neutral', 'skipped', 'stale', 'startup_failure'
]);
type RunInfo = {
  databaseId: number; status: string; conclusion: string | null; headSha: string; url: string
};
export type TrustedGitHubReader = (executable: string, args: readonly string[],
  signal: AbortSignal, maxOutputBytes: number) => Promise<string>;
const realGitHubCli: TrustedGitHubReader = (executable, args, signal, maxOutputBytes) =>
  new Promise<string>((resolve, reject) => {
    execFile(executable, [...args], {
      timeout: 10_000, maxBuffer: maxOutputBytes,
      windowsHide: true, signal,
      env: { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' }
    }, (error, output) => error ? reject(error) : resolve(output));
  });

export class GitHubActionsCliProbe {
  constructor(
    private readonly executable: string,
    private readonly repo: string,
    private readonly expectedHeadSha?: string,
    private readonly maxOutputBytes = 64_000,
    private readonly readCli: TrustedGitHubReader = realGitHubCli
  ) {
    if (!path.isAbsolute(executable) || !OWNER_REPO.test(repo) ||
        repo.includes('..') ||
        (expectedHeadSha !== undefined && !SHA.test(expectedHeadSha)) ||
        !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1_024 || maxOutputBytes > 128_000)
      throw new Error('UNAPPROVED_GITHUB_CI_SOURCE');
  }

  readonly probe: ExternalWaitProbe = async (kind, sourceEventId, signal): Promise<WaitProbeState> => {
    const matched = CI_ID.exec(sourceEventId);
    if (kind !== 'ci' || !matched || signal.aborted) return { state: 'UNKNOWN' };
    const expectedId = Number(matched[1]);
    let stdout: string;
    try {
      stdout = await this.readCli(this.executable, [
        'run', 'view', String(expectedId), '--repo', this.repo,
        '--json', 'databaseId,status,conclusion,headSha,url'
      ], signal, this.maxOutputBytes);
    } catch {
      return { state: 'UNKNOWN' }; // read failure cannot be counted as completed
    }
    let value: RunInfo;
    try { value = JSON.parse(stdout) as RunInfo; }
    catch { return { state: 'UNKNOWN' }; }
    if (!value || value.databaseId !== expectedId || !SHA.test(value.headSha) ||
        (this.expectedHeadSha && value.headSha.toLowerCase() !== this.expectedHeadSha.toLowerCase()) ||
        value.url !== 'https://github.com/' + this.repo + '/actions/runs/' + expectedId) {
      return { state: 'UNKNOWN' };
    }
    if (['queued', 'waiting', 'pending', 'in_progress', 'requested'].includes(value.status))
      return { state: 'PENDING' };
    if (value.status !== 'completed' || !value.conclusion ||
        !VALID_CONCLUSIONS.has(value.conclusion)) return { state: 'UNKNOWN' };
    return {
      state: 'COMPLETE',
      result: value.conclusion === 'success' ? 'SUCCESS' : 'FAILURE',
      externalRecord: {
        provider: 'GitHubActions',
        repository: this.repo,
        databaseId: value.databaseId,
        status: value.status,
        conclusion: value.conclusion,
        headSha: value.headSha.toLowerCase(),
        url: value.url
      }
    };
  };
}
