import { accessSync, constants, existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function isExecutableFile(candidate: string, platform: NodeJS.Platform): boolean {
  try {
    if (!existsSync(candidate) || !statSync(candidate).isFile()) return false;
    if (platform !== 'win32') accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function envValue(env: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform): string {
  if (platform !== 'win32') return env[name] ?? '';
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === wanted) return value ?? '';
  }
  return '';
}

export function githubCliCandidates(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory = envValue(env, platform === 'win32' ? 'USERPROFILE' : 'HOME', platform) || os.homedir()
): string[] {
  const platformPath = platform === 'win32' ? path.win32 : path.posix;
  const executable = platform === 'win32' ? 'gh.exe' : 'gh';
  const separator = platform === 'win32' ? ';' : ':';
  const fromPath = envValue(env, 'PATH', platform)
    .split(separator)
    .map(entry => entry.trim().replace(/^"|"$/g, ''))
    .filter(Boolean)
    .map(dir => platformPath.join(dir, executable));

  const common =
    platform === 'darwin'
      ? ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh']
      : platform === 'win32'
        ? [
            platformPath.join(envValue(env, 'LOCALAPPDATA', platform) || homeDirectory, 'Programs', 'GitHub CLI', executable),
            platformPath.join(envValue(env, 'ProgramFiles', platform) || 'C:\\Program Files', 'GitHub CLI', executable)
          ]
        : [
            platformPath.join(homeDirectory, '.local', 'bin', executable),
            '/home/linuxbrew/.linuxbrew/bin/gh',
            '/usr/local/bin/gh',
            '/usr/bin/gh',
            '/snap/bin/gh'
          ];

  return [...new Set([...fromPath, ...common])];
}

export function locateGitHubCli(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory?: string
): string | null {
  for (const candidate of githubCliCandidates(platform, env, homeDirectory)) {
    if (isExecutableFile(candidate, platform)) return candidate;
  }
  return null;
}
