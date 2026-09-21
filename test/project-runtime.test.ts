import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import {
  evaluateProjectCompletion,
  evaluateSessionProjectCompletion,
  loadProjectRuntimeProfile,
  MAX_PROJECT_RUNTIME_PROFILE_BYTES,
  parseProjectRuntimeProfile
} from '../src/main/project-runtime.js';
import { addProject, assignSessionProject } from '../src/main/projects.js';
import {
  createSession,
  initSessionStore,
  resetSessionStoreForTests
} from '../src/main/session/store.js';
import { validateNewRoot } from '../src/main/sandbox.js';
import { projectRuntimeStatusProfileForTests } from '../src/main/mcp/project-runtime-tool.js';

let directory: string;
let approved: string;
let projectPath: string;

beforeEach(async () => {
  resetSessionStoreForTests();
  resetDurableForTests();
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-project-runtime-'));
  approved = path.join(directory, 'approved');
  projectPath = path.join(approved, 'project');
  await fs.mkdir(path.join(projectPath, '.cos'), { recursive: true });
  approved = await validateNewRoot(approved, []);
  initConfigPath(directory);
  initDurableStore(directory);
  initSessionStore(directory);
  await saveConfig({ ...defaultConfig(), roots: [{ name: 'work', path: approved }] });
});

afterEach(async () => {
  resetSessionStoreForTests();
  resetDurableForTests();
  await fs.rm(directory, { recursive: true, force: true });
});

async function writeProfile(value: unknown): Promise<void> {
  await fs.writeFile(
    path.join(projectPath, '.cos', 'project.json'),
    JSON.stringify(value, null, 2)
  );
}

