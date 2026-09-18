/**
 * Process-local admission fence for a provider executor being replaced.
 *
 * Durable authority remains SessionSummary.recovery + SessionSummary.conversationId. This set is
 * only the zero-await fast path the MCP dispatcher needs between those durable writes: once hard
 * recovery starts, chat A may still exist server-side but cannot begin another local side effect.
 * Restart reconciliation rebuilds it from durable session metadata before bridge commands resume.
 */

const fenced = new Map<string, Set<string>>();

export function armRecoveryFence(conversationId: string, owner: string): void {
  if (!conversationId || !owner) return;
  const owners = fenced.get(conversationId) ?? new Set<string>();
  owners.add(owner);
  fenced.set(conversationId, owners);
}

export function disarmRecoveryFence(conversationId: string, owner: string): void {
  if (!conversationId || !owner) return;
  const owners = fenced.get(conversationId);
  if (!owners) return;
  owners.delete(owner);
  if (owners.size === 0) fenced.delete(conversationId);
}

export function recoveryFenceActive(conversationId: string | null | undefined): boolean {
  return Boolean(conversationId && fenced.get(conversationId)?.size);
}

/** Exact owner probe used by recovery reconciliation/tests; never grants authority by itself. */
export function recoveryFenceOwnerActive(conversationId: string, owner: string): boolean {
  return Boolean(conversationId && owner && fenced.get(conversationId)?.has(owner));
}

export function anyRecoveryFenceActive(): boolean {
  return fenced.size > 0;
}

/** Test/restart seam. */
export function resetRecoveryFences(): void {
  fenced.clear();
}
