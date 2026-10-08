/**
 * CoS Next Classic — original end-to-end workflow with an independent app root.
 * This stage prioritizes preserving the actual CoS chat/settings/Goal/agent
 * behaviour over presenting partially implemented replacement controls.
 */
import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { app, dialog } from 'electron';
import { defaultNextUserData } from './writer.js';
import { originalCoSProcessActive } from './classic-boot-policy.js';

const ownRoot = defaultNextUserData();
mkdirSync(ownRoot, { recursive: true, mode: 0o700 });
app.setName('Chat On Steroids Next');
app.setPath('userData', ownRoot);
process.env.COS_NEXT_CLASSIC_WORKFLOW = '1';

async function incumbentOldCoS(): Promise<boolean> {
  if (process.platform !== 'darwin') return false;
  const output = await new Promise<string>((resolve, reject) => {
    execFile('/bin/ps', ['-axo', 'comm'], {
      timeout: 3_000, maxBuffer: 2_000_000
    }, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
  return originalCoSProcessActive(output);
}

async function launch(): Promise<void> {
  // Do not allow a second app with the same registered Tunnel IDs to run.
  // This check is conservative; the original connection also takes its own
  // exclusive tunnel lease when the user explicitly clicks Connect.
  let blocked = true;
  try { blocked = await incumbentOldCoS(); } catch { /* fail closed */ }
  if (blocked) {
    await app.whenReady();
    await dialog.showMessageBox({
      type: 'warning',
      title: 'CoS Next — Original CoS is already running',
      message: 'Close the original Chat On Steroids before starting Next.',
      detail: 'The two applications share registered Tunnel identifiers but never share a live owner. ' +
        'No original settings or credentials were modified.',
      buttons: ['Close']
    });
    app.exit(1);
    return;
  }
  process.stdout.write('NEXT_CLASSIC_LEGACY_IMPORT_START\n');
  // Dynamic import is mandatory: classic bootstrap's app single-instance
  // lock and data-store initialization must see Next's userData root.
  await import('../../index.js');
  process.stdout.write('NEXT_CLASSIC_LEGACY_IMPORT_OK\n');
}
void launch().catch(error => {
  const code = typeof error === 'object' && error !== null && 'code' in error &&
    typeof error.code === 'string' ? error.code : 'UNKNOWN';
  process.stderr.write('NEXT_CLASSIC_STARTUP_FAILED=' + code + '\n');
  // An imported native binding may fail before the legacy logger initializes.
  // Show the operator a clear local error instead of a silent Dock-only app.
  void app.whenReady().then(() => dialog.showMessageBox({
    type: 'error', title: 'CoS Next — startup blocked',
    message: 'The classic CoS workflow could not be initialized.',
    detail: 'A native dependency or local component failed to load. ' +
      'Check the preview installation before retrying. Original CoS is unchanged.',
    buttons: ['Close']
  })).finally(() => app.exit(1));
});
