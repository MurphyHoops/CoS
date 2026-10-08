export declare function startNextTunnelExclusive<T extends { stop(): Promise<void> }>(
  tunnelId: string,
  options: {
    root?: string;
    label?: string;
    start(): Promise<T>;
    /** Independent, trusted OS/process evidence, never just a stop() receipt. */
    verifyStopped(): Promise<boolean>;
  }
): Promise<Readonly<{ client: T; stop(): Promise<void>; verifyOwnership(): Promise<void> }>>;
