import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tunnelOwnershipPath } from '../../src/main/next/tunnel/exclusive-owner.mjs';

const mocks = vi.hoisted(() => ({ startTunnel: vi.fn() }));
vi.mock('../../src/main/tunnel/index.js', () => ({
  startTunnel: mocks.startTunnel,
  TunnelError: class TunnelError extends Error {}
}));
import { startNextExistingOpenAiTunnel } from '../../src/main/next/tunnel/next-openai-transport.js';

let root: string;
const id = 'tunnel_' + 'd'.repeat(32);
const opts = {
  localUrl: 'http://127.0.0.1:9333/mcp/core/test',
  settings: { kind: 'openai' as const, tunnelId: id, desktopTunnelId: '', binaryPath: '' },
  apiKey: 'fixture-secret-only',
  label: 'core',
  report: () => undefined
};
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-next-real-transport-test-'));
  mocks.startTunnel.mockReset();
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe('WP08 executable Next OpenAI transport composition', () => {
  it('blocks a real transport launch until the legacy-state guard allows it', async () => {
    await expect(startNextExistingOpenAiTunnel(opts, {
      root, assertLegacyStopped: async () => false
    })).rejects.toThrow(/legacy cos/i);
    expect(mocks.startTunnel).not.toHaveBeenCalled();
    await expect(fs.stat(tunnelOwnershipPath(id, root))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('requires the guard again after acquiring ownership, before calling the legacy launcher', async () => {
    let checks = 0;
    await expect(startNextExistingOpenAiTunnel(opts, {
      root, assertLegacyStopped: async () => ++checks < 2
    })).rejects.toThrow(/appeared during/i);
    expect(checks).toBe(2);
    expect(mocks.startTunnel).not.toHaveBeenCalled();
    await expect(fs.stat(tunnelOwnershipPath(id, root))).resolves.toBeDefined();
  });

  it('calls the actual tunnel API only after taking a label-independent lock', async () => {
    let verified = false;
    let stops = 0;
    mocks.startTunnel.mockImplementation(async () => {
      await expect(fs.stat(tunnelOwnershipPath(id, root))).resolves.toBeDefined();
      return {
        stop: async () => { stops++; verified = true; },
        stopWithProof: async () => verified,
        healthBase: () => 'http://127.0.0.1:8800'
      };
    });
    const guards = { root, assertLegacyStopped: async () => true };
    const live = await startNextExistingOpenAiTunnel(opts, guards);
    expect(mocks.startTunnel).toHaveBeenCalledWith({ ...opts, nextRejectOrphans: true });
    expect(live.healthBase?.()).toBe('http://127.0.0.1:8800');
    await expect(startNextExistingOpenAiTunnel(
      { ...opts, label: 'desktop' }, guards
    )).rejects.toMatchObject({ code: 'TUNNEL_ALREADY_RESERVED' });
    expect(mocks.startTunnel).toHaveBeenCalledTimes(1);
    await live.stop();
    expect(stops).toBe(1);
    const second = await startNextExistingOpenAiTunnel(opts, guards);
    await second.stop();
  });

  it('cannot release ownership if the real launcher lacks stop proof capability', async () => {
    mocks.startTunnel.mockResolvedValue({ stop: async () => {} });
    await expect(startNextExistingOpenAiTunnel(opts, {
      root, assertLegacyStopped: async () => true
    })).rejects.toThrow(/no independently verified shutdown/i);
    await expect(startNextExistingOpenAiTunnel(opts, {
      root, assertLegacyStopped: async () => true
    })).rejects.toMatchObject({ code: 'TUNNEL_ALREADY_RESERVED' });
  });

  it('keeps ownership when actual stop() resolves but the OS exit proof is false', async () => {
    mocks.startTunnel.mockResolvedValue({
      stop: async () => {},
      stopWithProof: async () => false
    });
    const guards = { root, assertLegacyStopped: async () => true };
    const live = await startNextExistingOpenAiTunnel(opts, guards);
    await expect(live.stop()).rejects.toMatchObject({ code: 'CHILD_TERMINATION_UNVERIFIED' });
    await expect(startNextExistingOpenAiTunnel(opts, guards))
      .rejects.toMatchObject({ code: 'TUNNEL_ALREADY_RESERVED' });
  });

  it('rejects a caller-selected lock root outside test mode', async () => {
    const old = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await expect(startNextExistingOpenAiTunnel(opts, {
        root, assertLegacyStopped: async () => true
      })).rejects.toThrow(/custom tunnel lock roots are prohibited/i);
      expect(mocks.startTunnel).not.toHaveBeenCalled();
    } finally {
      if (old === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = old;
    }
  });

  it('rejects unsupported transport kinds without claiming the tunnel ID', async () => {
    const invalid = { ...opts, settings: { ...opts.settings, kind: 'manual' as 'openai' } };
    await expect(startNextExistingOpenAiTunnel(invalid, {
      root, assertLegacyStopped: async () => true
    })).rejects.toThrow(/only applies/i);
    expect(mocks.startTunnel).not.toHaveBeenCalled();
  });
});
