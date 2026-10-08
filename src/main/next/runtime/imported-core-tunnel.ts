/**
 * CoS Next opt-in owner of the ALREADY REGISTERED legacy Core Tunnel.
 *
 * The OS Keychain migration is operator-initiated. This adapter reads only
 * Next's own encrypted secrets/config; original CoS is never modified.
 * The remote MCP surface remains read-only pending G1b/G2b.
 */
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { startTunnel, TUNNEL_ID_PATTERN, type TunnelHandle } from '../../tunnel/index.js';
import { getSecret } from '../../secrets.js';
import type { NextLocalRuntime } from './local-runtime.js';
import type { TunnelSettings } from '../../../shared/types.js';

async function legacyProcessPresent(): Promise<boolean> {
  const result = await new Promise<string>((resolve, reject) => execFile('/bin/ps',
    ['-axo', 'comm'], { timeout: 3_000, maxBuffer: 2_000_000 },
    (error, output) => error ? reject(error) : resolve(output)));
  // Before starting, both legacy main app and any orphan tunnel-client are
  // blockers. Never steal/reclaim another process's listener on import.
  return result.split('\n').some(x =>
    x.includes('/Applications/Chat On Steroids.app/Contents/MacOS/') ||
    x.includes('/Applications/Chat On Steroids.app/Contents/Resources/tunnel/tunnel-client'));
}

export type ImportedConnectionState = 'CONNECTING' | 'CONNECTED' | 'AUTH_REJECTED' | 'HOLD';
export interface ImportedCoreTunnel {
  readonly connected: Promise<boolean>;
  get state(): ImportedConnectionState;
  stopWithProof(): Promise<boolean>;
}

export async function connectImportedCoreTunnel(
  runtime: NextLocalRuntime, localUrl: string, configFile: string,
  onStatus: (state: ImportedConnectionState) => void = () => {}
): Promise<ImportedCoreTunnel> {
  if (runtime.health.state !== 'READY') throw new Error('NEXT_RUNTIME_NOT_READY');
  if (await legacyProcessPresent()) throw new Error('LEGACY_TUNNEL_OWNER_PRESENT');
  const configuration: unknown = JSON.parse(await fs.readFile(configFile, 'utf8'));
  if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration))
    throw new Error('IMPORTED_CONFIG_INVALID');
  const legacy = (configuration as { tunnel?: Partial<TunnelSettings> }).tunnel;
  if (!legacy || legacy.kind !== 'openai' || !legacy.tunnelId ||
      !TUNNEL_ID_PATTERN.test(legacy.tunnelId)) throw new Error('IMPORTED_TUNNEL_INVALID');
  const apiKey = await getSecret('openaiApiKey');
  if (!apiKey) throw new Error('IMPORTED_KEY_UNREADABLE');
  const binaryPath = '/Applications/Chat On Steroids.app/Contents/Resources/tunnel/tunnel-client';
  const settings: TunnelSettings = { ...legacy, kind: 'openai',
    tunnelId: legacy.tunnelId, binaryPath } as TunnelSettings;
  let state: ImportedConnectionState = 'CONNECTING';
  let closed = false;
  let resolveReady!: (ready: boolean) => void;
  const connected = new Promise<boolean>(resolve => { resolveReady = resolve; });
  const readyTimer = setTimeout(() => {
    if (state !== 'CONNECTING') return;
    state = 'HOLD';
    onStatus(state);
    resolveReady(false);
  }, 75_000);
  const report = (next: ImportedConnectionState): void => {
    if (closed || state === next) return;
    state = next;
    onStatus(next);
    if (next !== 'CONNECTING') {
      clearTimeout(readyTimer);
      resolveReady(next === 'CONNECTED');
    }
  };
  let handle: TunnelHandle;
  try {
    handle = await startTunnel({
      localUrl, settings, apiKey, label: 'core', nextRejectOrphans: true,
      report: event => {
        if (event.state === 'connected') report('CONNECTED');
        else if (event.state === 'auth-failed') report('AUTH_REJECTED');
        else if (event.state === 'offline') report('HOLD');
      }
    });
  } catch (error) {
    clearTimeout(readyTimer);
    throw error;
  }
  let stopFlight: Promise<boolean> | null = null;
  const stopWithProof = () => stopFlight ??= (async () => {
    closed = true;
    clearTimeout(readyTimer);
    resolveReady(false);
    // This is a Next-owned process; do not release Next writer ownership if
    // we cannot prove its entire detached process group terminated.
    const proof = await handle.stopWithProof?.();
    return proof === true;
  })();
  return { connected, get state() { return state; }, stopWithProof };
}
