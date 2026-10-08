import { describe, expect, it } from 'vitest';
import { GitHubActionsCliProbe, type TrustedGitHubReader } from '../../src/main/next/wait/github-actions.js';

const SHA = 'a'.repeat(40);
const repo = 'MurphyHoops/CoS';
const id = 321;
const url = 'https://github.com/' + repo + '/actions/runs/' + id;
function payload(status: string, conclusion: string | null, overrides: Record<string, unknown> = {}) {
  return JSON.stringify({ databaseId: id, status, conclusion, headSha: SHA, url, ...overrides });
}
function fromResponse(response: string): { adapter: GitHubActionsCliProbe; captures: string[][] } {
  const captures: string[][] = [];
  const reader: TrustedGitHubReader = async (_program, args) => {
    captures.push([...args]);
    return response;
  };
  return { adapter: new GitHubActionsCliProbe('/usr/local/bin/gh', repo, SHA, 64_000, reader), captures };
}

describe('Trusted GitHub Actions Run external wait provider', () => {
  it('queries only the pinned repo + numeric run ID and verifies a successful concluded CI', async () => {
    const { adapter, captures } = fromResponse(payload('completed', 'success'));
    const proof = await adapter.probe('ci', 'ghrun:321', new AbortController().signal);
    expect(captures).toEqual([[
      'run', 'view', '321', '--repo', repo,
      '--json', 'databaseId,status,conclusion,headSha,url'
    ]]);
    expect(proof).toMatchObject({ state: 'COMPLETE', result: 'SUCCESS', externalRecord: {
      databaseId: 321, conclusion: 'success', headSha: SHA
    } });
  });
  it('does not treat failed, cancelled, timed-out or skipped runs as success', async () => {
    for (const reason of ['failure', 'cancelled', 'timed_out', 'skipped', 'startup_failure']) {
      const { adapter } = fromResponse(payload('completed', reason));
      expect(await adapter.probe('ci', 'ghrun:321', new AbortController().signal))
        .toMatchObject({ state: 'COMPLETE', result: 'FAILURE' });
    }
  });
  it('tracks queued and running CI without resolving an obligation early', async () => {
    for (const status of ['queued', 'waiting', 'in_progress']) {
      const { adapter } = fromResponse(payload(status, null));
      expect(await adapter.probe('ci', 'ghrun:321', new AbortController().signal))
        .toEqual({ state: 'PENDING' });
    }
  });
  it('rejects wrong run, wrong repo or unexpected action URL as untrusted evidence', async () => {
    for (const overrides of [
      { databaseId: 999 }, { url: 'https://evil.invalid/actions/runs/321' },
      { headSha: 'f'.repeat(40) }, { status: 'malformed' }, { conclusion: 'unknown' }
    ]) {
      const { adapter } = fromResponse(payload('completed', 'success', overrides));
      expect(await adapter.probe('ci', 'ghrun:321', new AbortController().signal))
        .toEqual({ state: 'UNKNOWN' });
    }
  });
  it('rejects malformed model input without executing the CLI at all', async () => {
    const { adapter, captures } = fromResponse(payload('completed', 'success'));
    for (const source of ['ghrun:0', 'ghrun:12;rm -rf', 'https://github.com/test',
      'ghrun:9999999999999999999999', 'ghrun:-3']) {
      expect(await adapter.probe('ci', source, new AbortController().signal))
        .toEqual({ state: 'UNKNOWN' });
    }
    expect(await adapter.probe('model', 'ghrun:321', new AbortController().signal))
      .toEqual({ state: 'UNKNOWN' });
    expect(captures).toHaveLength(0);
  });
  it('refuses unapproved directories and repository configurations', () => {
    expect(() => new GitHubActionsCliProbe('gh', repo)).toThrow('UNAPPROVED_GITHUB_CI_SOURCE');
    expect(() => new GitHubActionsCliProbe('/usr/local/bin/gh', '../secret')).toThrow('UNAPPROVED_GITHUB_CI_SOURCE');
  });
  it('does not convert GitHub CLI exceptions or malformed payloads into completion', async () => {
    const adapter = new GitHubActionsCliProbe('/usr/local/bin/gh', repo, SHA, 64_000,
      async () => { throw new Error('rate limited'); });
    expect(await adapter.probe('ci', 'ghrun:321', new AbortController().signal))
      .toEqual({ state: 'UNKNOWN' });
    expect(await fromResponse('not-json').adapter.probe('ci', 'ghrun:321', new AbortController().signal))
      .toEqual({ state: 'UNKNOWN' });
  });
});

// An opt-in *read-only* call to a previously completed GitHub Action; never
// launches a workflow or modifies user repositories.
it.runIf(process.env.COS_NEXT_GITHUB_LIVE === '1')('live GitHub CLI validates a completed existing run without triggering CI', async () => {
  const pinned = '51027562308af21db6835a008969f3f1e17591e0';
  const adapter = new GitHubActionsCliProbe('/opt/homebrew/bin/gh', repo, pinned);
  const result = await adapter.probe('ci', 'ghrun:37762591772', new AbortController().signal);
  expect(result).toMatchObject({ state: 'COMPLETE', result: 'SUCCESS', externalRecord: {
    databaseId: 37762591772, headSha: pinned, conclusion: 'success'
  } });
}, 25_000);
