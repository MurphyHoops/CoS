import type { ConnectionState, ConnectionStatus } from '../../shared/types.js';

export type ProviderTransportPhase = 'ready' | 'suspended' | 'blocked';

export interface ProviderTransportSnapshot {
  phase: ProviderTransportPhase;
  state: ConnectionState;
  detail: string;
  changedAt: number;
  suspendedAt: number | null;
  generation: number;
}

export interface ProviderTransportTransition {
  before: ProviderTransportSnapshot;
  after: ProviderTransportSnapshot;
  /** Present only when a non-ready interval just ended. */
  recoveredAfterMs: number | null;
}

const listeners = new Set<(transition: ProviderTransportTransition) => void>();
let generation = 0;

function classify(state: ConnectionState): ProviderTransportPhase {
  if (state === 'connected') return 'ready';
  if (state === 'offline' || state === 'starting-server' || state === 'connecting-tunnel') {
    return 'suspended';
  }
  return 'blocked';
}

function placeholder(): ProviderTransportSnapshot {
  return {
    phase: 'blocked',
    state: 'disconnected',
    detail: '',
    changedAt: 0,
    suspendedAt: null,
    generation: 0
  };
}

let current = placeholder();

function fromStatus(
  status: ConnectionStatus,
  now: number,
  phase = classify(status.state),
  suspendedAt: number | null = phase === 'ready' ? null : now
): ProviderTransportSnapshot {
  return {
    phase,
    state: status.state,
    detail: status.detail,
    changedAt: now,
    suspendedAt,
    generation
  };
}

/**
 * Projects the authoritative ConnectionStatus into the provider-transport control plane.
 *
 * connection.ts is the sole producer. Subsystems consume this module instead of importing the
 * connection/tunnel stack, which keeps recovery/long-run logic provider-independent and avoids a
 * reverse dependency through MCP/bridge.
 */
export function publishProviderTransportStatus(
  status: ConnectionStatus,
  now = Date.now()
): ProviderTransportTransition | null {
  const phase = classify(status.state);

  // Generation zero is only the module-load placeholder, not evidence that setup is actually
  // blocked. The first authoritative ConnectionStatus must publish even when it classifies to
  // the same phase (for example the app really is disconnected), otherwise startup waiters can
  // neither resolve nor reject. After that first observation, same-phase detail/substate churn
  // remains intentionally silent.
  const placeholderCurrent = current.generation === 0 && current.changedAt === 0;
  if (current.phase === phase && !placeholderCurrent) {
    current = {
      ...current,
      state: status.state,
      detail: status.detail
    };
    return null;
  }

  const before = { ...current };
  const priorSuspendedAt =
    before.phase === 'ready' || before.changedAt <= 0
      ? null
      : before.suspendedAt ?? before.changedAt;
  generation += 1;
  current = fromStatus(
    status,
    now,
    phase,
    phase === 'ready' ? null : (priorSuspendedAt ?? now)
  );
  current.generation = generation;

  const transition: ProviderTransportTransition = {
    before,
    after: { ...current },
    recoveredAfterMs:
      phase === 'ready' && priorSuspendedAt !== null
        ? Math.max(0, now - priorSuspendedAt)
        : null
  };
  for (const listener of listeners) listener(transition);
  return transition;
}

export function providerTransportSnapshot(): ProviderTransportSnapshot {
  return { ...current };
}

export function providerTransportReady(): boolean {
  return current.phase === 'ready';
}

/** Transient network/startup outage. Executor health is unknown while this is true. */
export function providerTransportSuspended(): boolean {
  return current.phase === 'suspended';
}

/** Any state in which provider/browser automation must not start new external work. */
export function providerTransportUnavailable(): boolean {
  return current.phase !== 'ready';
}

export function onProviderTransportChange(
  listener: (transition: ProviderTransportTransition) => void
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Waits without a timeout while the connection authority says startup/network is transient.
 * Terminal setup states reject immediately; cancellation remains owned by the caller.
 */
export function waitForProviderTransport(signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const initial = providerTransportSnapshot();
  if (initial.phase === 'ready') return Promise.resolve();
  const awaitingFirstStatus = initial.generation === 0 && initial.changedAt === 0;
  if (initial.phase === 'blocked' && !awaitingFirstStatus) {
    return Promise.reject(new Error(initial.detail || 'Provider transport is not connected.'));
  }
  return new Promise<void>((resolve, reject) => {
    let off = () => {};
    const abort = () => {
      off();
      reject(signal?.reason instanceof Error ? signal.reason : new Error('Provider transport wait cancelled'));
    };
    off = onProviderTransportChange(({ after }) => {
      if (after.phase === 'suspended') return;
      off();
      signal?.removeEventListener('abort', abort);
      if (after.phase === 'ready') resolve();
      else reject(new Error(after.detail || 'Provider transport is not connected.'));
    });
    signal?.addEventListener('abort', abort, { once: true });

    // Close the read→subscribe race.
    const latest = providerTransportSnapshot();
    const latestAwaitingFirstStatus = latest.generation === 0 && latest.changedAt === 0;
    if (latest.phase !== 'suspended' && !latestAwaitingFirstStatus) {
      off();
      signal?.removeEventListener('abort', abort);
      if (latest.phase === 'ready') resolve();
      else reject(new Error(latest.detail || 'Provider transport is not connected.'));
    }
  });
}

export interface ProviderTransportDeadline {
  signal: AbortSignal;
  dispose(): void;
}

/**
 * Abort deadline that consumes only provider-ready time.
 *
 * This is the shared clock for an already-admitted provider operation. Suspension pauses the
 * remaining budget; reconnect resumes the same budget. Admission itself still uses
 * waitForProviderTransport(), so a terminal blocked state is not turned into an infinite wait.
 */
export function providerTransportDeadline(timeoutMs: number, parent?: AbortSignal): ProviderTransportDeadline {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Provider transport timeout must be positive.');
  const controller = new AbortController();
  let remaining = timeoutMs;
  let activeSince: number | null = null;
  let timer: NodeJS.Timeout | null = null;

  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const pause = () => {
    if (activeSince !== null) remaining = Math.max(0, remaining - Math.max(0, Date.now() - activeSince));
    activeSince = null;
    clear();
  };
  const expire = () => {
    activeSince = null;
    timer = null;
    controller.abort(new Error('provider_transport_timeout'));
  };
  const arm = () => {
    if (controller.signal.aborted || !providerTransportReady() || activeSince !== null) return;
    if (remaining <= 0) return expire();
    activeSince = Date.now();
    timer = setTimeout(expire, remaining);
    timer.unref?.();
  };
  const off = onProviderTransportChange(({ after }) => {
    if (after.phase === 'ready') arm();
    else pause();
  });
  const parentAbort = () => controller.abort(parent?.reason);
  parent?.addEventListener('abort', parentAbort, { once: true });
  if (parent?.aborted) parentAbort();
  else arm();

  return {
    signal: controller.signal,
    dispose: () => {
      pause();
      off();
      parent?.removeEventListener('abort', parentAbort);
    }
  };
}

export function resetProviderTransportForTests(status?: ConnectionStatus): void {
  listeners.clear();
  generation = 0;
  current = status ? fromStatus(status, Date.now()) : placeholder();
}
