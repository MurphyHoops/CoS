/**
 * Stages the already-installed, working v3.1.16 Desktop native addon into
 * ignored local resources for a Next Classic macOS ARM development build.
 *
 * Source CoS install stays read-only. No secrets/config/userData are read.
 * Native files remain ignored and are not pushed to GitHub.
 */
import { copyFile, mkdir, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));
const source = '/Applications/Chat On Steroids.app/Contents/Resources/desktop';
const destination = join(repo, 'resources/packaging/desktop/darwin/arm64');
const names = ['macos-desktop-addon.node', 'libcos-desktop.dylib'];
if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error('Only macOS ARM64 development staging is supported');
}
await mkdir(destination, { recursive: true, mode: 0o700 });
for (const name of names) {
  const from = join(source, name);
  const to = join(destination, name);
  const srcStat = await stat(from);
  if (!srcStat.isFile() || srcStat.size < 1024 || srcStat.size > 20 * 1024 * 1024) {
    throw new Error('Invalid installed CoS desktop binary: ' + name);
  }
  const binaryType = execFileSync('/usr/bin/file', ['-b', from], { encoding: 'utf8' });
  if (!binaryType.includes('Mach-O') || !binaryType.includes('arm64'))
    throw new Error('Wrong desktop native architecture: ' + name);
  await copyFile(from, to);
  const staged = await stat(to);
  if (staged.size !== srcStat.size) throw new Error('Staging truncated: ' + name);
  console.log('NEXT_NATIVE_DESKTOP_STAGED=' + name);
}
