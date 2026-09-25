import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { makeTempDir, removeTempDir } from './helpers.js';

let base: string | null = null;
const originalResourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;

afterEach(async () => {
  vi.resetModules();
  vi.doUnmock('electron');
  vi.doUnmock('node:fs');
  if (base) await removeTempDir(base);
  base = null;
  Object.defineProperty(process, 'resourcesPath', {
    configurable: true,
    writable: true,
    value: originalResourcesPath
  });
});

it('materializes a packaged extension into a stable per-user folder', async () => {
  base = await makeTempDir('clf-extension-path-');
  const resources = path.join(base, 'ephemeral-appimage-mount', 'resources');
  const bundled = path.join(resources, 'extension');
  const userData = path.join(base, 'user-data');
  await fs.mkdir(path.join(bundled, 'icons'), { recursive: true });
  await fs.writeFile(path.join(bundled, 'manifest.json'), JSON.stringify({ version: '9.9.9' }));
  await fs.writeFile(path.join(bundled, 'background.js'), 'current package');
  await fs.writeFile(path.join(bundled, 'icons', 'icon128.png'), 'icon');

  Object.defineProperty(process, 'resourcesPath', {
    configurable: true,
    writable: true,
    value: resources
  });
  vi.doMock('electron', () => ({
    app: {
      isPackaged: true,
      getPath: (name: string) => (name === 'userData' ? userData : ''),
      getAppPath: () => path.join(base!, 'not-used')
    }
  }));

  const { extensionDir } = await import('../src/main/extension-path.js');
  const first = extensionDir();
  expect(first).toBe(path.join(userData, 'extension'));
  expect(first).not.toContain('ephemeral-appimage-mount');
  expect(await fs.readFile(path.join(first!, 'background.js'), 'utf8')).toBe('current package');
  expect(await fs.readFile(path.join(first!, 'icons', 'icon128.png'), 'utf8')).toBe('icon');
  const firstStat = await fs.stat(first!);
  await fs.writeFile(path.join(first!, 'obsolete-from-old-build.js'), 'old only');

  // An app update refreshes files at the same Chrome-visible path rather than asking the user
  // to Load unpacked again from a new versioned directory.
  await fs.writeFile(path.join(bundled, 'background.js'), 'updated package');
  expect(extensionDir()).toBe(first);
  expect(await fs.readFile(path.join(first!, 'background.js'), 'utf8')).toBe('updated package');
  const updatedStat = await fs.stat(first!);
  // POSIX exposes the directory inode. Keeping it proves an update does not replace the root
  // Chrome registered as its unpacked-extension path. Windows may report zero here, so the
  // path/content assertions above remain the portable half of the contract.
  if (process.platform !== 'win32' && firstStat.ino !== 0) expect(updatedStat.ino).toBe(firstStat.ino);
  await expect(fs.access(path.join(first!, 'obsolete-from-old-build.js'))).rejects.toBeDefined();

  // Once a complete stable copy exists, later package damage must not make the Finder/Chrome
  // path disappear. The source is used to refresh; the stable copy is what the user loaded.
  await fs.rm(path.join(bundled, 'manifest.json'));
  expect(extensionDir()).toBe(first);
  expect(await fs.readFile(path.join(first!, 'background.js'), 'utf8')).toBe('updated package');
});

