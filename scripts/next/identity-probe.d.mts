import type { Server as HttpServer } from 'node:http';

export type DiagnosticCounters = {
  calls: number;
  withSession: number;
  withSubject: number;
  withAuthInfo: number;
};

export interface IdentityProbe {
  handler: { fetch: (request: Request) => Promise<Response> };
  counters: DiagnosticCounters;
  close: () => Promise<void>;
}

export declare function createIdentityProbe(options?: {
  secret?: Buffer;
}): IdentityProbe;

export declare function serveIdentityProbe(options?: {
  port?: number;
  token?: string;
}): Promise<{
  probe: IdentityProbe;
  server: HttpServer;
  endpointUrl: string;
  close: () => Promise<void>;
}>;
