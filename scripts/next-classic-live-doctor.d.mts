/** Public, read-only CLI inspection API for Next's exact local-test and real-profile gates. */
export interface LiveHandshakeEvidence {
  running: boolean;
  lastPollAgeSeconds: number | null;
  pollErrorCount: number | null;
  freshHandshake: boolean;
}
export function tunnelHandshakeHealth(
  config: { tunnel: { tunnelId?: string; pluginsTunnelId?: string; desktopTunnelId?: string } },
  livePids: Set<number>,
  nowMs: number,
  roots?: string[] | null
): Promise<Record<string, LiveHandshakeEvidence>>;
export function inspectLiveNext(): Promise<Record<string, unknown>>;
export function inspectLiveFixture(id: string): Promise<Record<string, unknown>>;