it('repairs a stale destination shape with a complete staged extension instead of failing mid-copy', async () => {
  base = await makeTempDir('clf-extension-repair-');
  const resources = path.join(base, 'resources');
  const bundled = path.join(resources, 'extension');
  const userData = path.join(base, 'user-data');
  const stable = path.join(userData, 'extension');
  await fs.mkdir(path.join(bundled, 'icons'), { recursive: true });
  await fs.writeFile(path.join(bundled, 'manifest.json'), JSON.stringify({ version: '2.0.2' }));
  await fs.writeFile(path.join(bundled, 'background.js'), 'new background');
  await fs.writeFile(path.join(bundled, 'icons', 'icon128.png'), 'new icon');
  await fs.writeFile(path.join(bundled, 'shape-change'), 'new file replacing old directory');

  // This is a deterministic failure for the previous direct `cpSync(bundled, stable)` design:
  // the destination has `icons` as a file while the package has it as a directory. A fresh staged
  // tree has no such type collision and replaces the old copy only after the whole copy succeeds.
  await fs.mkdir(stable, { recursive: true });
  await fs.writeFile(path.join(stable, 'manifest.json'), JSON.stringify({ version: '1.0.0' }));
  await fs.writeFile(path.join(stable, 'background.js'), 'old background');
  await fs.writeFile(path.join(stable, 'icons'), 'stale file where a directory belongs');
  await fs.mkdir(path.join(stable, 'shape-change'));
  await fs.writeFile(path.join(stable, 'shape-change', 'stale.txt'), 'stale directory where a file belongs');
  const stableBefore = await fs.stat(stable);

  Object.defineProperty(process, 'resourcesPath', {
    configurable: true,
    writable: true,
    value: resources
  });
  vi.doMock('electron', () => ({
    app: {
      isPackaged: true,
      getPath: (name: string) => (name === 'userData' ? userData : ''),
      getAppPath: () => path.join(base!, 'not-used')
    }
  }));

  const { extensionDir } = await import('../src/main/extension-path.js');
  expect(extensionDir()).toBe(stable);
  expect(await fs.readFile(path.join(stable, 'background.js'), 'utf8')).toBe('new background');
  expect(await fs.readFile(path.join(stable, 'icons', 'icon128.png'), 'utf8')).toBe('new icon');
  expect(await fs.readFile(path.join(stable, 'shape-change'), 'utf8')).toBe('new file replacing old directory');
  const stableAfter = await fs.stat(stable);
  if (process.platform !== 'win32' && stableBefore.ino !== 0) expect(stableAfter.ino).toBe(stableBefore.ino);
  await expect(fs.access(`${stable}.new`)).rejects.toBeDefined();
  await expect(fs.access(`${stable}.old`)).rejects.toBeDefined();
});

it('recovers an interrupted in-place refresh from the valid old copy before trusting stale new or package data', async () => {
  base = await makeTempDir('clf-extension-crash-recovery-');
  const resources = path.join(base, 'resources');
  const bundled = path.join(resources, 'extension');
  const userData = path.join(base, 'user-data');
  const stable = path.join(userData, 'extension');
  const backup = `${stable}.old`;
  const stage = `${stable}.new`;

  // Model a crash during child synchronization: the Chrome-visible root still exists, but the
  // refresh marker says its contents may be mixed. `.old` is the known-good snapshot and `.new`
  // is stale staging. Also damage the package source so recovery cannot rely on a recopy.
  await fs.mkdir(bundled, { recursive: true });
  await fs.writeFile(path.join(bundled, 'background.js'), 'package without manifest');
  await fs.mkdir(stable, { recursive: true });
  const rootBeforeRecovery = await fs.stat(stable);
  await fs.writeFile(path.join(stable, '.chat-on-steroids-refreshing'), 'interrupted');
  await fs.writeFile(path.join(stable, 'background.js'), 'corrupt stable');
  await fs.mkdir(backup, { recursive: true });
  await fs.writeFile(path.join(backup, 'manifest.json'), JSON.stringify({ version: '1.9.9' }));
  await fs.writeFile(path.join(backup, 'background.js'), 'last known good');
  await fs.mkdir(stage, { recursive: true });
  await fs.writeFile(path.join(stage, 'manifest.json'), JSON.stringify({ version: '2.0.2' }));
  await fs.writeFile(path.join(stage, 'background.js'), 'uncommitted staging');

  Object.defineProperty(process, 'resourcesPath', {
    configurable: true,
    writable: true,
    value: resources
  });
  vi.doMock('electron', () => ({
    app: {
      isPackaged: true,
      getPath: (name: string) => (name === 'userData' ? userData : ''),
      getAppPath: () => path.join(base!, 'not-used')
    }
  }));

  const { extensionDir } = await import('../src/main/extension-path.js');
  expect(extensionDir()).toBe(stable);
  expect(await fs.readFile(path.join(stable, 'background.js'), 'utf8')).toBe('last known good');
  expect(JSON.parse(await fs.readFile(path.join(stable, 'manifest.json'), 'utf8'))).toEqual({ version: '1.9.9' });
  const rootAfterRecovery = await fs.stat(stable);
  if (process.platform !== 'win32' && rootBeforeRecovery.ino !== 0) expect(rootAfterRecovery.ino).toBe(rootBeforeRecovery.ino);
  await expect(fs.access(path.join(stable, '.chat-on-steroids-refreshing'))).rejects.toBeDefined();
  await expect(fs.access(backup)).rejects.toBeDefined();
  await expect(fs.access(stage)).rejects.toBeDefined();
});

