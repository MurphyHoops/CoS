/**
 * Where the Chrome extension lives on this machine.
 *
 * Chrome loads an unpacked extension from a real folder, so the extension cannot live
 * inside the asar — it ships as an extraResource and is copied out verbatim by the
 * package. Development can point Chrome at the repo's own `extension/`, but a packaged
 * build first mirrors `resources/extension` into the app's stable per-user data directory.
 * That extra hop matters on Linux AppImage: `process.resourcesPath` lives in a temporary
 * mount which disappears when the app exits, while Chrome remembers the exact folder used
 * for Load unpacked. The per-user copy keeps that path stable on every desktop OS and is
 * refreshed from the package on every launch/update.
 */

import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

const MATERIALIZED_FINGERPRINT = '.chat-on-steroids-source';
const MATERIALIZATION_IN_PROGRESS = '.chat-on-steroids-refreshing';
const MATERIALIZATION_NEXT_PREFIX = '.chat-on-steroids-next-';

function extensionFingerprint(root: string): string {
  const hash = createHash('sha256');
  const visit = (dir: string, relativeDir = ''): void => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const relative = relativeDir ? path.posix.join(relativeDir, entry.name) : entry.name;
      if (relative === MATERIALIZED_FINGERPRINT || relative === MATERIALIZATION_IN_PROGRESS) continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        hash.update(`d\0${relative}\0`);
        visit(absolute, relative);
      } else if (entry.isFile()) {
        hash.update(`f\0${relative}\0`);
        hash.update(readFileSync(absolute));
        hash.update('\0');
      } else {
        // The shipped extension is plain files/directories. Refuse an unexpected special entry
        // instead of materializing host-dependent links/devices into Chrome's trusted folder.
        throw new Error(`Unsupported extension entry: ${relative}`);
      }
    }
  };
  visit(root);
  return hash.digest('hex');
}

