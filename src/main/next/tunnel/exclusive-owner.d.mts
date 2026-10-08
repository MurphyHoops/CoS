export declare class TunnelOwnershipError extends Error {
  readonly code: string;
  constructor(code: string);
}
export declare function tunnelOwnershipPath(tunnelId: string, root?: string): string;
export declare function reserveTunnelOwnership(
  tunnelId: string,
  options?: { root?: string; label?: string; pid?: number }
): Promise<Readonly<{
  verify(): Promise<void>;
  release(): Promise<void>;
  ownerPid: number;
  label: string;
}>>;
