/**
 * Offline native packaging gate for the full classic CoS Next workflow.
 * Reads bundled metadata only. Does not launch a Tunnel or touch credentials.
 *
 * Usage: node scripts/verify-next-classic-package.mjs <absolute .app path>
 */
import { stat, readFile } from 'node:fs/promises';
import { resolve, join, isAbsolute } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const asar = require('@electron/asar');
const requested = process.argv[2];
if (!requested || !isAbsolute(requested) || !requested.endsWith('.app')) {
  throw new Error('EXPECTED_ABSOLUTE_NEXT_APP');
}
const app = resolve(requested);
const info = join(app, 'Contents', 'Info.plist');
const appId = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', info],
  { encoding: 'utf8' }).trim();
if (appId !== 'com.chatonsteroids.next') throw new Error('NOT_NEXT_BUNDLE_ID');
const resources = join(app, 'Contents', 'Resources');
const archive = join(resources, 'app.asar');
const entries = asar.listPackage(archive);
for (const entry of ['out-next/main/classic-main.js',
  'out-next/preload/index.js', 'out-next/renderer/index.html']) {
  if (!entries.includes('/' + entry)) throw new Error('MISSING_CLASSIC_RUNTIME_ASSET:' + entry);
}
const native = [
  'app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-arm64/pty.node',
  'app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper',
  'app.asar.unpacked/node_modules/tree-sitter/prebuilds/darwin-arm64/tree-sitter.node',
  'app.asar.unpacked/node_modules/tree-sitter-bash/prebuilds/darwin-arm64/tree-sitter-bash.node',
  'app.asar.unpacked/node_modules/@img/sharp-darwin-arm64/lib/sharp-darwin-arm64-0.35.4.node',
  'desktop/macos-desktop-addon.node', 'desktop/libcos-desktop.dylib',
  'tunnel/tunnel-client'
];
for (const item of native) {
  const filepath = join(resources, item);
  const metadata = await stat(filepath);
  if (!metadata.isFile() || metadata.size < 1024) throw new Error('MISSING_NATIVE_RESOURCE:' + item);
  const kind = execFileSync('/usr/bin/file', ['-b', filepath],
    { encoding: 'utf8' });
  if (!kind.includes('Mach-O') || !kind.includes('arm64')) {
    throw new Error('INVALID_NATIVE_ARCH:' + item);
  }
}
const metadata = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'));
if (metadata.main !== 'out-next/main/classic-main.js' || metadata.version !== '4.0.0-alpha.0') {
  throw new Error('NON_CLASSIC_PACKAGE_ENTRY');
}
const attrs = (await stat(archive)).size;
if (attrs < 1024 * 1024) throw new Error('EMPTY_ARCHIVE');
execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app],
  { encoding: 'utf8' });
const bundleIdentity = (await readFile(info)).length;
if (!bundleIdentity) throw new Error('INVALID_BUNDLE');
console.log('NEXT_CLASSIC_PACKAGE_GATE=PASS');
console.log('NEXT_CLASSIC_ASSETS_VERIFIED=' + 3);
console.log('NEXT_CLASSIC_NATIVE_RESOURCES_VERIFIED=' + native.length);
console.log('NEXT_CLASSIC_BUNDLE_ID=' + appId);
console.log('NEXT_CLASSIC_CODE_SIGNATURE=VERIFIED');