it('recovers a legacy update crash where 3.1.2 renamed the stable root away', async () => {
  base = await makeTempDir('clf-extension-legacy-recovery-');
  const resources = path.join(base, 'resources');
  const bundled = path.join(resources, 'extension');
  const userData = path.join(base, 'user-data');
  const stable = path.join(userData, 'extension');
  const backup = `${stable}.old`;
  const stage = `${stable}.new`;

  await fs.mkdir(bundled, { recursive: true });
  await fs.writeFile(path.join(bundled, 'background.js'), 'damaged package');
  await fs.mkdir(backup, { recursive: true });
  await fs.writeFile(path.join(backup, 'manifest.json'), JSON.stringify({ version: '3.1.2' }));
  await fs.writeFile(path.join(backup, 'background.js'), 'legacy last known good');
  await fs.mkdir(stage, { recursive: true });
  await fs.writeFile(path.join(stage, 'manifest.json'), JSON.stringify({ version: '3.1.3' }));
  await fs.writeFile(path.join(stage, 'background.js'), 'uncommitted legacy stage');

  Object.defineProperty(process, 'resourcesPath', { configurable: true, writable: true, value: resources });
  vi.doMock('electron', () => ({ app: {
    isPackaged: true,
    getPath: (name: string) => (name === 'userData' ? userData : ''),
    getAppPath: () => path.join(base!, 'not-used')
  } }));

  const { extensionDir } = await import('../src/main/extension-path.js');
  expect(extensionDir()).toBe(stable);
  expect(await fs.readFile(path.join(stable, 'background.js'), 'utf8')).toBe('legacy last known good');
  await expect(fs.access(backup)).rejects.toBeDefined();
  await expect(fs.access(stage)).rejects.toBeDefined();
});

it('preserves rollback authority when both publication and rollback fail, then recovers next launch', async () => {
  base = await makeTempDir('clf-extension-double-failure-');
  const resources = path.join(base, 'resources');
  const bundled = path.join(resources, 'extension');
  const userData = path.join(base, 'user-data');
  const stable = path.join(userData, 'extension');
  const backup = `${stable}.old`;
  const stage = `${stable}.new`;

  await fs.mkdir(bundled, { recursive: true });
  await fs.writeFile(path.join(bundled, 'manifest.json'), JSON.stringify({ version: '3.1.3' }));
  await fs.writeFile(path.join(bundled, 'background.js'), 'new package');
  await fs.mkdir(stable, { recursive: true });
  await fs.writeFile(path.join(stable, 'manifest.json'), JSON.stringify({ version: '3.1.2' }));
  await fs.writeFile(path.join(stable, 'background.js'), 'old package');

  const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
  vi.doMock('node:fs', () => ({
    ...actualFs,
    cpSync: (from: string, to: string, options?: Parameters<typeof actualFs.cpSync>[2]) => {
      if (from.startsWith(`${stage}${path.sep}`) || from.startsWith(`${backup}${path.sep}`)) {
        throw new Error('synthetic child publish failure');
      }
      return actualFs.cpSync(from, to, options);
    }
  }));
  Object.defineProperty(process, 'resourcesPath', { configurable: true, writable: true, value: resources });
  vi.doMock('electron', () => ({ app: {
    isPackaged: true,
    getPath: (name: string) => (name === 'userData' ? userData : ''),
    getAppPath: () => path.join(base!, 'not-used')
  } }));

  let module = await import('../src/main/extension-path.js');
  expect(module.extensionDir()).toBeNull();
  await expect(fs.access(path.join(stable, '.chat-on-steroids-refreshing'))).resolves.toBeUndefined();
  await expect(fs.access(backup)).resolves.toBeUndefined();
  await expect(fs.access(stage)).resolves.toBeUndefined();

  // A clean restart restores the backup first, then safely publishes the still-valid package.
  vi.resetModules();
  vi.doUnmock('node:fs');
  vi.doMock('electron', () => ({ app: {
    isPackaged: true,
    getPath: (name: string) => (name === 'userData' ? userData : ''),
    getAppPath: () => path.join(base!, 'not-used')
  } }));
  module = await import('../src/main/extension-path.js');
  expect(module.extensionDir()).toBe(stable);
  expect(await fs.readFile(path.join(stable, 'background.js'), 'utf8')).toBe('new package');
  await expect(fs.access(path.join(stable, '.chat-on-steroids-refreshing'))).rejects.toBeDefined();
  await expect(fs.access(backup)).rejects.toBeDefined();
  await expect(fs.access(stage)).rejects.toBeDefined();
});