describe('project runtime profile', () => {
  it('keeps old behavior when the optional profile is absent', async () => {
    await fs.rm(path.join(projectPath, '.cos', 'project.json'), { force: true });
    const project = await addProject(projectPath);
    const loaded = await loadProjectRuntimeProfile(project.id);
    expect(loaded.profile).toBeNull();
    expect(await evaluateProjectCompletion(project.id, { allowCommands: true })).toMatchObject({
      state: 'unconfigured',
      projectId: project.id,
      checks: []
    });
  });

  it('validates task references, portable relative paths and the auto-stop opt-in', () => {
    expect(parseProjectRuntimeProfile({
      version: 1,
      tasks: { verify: { argv: ['node', '--version'] } },
      completion: {
        checks: [
          { kind: 'task_success', task: 'verify' },
          { kind: 'path_exists', path: 'dist/app.js' }
        ]
      }
    })).toMatchObject({
      completion: { mode: 'all', autoStop: false }
    });

    expect(() => parseProjectRuntimeProfile({
      version: 1,
      completion: { checks: [{ kind: 'task_success', task: 'missing' }] }
    })).toThrow(/Unknown task/);

    for (const invalid of [
      '../outside',
      '/absolute',
      'a/../b',
      './file',
      'a\\..\\outside',
      'nested\\file',
      `a${String.fromCharCode(0)}b`
    ]) {
      expect(() => parseProjectRuntimeProfile({
        version: 1,
        completion: { checks: [{ kind: 'path_exists', path: invalid }] }
      })).toThrow();
    }
  });

  it('keeps executable argv private in project_runtime status output', () => {
    const profile = parseProjectRuntimeProfile({
      version: 1,
      tasks: {
        verify: {
          argv: ['secret-local-runner', '--token-shaped-argument'],
          timeout_ms: 5_000,
          description: 'Run the project verifier'
        }
      },
      completion: {
        auto_stop: true,
        checks: [{ kind: 'task_success', task: 'verify' }]
      }
    });
    const visible = projectRuntimeStatusProfileForTests(profile);
    expect(visible).toEqual({
      version: 1,
      tasks: [{ name: 'verify', description: 'Run the project verifier' }],
      completion: {
        mode: 'all',
        auto_stop: true,
        checks: [{ kind: 'task_success', task: 'verify' }]
      }
    });
    expect(JSON.stringify(visible)).not.toContain('secret-local-runner');
    expect(JSON.stringify(visible)).not.toContain('token-shaped-argument');
  });

  it('evaluates direct-exec tasks and project-relative path predicates', async () => {
    await fs.writeFile(path.join(projectPath, 'done.txt'), 'done');
    await writeProfile({
      version: 1,
      tasks: {
        verify: {
          argv: [process.execPath, '-e', 'process.exit(0)'],
          timeout_ms: 5_000
        }
      },
      completion: {
        mode: 'all',
        auto_stop: true,
        checks: [
          { kind: 'task_success', task: 'verify' },
          { kind: 'path_exists', path: 'done.txt' },
          { kind: 'path_absent', path: 'missing.txt' }
        ]
      }
    });
    const project = await addProject(projectPath);
    const result = await evaluateProjectCompletion(project.id, { allowCommands: true });
    expect(result.state).toBe('satisfied');
    expect(result.checks.map(check => check.state)).toEqual(['satisfied', 'satisfied', 'satisfied']);
    expect(result.checks[0]).toMatchObject({ exitCode: 0, timedOut: false });
  });

  it('never exposes verifier output or executable diagnostics in completion status', async () => {
    const secret = 'PROJECT_RUNTIME_SECRET_OUTPUT';
    await writeProfile({
      version: 1,
      tasks: {
        noisy: {
          argv: [process.execPath, '-e', `console.error('${secret}'); process.exit(7)`]
        }
      },
      completion: {
        checks: [{ kind: 'task_success', task: 'noisy' }]
      }
    });
    const project = await addProject(projectPath);
    const failed = await evaluateProjectCompletion(project.id, { allowCommands: true });
    expect(failed).toMatchObject({
      state: 'unsatisfied',
      checks: [{ state: 'unsatisfied', exitCode: 7, timedOut: false }]
    });
    expect(JSON.stringify(failed)).not.toContain(secret);

    const executableSecret = 'PROJECT_RUNTIME_SECRET_EXECUTABLE';
    await writeProfile({
      version: 1,
      tasks: { missing: { argv: [executableSecret] } },
      completion: { checks: [{ kind: 'task_success', task: 'missing' }] }
    });
    const missing = await evaluateProjectCompletion(project.id, { allowCommands: true });
    expect(missing).toMatchObject({ state: 'unsatisfied', checks: [{ state: 'unsatisfied' }] });
    expect(JSON.stringify(missing)).not.toContain(executableSecret);
  });

  it('stops before a later verifier command when durable executor authority is superseded', async () => {
    await writeProfile({
      version: 1,
      tasks: {
        first: { argv: [process.execPath, '-e', "require('fs').writeFileSync('first.marker','done')"] },
        second: { argv: [process.execPath, '-e', "require('fs').writeFileSync('second.marker','should-not-run')"] }
      },
      completion: {
        mode: 'all',
        checks: [
          { kind: 'task_success', task: 'first' },
          { kind: 'task_success', task: 'second' }
        ]
      }
    });
    const project = await addProject(projectPath);
    const firstMarker = path.join(projectPath, 'first.marker');
    const secondMarker = path.join(projectPath, 'second.marker');
    const authority = async () => {
      try {
        await fs.access(firstMarker);
        return false;
      } catch {
        return true;
      }
    };

    await expect(evaluateProjectCompletion(project.id, { allowCommands: true, authority }))
      .rejects.toThrow(/no longer owns/i);
    await expect(fs.readFile(firstMarker, 'utf8')).resolves.toBe('done');
    await expect(fs.stat(secondMarker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports task predicates blocked when command permission is unavailable', async () => {
    await writeProfile({
      version: 1,
      tasks: { verify: { argv: [process.execPath, '-e', 'process.exit(0)'] } },
      completion: {
        auto_stop: true,
        checks: [{ kind: 'task_success', task: 'verify' }]
      }
    });
    const project = await addProject(projectPath);
    expect(await evaluateProjectCompletion(project.id, { allowCommands: false })).toMatchObject({
      state: 'blocked',
      checks: [{ state: 'blocked' }]
    });
  });

  it('blocks path predicates when metadata permission is unavailable', async () => {
    await fs.writeFile(path.join(projectPath, 'ready'), 'yes');
    await writeProfile({
      version: 1,
      completion: {
        checks: [{ kind: 'path_exists', path: 'ready' }]
      }
    });
    const project = await addProject(projectPath);
    expect(await evaluateProjectCompletion(project.id, {
      allowCommands: true,
      allowMetadata: false
    })).toMatchObject({
      state: 'blocked',
      checks: [{ state: 'blocked' }]
    });
  });

  it('bounds the profile read on the opened file descriptor', async () => {
    const profilePath = path.join(projectPath, '.cos', 'project.json');
    const handle = await fs.open(profilePath, 'w');
    try {
      await handle.truncate(MAX_PROJECT_RUNTIME_PROFILE_BYTES + 1);
    } finally {
      await handle.close();
    }
    const project = await addProject(projectPath);
    await expect(loadProjectRuntimeProfile(project.id)).rejects.toThrow(/too large/i);
  });

  it('supports any-mode without requiring blocked alternatives to become true', async () => {
    await fs.writeFile(path.join(projectPath, 'ready'), 'yes');
    await writeProfile({
      version: 1,
      tasks: { unavailable: { argv: ['definitely-not-a-real-command'] } },
      completion: {
        mode: 'any',
        checks: [
          { kind: 'task_success', task: 'unavailable' },
          { kind: 'path_exists', path: 'ready' }
        ]
      }
    });
    const project = await addProject(projectPath);
    const result = await evaluateProjectCompletion(project.id, { allowCommands: false });
    expect(result.state).toBe('satisfied');
    expect(result.checks).toEqual([
      expect.objectContaining({ state: 'blocked' }),
      expect.objectContaining({ state: 'satisfied' })
    ]);
  });

  it('binds completion to the durable session project', async () => {
    await writeProfile({
      version: 1,
      completion: {
        checks: [{ kind: 'path_absent', path: 'unfinished.marker' }]
      }
    });
    const project = await addProject(projectPath);
    const session = await createSession({
      title: 'Generic project',
      conversationId: `conversation-${randomUUID()}`
    });
    await assignSessionProject(session.id, project.id);
    expect(await evaluateSessionProjectCompletion(session.id, { allowCommands: true })).toMatchObject({
      state: 'satisfied',
      projectId: project.id
    });
  });

  it.runIf(process.platform !== 'win32')('blocks a runtime profile symlink that escapes the bound project', async () => {
    const outside = path.join(directory, 'outside-profile.json');
    await fs.writeFile(outside, JSON.stringify({
      version: 1,
      tasks: { escaped: { argv: ['should-never-load'] } }
    }));
    const profilePath = path.join(projectPath, '.cos', 'project.json');
    await fs.rm(profilePath, { force: true });
    await fs.symlink(outside, profilePath);
    const project = await addProject(projectPath);
    await expect(loadProjectRuntimeProfile(project.id)).rejects.toThrow(/escapes/i);
  });

  it.runIf(process.platform !== 'win32')('blocks a path predicate that escapes through a symlink', async () => {
    const outside = path.join(directory, 'outside');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'secret'), 'x');
    await fs.symlink(outside, path.join(projectPath, 'escape'));
    await writeProfile({
      version: 1,
      completion: {
        checks: [{ kind: 'path_exists', path: 'escape/secret' }]
      }
    });
    const project = await addProject(projectPath);
    const result = await evaluateProjectCompletion(project.id, { allowCommands: true });
    expect(result.state).toBe('blocked');
    expect(result.checks[0]?.detail).toMatch(/escapes/i);
  });
});
