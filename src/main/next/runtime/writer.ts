/**
 * CoS Next independent persistent root and single-writer boundary.
 * This does not install, read or migrate any legacy CoS data.
 */
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function defaultNextUserData(platform: NodeJS.Platform = process.platform, home = os.homedir()): string {
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'chat-on-steroids-next');
  if (platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'chat-on-steroids-next');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'chat-on-steroids-next');
}

export interface NextWriterOwner {
  dataDir: string;
  verify(): Promise<void>;
  release(): Promise<void>;
}
function boundary(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}
function isOldRoot(candidate: string, platform: NodeJS.Platform, home: string): boolean {
  const old = platform === 'darwin'
    ? path.join(home, 'Library', 'Application Support', 'chat-on-steroids')
    : platform === 'win32'
      ? path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'chat-on-steroids')
      : path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'chat-on-steroids');
  return boundary(old, candidate);
}
export async function acquireNextWriter(
  dataDir: string, { platform = process.platform, home = os.homedir() }: {
    platform?: NodeJS.Platform; home?: string
  } = {}
): Promise<NextWriterOwner> {
  if (!path.isAbsolute(dataDir) || !path.isAbsolute(home)) throw new Error('NEXT_DATA_PATH_INVALID');
  const canonicalHome = await fs.realpath(home);
  const canonicalParent = await fs.realpath(path.dirname(dataDir));
  const canonicalDir = path.join(canonicalParent, path.basename(dataDir));
  if (isOldRoot(canonicalDir, platform, canonicalHome) ||
      dataDir.toLowerCase().includes('chat-on-steroids.app')) throw new Error('LEGACY_DATA_ROOT_FORBIDDEN');
  if (!boundary(canonicalHome, canonicalDir) && canonicalDir !== defaultNextUserData(platform, canonicalHome)) {
    throw new Error('NEXT_DATA_OUTSIDE_USER_HOME');
  }
  try {
    const existing = await fs.lstat(canonicalDir);
    if (existing.isSymbolicLink() || !existing.isDirectory()) throw new Error('NEXT_DATA_NOT_OWNED_DIRECTORY');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    await fs.mkdir(canonicalDir, { recursive: false, mode: 0o700 });
  }
  const rootStat = await fs.stat(canonicalDir);
  if ((rootStat.mode & 0o022) !== 0) throw new Error('NEXT_DATA_WRITABLE_BY_OTHERS');
  const lock = path.join(canonicalDir, '.next-writer');
  try { await fs.mkdir(lock, { mode: 0o700 }); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('NEXT_WRITER_ALREADY_OWNED');
    throw err;
  }
  const nonce = randomBytes(24).toString('hex');
  const owner = { version: 1, nonce, pid: process.pid };
  // Conservative if interrupted between atomic mkdir and the owner receipt.
  await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
  const acquired = await fs.lstat(lock);
  let released = false;
  let pending: Promise<void> | null = null;
  const verify = async () => {
    if (released) throw new Error('NEXT_WRITER_RELEASED');
    const stat = await fs.lstat(lock).catch(() => { throw new Error('NEXT_WRITER_AMBIGUOUS'); });
    let recorded: typeof owner;
    try { recorded = JSON.parse(await fs.readFile(path.join(lock, 'owner.json'), 'utf8')) as typeof owner; }
    catch { throw new Error('NEXT_WRITER_AMBIGUOUS'); }
    if (!stat.isDirectory() || stat.ino !== acquired.ino || stat.dev !== acquired.dev ||
        recorded.nonce !== nonce || recorded.pid !== process.pid || recorded.version !== 1)
      throw new Error('NEXT_WRITER_AMBIGUOUS');
  };
  const release = () => {
    if (pending) return pending;
    pending = (async () => {
      await verify();
      const retired = lock + '.released-' + nonce;
      await fs.rename(lock, retired);
      released = true;
      const stat = await fs.lstat(retired);
      if (stat.ino !== acquired.ino || stat.dev !== acquired.dev) throw new Error('NEXT_WRITER_AMBIGUOUS');
      await fs.rm(retired, { recursive: true, force: true });
    })();
    return pending;
  };
  return Object.freeze({ dataDir: canonicalDir, verify, release });
}
