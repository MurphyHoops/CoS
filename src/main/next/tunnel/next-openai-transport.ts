/**
 * Next-only production transport composition. Unlike the mock lifecycle tests,
 * this calls the real OpenAI tunnel launcher, while the exclusive owner lock is
 * acquired first. This module is NOT wired into the installed legacy CoS app.
 */
import type { TunnelHandle, TunnelStartOptions } from '../../tunnel/index.js';
import { startTunnel, TunnelError } from '../../tunnel/index.js';
import { startNextTunnelExclusive } from './exclusive-lifecycle.mjs';

export interface NextTransportGuards {
  /** Only for isolated test fixtures. Production always uses the shared OS lock root. */
  root?: string;
  /** Operator-confirmed legacy process/Tunnel absence. Must be verified again under lock. */
  assertLegacyStopped: () => Promise<boolean>;
}

export async function startNextExistingOpenAiTunnel(
  opts: TunnelStartOptions,
  guards: NextTransportGuards
): Promise<TunnelHandle> {
  if (opts.settings.kind !== 'openai') {
    throw new TunnelError('Exclusive Next Tunnel ownership only applies to OpenAI transport');
  }
  if (!guards || typeof guards.assertLegacyStopped !== 'function') {
    throw new TunnelError('Next Tunnel requires a verified legacy process guard');
  }
  // A caller-selected lock directory would let two Next processes claim the
  // same Tunnel ID in different namespaces. Production must use the one shared
  // default OS directory; root overrides are only permitted by Vitest fixtures.
  if (guards.root !== undefined && process.env.NODE_ENV !== 'test') {
    throw new TunnelError('Custom tunnel lock roots are prohibited in production');
  }
  if (await guards.assertLegacyStopped() !== true) {
    throw new TunnelError('Legacy CoS/Tunnel is still present or its absence is not proven.');
  }
  let started: TunnelHandle | null = null;
  const wrapper = await startNextTunnelExclusive(opts.settings.tunnelId, {
    root: guards.root,
    label: opts.label ?? 'core',
    start: async () => {
      // Double check *after* claiming the per-ID lock. Legacy 3.1.x remains
      // uncooperative; the user-approved maintenance switch is still mandatory.
      if (await guards.assertLegacyStopped() !== true) {
        throw new TunnelError('Legacy CoS/Tunnel appeared during exclusive ownership switch.');
      }
      started = await startTunnel({ ...opts, nextRejectOrphans: true });
      if (typeof started.stopWithProof !== 'function') {
        // No proof capability => ambiguous startup. Retain reservation.
        throw new TunnelError('Tunnel has no independently verified shutdown receipt.');
      }
      return started;
    },
    verifyStopped: async () => (await started?.stopWithProof?.()) === true
  });
  return {
    stop: async () => { await wrapper.stop(); },
    stopWithProof: async () => { await wrapper.stop(); return true; },
    healthBase: () => wrapper.client.healthBase?.() ?? null
  };
}
