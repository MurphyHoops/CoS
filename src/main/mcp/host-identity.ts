/**
 * WP01 — Host-side request correlation evidence (not permission).
 *
 * ChatGPT may supply openai/session and openai/subject in MCP request metadata.
 * A caller can forge MCP _meta when they control the transport: these fields
 * are useful ONLY for correlation and cannot authorize missions or filesystem
 * operations. Never log or persist the identifiers.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHmac, randomBytes } from 'node:crypto';
import type { ServerContext } from '@modelcontextprotocol/server';

export interface HostIdentityDiagnostics {
  readonly session_present: boolean;
  readonly session_fingerprint: string | null;
  readonly subject_present: boolean;
  readonly subject_fingerprint: string | null;
  readonly mcp_auth_context_present: boolean;
  readonly authority: 'correlation_only' | 'missing';
  readonly mission_authorized: false;
  readonly fingerprint_scope: 'current_process_only';
}

type HostSourceContext = Pick<ServerContext, 'mcpReq' | 'http'>;

/** One volatile key per process: fingerprints never survive an app restart. */
const diagnosticSecret = randomBytes(32);
const requestEvidence = new AsyncLocalStorage<HostIdentityDiagnostics>();

function opaqueHostValue(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) return null;
  if (/[\u0000-\u001f\u007f]/.test(value)) return null;
  return value;
}

function fingerprint(kind: 'session' | 'subject', value: string): string {
  return createHmac('sha256', diagnosticSecret)
    .update(kind).update('\0').update(value).digest('hex').slice(0, 24);
}

const MISSING: HostIdentityDiagnostics = Object.freeze({
  session_present: false,
  session_fingerprint: null,
  subject_present: false,
  subject_fingerprint: null,
  mcp_auth_context_present: false,
  authority: 'missing',
  mission_authorized: false,
  fingerprint_scope: 'current_process_only'
});

/** Return only ephemeral, non-authorizing diagnostics. */
export function deriveHostIdentityDiagnostics(context?: HostSourceContext): HostIdentityDiagnostics {
  const meta = context?.mcpReq?._meta;
  const session = opaqueHostValue(meta?.['openai/session']);
  const subject = opaqueHostValue(meta?.['openai/subject']);
  return {
    session_present: session !== null,
    session_fingerprint: session ? fingerprint('session', session) : null,
    subject_present: subject !== null,
    subject_fingerprint: subject ? fingerprint('subject', subject) : null,
    mcp_auth_context_present: Boolean(context?.http?.authInfo),
    authority: session ? 'correlation_only' : 'missing',
    mission_authorized: false,
    fingerprint_scope: 'current_process_only'
  };
}

/** Request-scoped; concurrent conversations cannot overwrite each other's data. */
export function withHostIdentityEvidence<T>(context: HostSourceContext | undefined, run: () => T): T {
  return requestEvidence.run(deriveHostIdentityDiagnostics(context), run);
}

export function currentHostIdentityDiagnostics(): HostIdentityDiagnostics {
  return requestEvidence.getStore() ?? MISSING;
}
