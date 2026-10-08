/**
 * CoS Next WP08 — conservative per-Tunnel-ID cross-process reservation.
 *
 * Atomic mkdir is the sole admission point. A directory without a verified owner
 * is ambiguous and MUST stay blocked; do not self-heal by deleting/reaping.
 *
 * This is a Next-only primitive, NOT an interlock with already installed CoS
 * 3.1.x (which does not acquire it). Its future tunnel integration must also
 * prove the legacy app and tunnel client are stopped before claiming ownership.
 */
import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TUNNEL_PATTERN = /^tunnel_[0-9a-f]{32}$/;
const MAX_LABEL = 60;
export class TunnelOwnershipError extends Error {
  constructor(code) {
    super(code);
    this.name = 'TunnelOwnershipError';
    this.code = code;
  }
}

export function tunnelOwnershipPath(tunnelId, root = path.join(os.tmpdir(), 'chat-on-steroids-next-tunnel-ownership-v1')) {
  if (typeof tunnelId !== 'string' || !TUNNEL_PATTERN.test(tunnelId))
    throw new TunnelOwnershipError('INVALID_TUNNEL_ID');
  if (typeof root !== 'string' || !path.isAbsolute(root))
    throw new TunnelOwnershipError('INVALID_ROOT');
  const key = createHash('sha256').update('cos-next-tunnel-lock-v1\0').update(tunnelId).digest('hex');
  return path.join(root, key);
}

function isValidOwner(record) {
  return !!record && record.version === 1 && typeof record.nonce === 'string' &&
    /^[a-f0-9]{48}$/.test(record.nonce) &&
    Number.isSafeInteger(record.pid) && record.pid > 0 &&
    typeof record.label === 'string' && record.label.length <= MAX_LABEL &&
    Number.isSafeInteger(record.acquiredAt);
}

/**
 * Only a single client may claim a given Tunnel ID on one local filesystem.
 * Returns a release/verify handle on success. Never touches a tunnel-client.
 */
export async function reserveTunnelOwnership(tunnelId, {
  root, label = 'core', pid = process.pid
} = {}) {
  if (typeof label !== 'string' || label.length < 1 || label.length > MAX_LABEL ||
      !/^[a-zA-Z0-9_-]+$/.test(label)) throw new TunnelOwnershipError('INVALID_LABEL');
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new TunnelOwnershipError('INVALID_PID');
  const target = tunnelOwnershipPath(tunnelId, root);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  try {
    await fs.mkdir(target, { mode: 0o700 });
  } catch (err) {
    if (err?.code === 'EEXIST') throw new TunnelOwnershipError('TUNNEL_ALREADY_RESERVED');
    throw err;
  }
  const nonce = randomBytes(24).toString('hex');
  const owner = { version: 1, nonce, pid, label, acquiredAt: Date.now() };
  // If a process dies between mkdir and metadata publication, deliberately
  // leave an ambiguous directory that blocks future claims until reviewed.
  await fs.writeFile(path.join(target, 'owner.json'), JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
  const admittedStat = await fs.lstat(target);
  let released = false;
  let releasePromise = null;

  async function assertOwned() {
    if (released) throw new TunnelOwnershipError('RESERVATION_RELEASED');
    let current;
    let stat;
    try {
      stat = await fs.lstat(target);
      current = JSON.parse(await fs.readFile(path.join(target, 'owner.json'), 'utf8'));
    } catch {
      throw new TunnelOwnershipError('OWNERSHIP_AMBIGUOUS');
    }
    if (!stat.isDirectory() || stat.ino !== admittedStat.ino || stat.dev !== admittedStat.dev ||
        !isValidOwner(current) || current.nonce !== nonce || current.pid !== pid) {
      throw new TunnelOwnershipError('OWNERSHIP_AMBIGUOUS');
    }
  }

  async function releaseOne() {
    if (released) return;
    await assertOwned();
    // Move the exact acquired directory out of the admission name atomically:
    // another contender may mkdir(target) after rename; cleanup touches only
    // our uniquely named retired directory, never that new contender.
    const retired = target + '.released-' + nonce;
    await fs.rename(target, retired);
    released = true;
    // A different local writer may have replaced our directory between the
    // verify and rename. Never delete another owner's files in that case.
    // Retain the ambiguous retired path for explicit reconciliation.
    const retiredStat = await fs.lstat(retired);
    if (retiredStat.dev !== admittedStat.dev || retiredStat.ino !== admittedStat.ino) {
      throw new TunnelOwnershipError('OWNERSHIP_AMBIGUOUS');
    }
    const retiredOwner = JSON.parse(await fs.readFile(path.join(retired, 'owner.json'), 'utf8'));
    if (!isValidOwner(retiredOwner) || retiredOwner.nonce !== nonce || retiredOwner.pid !== pid) {
      throw new TunnelOwnershipError('OWNERSHIP_AMBIGUOUS');
    }
    await fs.rm(retired, { recursive: true, force: true });
  }

  function release() {
    if (!releasePromise) releasePromise = releaseOne();
    return releasePromise;
  }

  return Object.freeze({
    verify: assertOwned,
    release,
    /** No raw tunnel id or credential in the returned reservation. */
    ownerPid: pid,
    label
  });
}
