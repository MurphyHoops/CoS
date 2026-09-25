import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { githubCliCandidates, locateGitHubCli } from '../src/main/github-cli.js';

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe('GitHub CLI discovery', () => {
  it('includes Homebrew locations even when a macOS GUI PATH omits them', () => {
    const candidates = githubCliCandidates(
      'darwin',
      { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: '/Users/test' },
      '/Users/test'
    );

    expect(candidates).toContain('/opt/homebrew/bin/gh');
    expect(candidates).toContain('/usr/local/bin/gh');
    expect(candidates.indexOf('/opt/homebrew/bin/gh')).toBeGreaterThan(candidates.indexOf('/usr/bin/gh'));
  });

  it('prefers an executable already present on PATH', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-gh-'));
    temporary.push(dir);
    const executable = path.join(dir, 'gh');
    await fs.writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    expect(locateGitHubCli('darwin', { PATH: dir, HOME: '/Users/test' }, '/Users/test')).toBe(executable);
  });
});