function directoryExists(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Synchronize one complete staged tree into the directory Chrome already loaded without ever
 * replacing that root directory itself.
 *
 * Replacing the loaded root with `rename(old, backup); rename(stage, old)` creates a real interval
 * in which Chrome's registered unpacked path does not exist, and it also changes the root's
 * filesystem identity. Chromium's explicit Reload re-opens the registered path, but avoiding the
 * disappearing/replaced root is the stronger invariant for browser and OS observers alike.
 *
 * The package is first staged and verified elsewhere. We then replace children only. Top-level
 * files are copied to temporary siblings before publication (an atomic rename on POSIX), while
 * directories are fully copied to a temporary sibling before the old child is retired. The
 * manifest and fingerprint publish last, and an already-running service worker keeps using its
 * loaded code until Chrome reloads the extension.
 */
function syncContentsKeepingRoot(source: string, destination: string): void {
  mkdirSync(destination, { recursive: true });
  const sourceEntries = readdirSync(source, { withFileTypes: true });
  const wanted = new Set(sourceEntries.map((entry) => entry.name));

  for (const entry of readdirSync(destination, { withFileTypes: true })) {
    if (entry.name === MATERIALIZATION_IN_PROGRESS) continue;
    if (entry.name.startsWith(MATERIALIZATION_NEXT_PREFIX)) {
      rmSync(path.join(destination, entry.name), { recursive: true, force: true });
      continue;
    }
    if (!wanted.has(entry.name)) rmSync(path.join(destination, entry.name), { recursive: true, force: true });
  }

  const ordered = sourceEntries.sort((a, b) => {
    const rank = (name: string): number =>
      name === MATERIALIZED_FINGERPRINT ? 2 : name === 'manifest.json' ? 1 : 0;
    return rank(a.name) - rank(b.name) || a.name.localeCompare(b.name);
  });

  for (const entry of ordered) {
    if (entry.name === MATERIALIZATION_IN_PROGRESS) continue;
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    const next = path.join(destination, `${MATERIALIZATION_NEXT_PREFIX}${entry.name}`);
    if (!entry.isDirectory() && !entry.isFile()) throw new Error(`Unsupported extension entry: ${entry.name}`);
    rmSync(next, { recursive: true, force: true });
    cpSync(from, next, { recursive: entry.isDirectory(), force: true });
    if (entry.isDirectory() || process.platform === 'win32' || directoryExists(to)) {
      // Node cannot portably replace a non-empty directory (and Windows cannot replace an open
      // file) with rename. The verified replacement already exists beside it, so the exposed
      // child-only gap is bounded to these two synchronous filesystem operations. The stable root
      // itself never disappears, and the refresh marker + backup make a crash here recoverable.
      rmSync(to, { recursive: true, force: true });
    }
    renameSync(next, to);
  }
}

function validExtension(dir: string): boolean {
  try {
    return statSync(path.join(dir, 'manifest.json')).isFile();
  } catch {
    return false;
  }
}

function materializedFingerprint(dir: string): string | null {
  try {
    return readFileSync(path.join(dir, MATERIALIZED_FINGERPRINT), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

function usableMaterializedExtension(dir: string): boolean {
  return validExtension(dir) && !existsSync(path.join(dir, MATERIALIZATION_IN_PROGRESS));
}

function recoverInterruptedMaterialization(stable: string, stage: string, backup: string): void {
  const refreshInterrupted = existsSync(path.join(stable, MATERIALIZATION_IN_PROGRESS));
  if (validExtension(stable) && !refreshInterrupted) {
    rmSync(stage, { recursive: true, force: true });
    rmSync(backup, { recursive: true, force: true });
    return;
  }

  // The backup is authoritative over staging: it was the previously published Chrome folder,
  // whereas `.new` may have been copied but not yet published when the process stopped. Preserve
  // the Chrome-visible root when it still exists; legacy builds may instead have crashed after
  // renaming the root away, in which case a one-time root restoration is unavoidable.
  if (validExtension(backup)) {
    if (directoryExists(stable)) {
      syncContentsKeepingRoot(backup, stable);
      rmSync(path.join(stable, MATERIALIZATION_IN_PROGRESS), { force: true });
      rmSync(backup, { recursive: true, force: true });
    } else {
      if (existsSync(stable)) rmSync(stable, { recursive: true, force: true });
      renameSync(backup, stable);
    }
    rmSync(stage, { recursive: true, force: true });
    return;
  }

  // First-install crashes have no old copy to restore. A staged tree is recoverable only after
  // our fingerprint marker was written, which happens after the recursive copy and manifest
  // validation complete. A partial `.new` without that marker is never promoted.
  if (validExtension(stage) && materializedFingerprint(stage) !== null) {
    if (directoryExists(stable)) {
      syncContentsKeepingRoot(stage, stable);
      rmSync(path.join(stable, MATERIALIZATION_IN_PROGRESS), { force: true });
      rmSync(stage, { recursive: true, force: true });
    } else {
      if (existsSync(stable)) rmSync(stable, { recursive: true, force: true });
      renameSync(stage, stable);
    }
  }
}

/**
 * Refreshes the Chrome-visible copy transactionally while keeping its directory identity stable.
 *
 * Copying package files directly into a folder Chrome already remembers makes an update
 * destructive before it is known-good: a stale destination shape, disk error, or interrupted
 * copy can leave a mixture of two extension versions. Stage and fingerprint the complete source
 * beside the live directory first. For an already-published copy, preserve the Chrome-loaded root
 * and synchronize only its children; a backup makes an interrupted child refresh recoverable. A
 * failed refresh keeps serving or restores the previous valid copy instead of disabling the
 * extension-folder UI.
 */
function materializePackagedExtension(bundled: string, stable: string): string | null {
  const stage = `${stable}.new`;
  const backup = `${stable}.old`;
  mkdirSync(path.dirname(stable), { recursive: true });
  recoverInterruptedMaterialization(stable, stage, backup);

  // The package is the update source, not the only usable copy. If an installed resource is
  // damaged after a successful earlier materialization, keep exposing the last-known-good stable
  // folder so Chrome and Finder do not lose a working extension merely because refresh is broken.
  if (!validExtension(bundled)) return usableMaterializedExtension(stable) ? stable : null;
  const fingerprint = extensionFingerprint(bundled);
  if (validExtension(stable) && materializedFingerprint(stable) === fingerprint) return stable;
  rmSync(stage, { recursive: true, force: true });

  try {
    cpSync(bundled, stage, { recursive: true, force: true });
    if (!validExtension(stage)) throw new Error('Staged extension is missing manifest.json');
    writeFileSync(path.join(stage, MATERIALIZED_FINGERPRINT), fingerprint, { encoding: 'utf8', mode: 0o600 });

    // First install: no browser can already be watching this root, so the staged tree may become
    // the stable root in one rename. Every later update deliberately keeps the existing root.
    if (!directoryExists(stable)) {
      if (existsSync(stable)) rmSync(stable, { recursive: true, force: true });
      renameSync(stage, stable);
      return stable;
    }

    // Only now do we have a complete new tree. Snapshot the last-known-good published copy before
    // mutating any child in the Chrome-visible directory, then mark the refresh so restart recovery
    // knows a valid-looking stable tree may still be mixed.
    rmSync(backup, { recursive: true, force: true });
    if (validExtension(stable)) cpSync(stable, backup, { recursive: true, force: true });
    writeFileSync(path.join(stable, MATERIALIZATION_IN_PROGRESS), fingerprint, { encoding: 'utf8', mode: 0o600 });
    try {
      syncContentsKeepingRoot(stage, stable);
      if (!validExtension(stable) || extensionFingerprint(stable) !== fingerprint) {
        throw new Error('Published extension did not match the staged package');
      }
      rmSync(path.join(stable, MATERIALIZATION_IN_PROGRESS), { force: true });
    } catch (error) {
      if (validExtension(backup)) {
        syncContentsKeepingRoot(backup, stable);
        rmSync(path.join(stable, MATERIALIZATION_IN_PROGRESS), { force: true });
      }
      throw error;
    }
    rmSync(stage, { recursive: true, force: true });
    rmSync(backup, { recursive: true, force: true });
    return stable;
  } catch {
    // If rollback succeeded, the stale/partial stage is disposable. If no published copy exists,
    // preserve a completed stage or backup for the next startup's recovery instead of deleting
    // the only remaining recoverable material.
    if (usableMaterializedExtension(stable)) {
      rmSync(stage, { recursive: true, force: true });
      rmSync(backup, { recursive: true, force: true });
    }
    // A marker-bearing tree may have a manifest but still contain a mixture of two builds. Do not
    // advertise it as healthy or delete its recovery authority. A later launch retries from .old
    // or the complete .new stage that remains beside it.
    return usableMaterializedExtension(stable) ? stable : null;
  }
}

/**
 * The folder to open for chrome://extensions → Load unpacked, or null if it is missing.
 *
 * Packaged first: in an installed build the source tree is not present at all, and in a
 * dev run process.resourcesPath points into Electron's own resources, where there is no
 * extension folder — so the checkout path is what answers there.
 */
export function extensionDir(): string | null {
  if (app.isPackaged) {
    const bundled = path.join(process.resourcesPath, 'extension');
    const stable = path.join(app.getPath('userData'), 'extension');
    try {
      return materializePackagedExtension(bundled, stable);
    } catch {
      // Fingerprinting itself can fail if the packaged resource is damaged. A previously
      // materialized extension remains useful and must not be hidden merely because the update
      // source is unreadable.
      return usableMaterializedExtension(stable) ? stable : null;
    }
  }

  const candidates = [
    path.join(app.getAppPath(), 'extension'),
    path.join(process.cwd(), 'extension'),
    path.join(process.resourcesPath, 'extension')
  ];
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, 'manifest.json'))) return candidate;
  }
  return null;
}
