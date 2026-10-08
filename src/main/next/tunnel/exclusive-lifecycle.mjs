/**
 * WP08 — conservative Next-only tunnel lifecycle admission.
 *
 * This adapter never starts an actual tunnel by itself. Its caller must provide
 * a verified tunnel launcher and independently prove that all spawned child
 * processes have terminated before the interprocess reservation can be released.
 * A failed/ambiguous startup deliberately retains its lock for manual review.
 */
import { reserveTunnelOwnership, TunnelOwnershipError } from './exclusive-owner.mjs';

export async function startNextTunnelExclusive(tunnelId, {
  root, label = 'core', start, verifyStopped
}) {
  if (typeof start !== 'function' || typeof verifyStopped !== 'function') {
    throw new TunnelOwnershipError('MISSING_LIFECYCLE_PROOF');
  }
  const ownership = await reserveTunnelOwnership(tunnelId, { root, label });
  await ownership.verify();
  // An exception here may follow a successful underlying OS spawn. Do NOT
  // relinquish exclusive ownership just because a JS promise rejected.
  const client = await start();
  if (!client || typeof client.stop !== 'function') {
    throw new TunnelOwnershipError('AMBIGUOUS_START');
  }
  await ownership.verify();

  let stopReceipt = null;
  async function stop() {
    if (stopReceipt) return stopReceipt;
    stopReceipt = (async () => {
      await client.stop();
      // A void/fulfilled stop() cannot prove child-tree termination. The
      // adapter may only release after independent verified evidence.
      if (await verifyStopped() !== true) {
        throw new TunnelOwnershipError('CHILD_TERMINATION_UNVERIFIED');
      }
      await ownership.release();
    })();
    return stopReceipt;
  }
  return Object.freeze({
    client,
    stop,
    verifyOwnership: () => ownership.verify()
  });
}
