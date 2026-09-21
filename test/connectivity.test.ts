import { beforeEach, expect, it, vi } from 'vitest';
import type { ConnectionStatus } from '../src/shared/types.js';
import {
  onProviderTransportChange,
  providerTransportDeadline,
  providerTransportSnapshot,
  publishProviderTransportStatus,
  resetProviderTransportForTests,
  waitForProviderTransport
} from '../src/main/session/connectivity.js';

function status(state: ConnectionStatus['state'], detail = ''): ConnectionStatus {
  return {
    state,
    detail,
    publicUrl: null,
    localUrl: null,
    handshakeAt: state === 'connected' ? Date.now() : null,
    lastRequestAt: null,
    lastToolCallAt: null,
    health: null,
    surfaces: []
  };
}

beforeEach(() => {
  resetProviderTransportForTests(status('connected'));
});

it('collapses transport substates into one suspended episode without moving its outage anchor', () => {
  const seen = vi.fn();
  const off = onProviderTransportChange(seen);
  try {
    const offlineAt = 10_000;
    const offline = publishProviderTransportStatus(status('offline', 'No internet'), offlineAt);
    expect(offline?.after).toMatchObject({
      phase: 'suspended',
      state: 'offline',
      suspendedAt: offlineAt
    });
    expect(seen).toHaveBeenCalledTimes(1);

    expect(publishProviderTransportStatus(
      status('connecting-tunnel', 'Retrying tunnel'),
      offlineAt + 30_000
    )).toBeNull();
    expect(providerTransportSnapshot()).toMatchObject({
      phase: 'suspended',
      state: 'connecting-tunnel',
      suspendedAt: offlineAt
    });
    expect(seen).toHaveBeenCalledTimes(1);

    const recoveredAt = offlineAt + 90_000;
    const recovered = publishProviderTransportStatus(status('connected'), recoveredAt);
    expect(recovered?.recoveredAfterMs).toBe(90_000);
    expect(recovered?.after).toMatchObject({ phase: 'ready', suspendedAt: null });
    expect(seen).toHaveBeenCalledTimes(2);
  } finally {
    off();
  }
});

it('does not emit a control-plane transition for detail-only changes in one phase', () => {
  const seen = vi.fn();
  const off = onProviderTransportChange(seen);
  try {
    expect(publishProviderTransportStatus(status('connected', 'healthy'), 20_000)).toBeNull();
    expect(providerTransportSnapshot()).toMatchObject({
      phase: 'ready',
      state: 'connected',
      detail: 'healthy'
    });
    expect(seen).not.toHaveBeenCalled();
  } finally {
    off();
  }
});

it('waits through transient suspension and resolves on the same connectivity episode', async () => {
  publishProviderTransportStatus(status('offline', 'No internet'), 30_000);
  let resolved = false;
  const waiting = waitForProviderTransport().then(() => { resolved = true; });

  await Promise.resolve();
  expect(resolved).toBe(false);

  publishProviderTransportStatus(status('connecting-tunnel', 'Retrying'), 40_000);
  await Promise.resolve();
  expect(resolved).toBe(false);

  publishProviderTransportStatus(status('connected'), 50_000);
  await waiting;
  expect(resolved).toBe(true);
});

it('fails immediately for terminal blocked transport instead of waiting forever', async () => {
  resetProviderTransportForTests(status('disconnected', 'Add a folder before connecting.'));
  await expect(waitForProviderTransport()).rejects.toThrow('Add a folder before connecting.');
});

it('waits for the first authoritative status instead of treating the module placeholder as a real disconnect', async () => {
  resetProviderTransportForTests();
  const waiting = waitForProviderTransport();
  await Promise.resolve();
  expect(providerTransportSnapshot()).toMatchObject({ generation: 0, changedAt: 0 });

  const first = publishProviderTransportStatus(status('disconnected', 'Project setup is required.'), 60_000);
  expect(first?.before).toMatchObject({ generation: 0, changedAt: 0 });
  expect(first?.after).toMatchObject({ phase: 'blocked', generation: 1 });
  await expect(waiting).rejects.toThrow('Project setup is required.');
});

it('consumes timeout budget only while provider transport is ready', () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(100_000);
    resetProviderTransportForTests(status('connected'));
    const deadline = providerTransportDeadline(1_000);
    try {
      vi.advanceTimersByTime(400);
      expect(deadline.signal.aborted).toBe(false);

      publishProviderTransportStatus(status('offline', 'No internet'), Date.now());
      vi.advanceTimersByTime(30_000);
      expect(deadline.signal.aborted).toBe(false);

      publishProviderTransportStatus(status('connected'), Date.now());
      vi.advanceTimersByTime(599);
      expect(deadline.signal.aborted).toBe(false);
      vi.advanceTimersByTime(1);
      expect(deadline.signal.aborted).toBe(true);
      expect((deadline.signal.reason as Error).message).toBe('provider_transport_timeout');
    } finally {
      deadline.dispose();
    }
  } finally {
    vi.useRealTimers();
  }
});
