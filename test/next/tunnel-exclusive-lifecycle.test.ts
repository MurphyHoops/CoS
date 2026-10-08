import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startNextTunnelExclusive } from '../../src/main/next/tunnel/exclusive-lifecycle.mjs';

const TID = 'tunnel_' + 'c'.repeat(32);
let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-next-lifecycle-')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe('WP08 Next-only lifecycle reservation barrier', () => {
  it('reserves before launcher execution and releases only after verified child stop', async () => {
    let launched = 0;
    let stopCalled = 0;
    let proof = false;
    const tunnel = await startNextTunnelExclusive(TID, {
      root,
      async start() {
        launched += 1;
        return { async stop() { stopCalled += 1; proof = true; } };
      },
      async verifyStopped() { return proof; }
    });
    expect(launched).toBe(1);
    await expect(startNextTunnelExclusive(TID, {
      root, start: async () => { launched++; return { async stop() {} }; },
      verifyStopped: async () => true
    })).rejects.toMatchObject({ code: 'TUNNEL_ALREADY_RESERVED' });
    expect(launched).toBe(1);
    await Promise.all([tunnel.stop(), tunnel.stop(), tunnel.stop()]);
    expect(stopCalled).toBe(1);
    const next = await startNextTunnelExclusive(TID, {
      root, start: async () => ({ async stop() {} }), verifyStopped: async () => true
    });
    await next.stop();
  });

  it('does not release lock when stop() resolves but termination is not proven', async () => {
    const tunnel = await startNextTunnelExclusive(TID, {
      root, start: async () => ({ async stop() {} }), verifyStopped: async () => false
    });
    await expect(tunnel.stop()).rejects.toMatchObject({ code: 'CHILD_TERMINATION_UNVERIFIED' });
    await expect(startNextTunnelExclusive(TID, {
      root, start: async () => ({ async stop() {} }), verifyStopped: async () => true
    })).rejects.toMatchObject({ code: 'TUNNEL_ALREADY_RESERVED' });
  });

  it('does not release lock after a failed or ambiguous client startup', async () => {
    await expect(startNextTunnelExclusive(TID, {
      root,
      async start(): Promise<{ stop(): Promise<void> }> { throw new Error('spawn failed after child fork'); },
      verifyStopped: async () => true
    })).rejects.toThrow('spawn failed');
    await expect(startNextTunnelExclusive(TID, {
      root, start: async () => ({ async stop() {} }), verifyStopped: async () => true
    })).rejects.toMatchObject({ code: 'TUNNEL_ALREADY_RESERVED' });
  });

  it('keeps the reservation after the actual client stop fails', async () => {
    const tunnel = await startNextTunnelExclusive(TID, {
      root,
      start: async () => ({ async stop() { throw new Error('cannot terminate'); } }),
      verifyStopped: async () => true
    });
    await expect(tunnel.stop()).rejects.toThrow('cannot terminate');
    await expect(startNextTunnelExclusive(TID, {
      root, start: async () => ({ async stop() {} }), verifyStopped: async () => true
    })).rejects.toMatchObject({ code: 'TUNNEL_ALREADY_RESERVED' });
  });

  it('fails before claiming ownership without both required lifecycle callbacks', async () => {
    await expect(startNextTunnelExclusive(TID, {
      root, start: async () => ({ async stop() {} }),
      verifyStopped: null as unknown as () => Promise<boolean>
    })).rejects.toMatchObject({ code: 'MISSING_LIFECYCLE_PROOF' });
    const valid = await startNextTunnelExclusive(TID, {
      root, start: async () => ({ async stop() {} }), verifyStopped: async () => true
    });
    await valid.stop();
  });
});
