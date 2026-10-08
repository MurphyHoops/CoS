import { describe, expect, it } from 'vitest';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';

/**
 * Validation-only fixture for CoS Next. Does not modify CoS's runtime.
 * An MCP request's _meta is source-supplied input; it is not authenticated identity.
 */
type Probe = {
  session: string | null;
  subject: string | null;
  httpAuthenticated: boolean;
  envelopeMetadataPresent: boolean;
};
function cleanSession(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length < 257 ? value : null;
}
function mockServer() {
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'cos-next-validation-probe', version: '0.1.0' });
    server.registerTool('inspect_host_identity', { description: 'Probe only; no file or system access', inputSchema: {} }, async (_args, ctx) => {
      const meta = ctx.mcpReq?._meta as Record<string, unknown> | undefined;
      const result: Probe = {
        session: cleanSession(meta?.['openai/session']),
        subject: cleanSession(meta?.['openai/subject']),
        httpAuthenticated: !!ctx.http?.authInfo,
        envelopeMetadataPresent: !!ctx.mcpReq?.envelope
      };
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    });
    return server;
  });
  async function call(meta: Record<string, unknown>, arguments_?: Record<string, unknown>) {
    const response = await handler.fetch(new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': 'tools/call',
        'Mcp-Name': 'inspect_host_identity'
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
        name: 'inspect_host_identity',
        arguments: arguments_ ?? {},
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientCapabilities': {},
          ...meta
        }
      } })
    }));
    const text = await response.text();
    const rpc = JSON.parse(text.startsWith('{') ? text : [...text.matchAll(/^data: (.+)$/gm)].at(-1)![1]!);
    if (response.status !== 200 || !rpc.result || rpc.result.isError) throw new Error('RPC failed: ' + text.slice(0, 200));
    return rpc.result.structuredContent as Probe;
  }
  return { handler, call };
}

describe('CoS Next isolated official MCP identity metadata transport', () => {
  it('exposes official session and subject through ctx.mcpReq._meta', async () => {
    const t = mockServer();
    try {
      const r = await t.call({ 'openai/session': 'session-A', 'openai/subject': 'subject-A' });
      expect(r).toMatchObject({ session: 'session-A', subject: 'subject-A', httpAuthenticated: false });
    } finally { await t.handler.close(); }
  });
  it('is stable for repeated calls carrying the same test host session', async () => {
    const t = mockServer();
    try {
      const a = await t.call({ 'openai/session': 'session-A', 'openai/subject': 'subject-A' });
      const b = await t.call({ 'openai/session': 'session-A', 'openai/subject': 'subject-A' });
      expect(a.session).toBe(b.session);
    } finally { await t.handler.close(); }
  });
  it('distinguishes distinct caller-supplied host sessions', async () => {
    const t = mockServer();
    try {
      const a = await t.call({ 'openai/session': 'session-A' });
      const b = await t.call({ 'openai/session': 'session-B' });
      expect(a.session).not.toBe(b.session);
    } finally { await t.handler.close(); }
  });
  it('tolerates absent openai/session without inventing identity', async () => {
    const t = mockServer();
    try {
      expect(await t.call({})).toMatchObject({ session: null, subject: null, httpAuthenticated: false });
    } finally { await t.handler.close(); }
  });
  it('rejects malformed metadata types in validation helper', async () => {
    const t = mockServer();
    try {
      expect((await t.call({ 'openai/session': { dangerous: 'value' } })).session).toBeNull();
      expect((await t.call({ 'openai/session': 12345 })).session).toBeNull();
      expect((await t.call({ 'openai/session': '' })).session).toBeNull();
    } finally { await t.handler.close(); }
  });
  it('does not promote tool arguments into authoritative session data', async () => {
    const t = mockServer();
    try {
      const r = await t.call({}, { session: 'ATTACKER-SUPPLIED', mission_id: 'other-task' });
      expect(r.session).toBeNull();
    } finally { await t.handler.close(); }
  });
  it('shows metadata alone does not create validated HTTP authentication', async () => {
    const t = mockServer();
    try {
      const r = await t.call({ 'openai/session': 'session-A', 'openai/subject': 'subject-A' });
      expect(r.httpAuthenticated).toBe(false);
    } finally { await t.handler.close(); }
  });
});

/** Minimal illustrative lease policy to validate security invariants; not the production implementation. */
type Lease = { principal: string; namespace: string; hostSession: string; missionId: string; epoch: number; writable: boolean; revoked: boolean };
function policy() {
  const leases = new Map<string, Lease>();
  const key = (namespace: string, principal: string, session: string) => JSON.stringify([namespace, principal, session]);
  function bind(principal: string | null, namespace: string, session: string | null, missionId: string, writable = true) {
    if (!principal || !session) return false;
    const k = key(namespace, principal, session);
    if (leases.has(k)) return false;
    leases.set(k, { principal, namespace, hostSession: session, missionId, epoch: 1, writable, revoked: false });
    return true;
  }
  function authorize(principal: string | null, namespace: string, session: string | null, missionId: string, epoch: number, write = false) {
    if (!principal || !session) return false;
    const l = leases.get(key(namespace, principal, session));
    return !!l && !l.revoked && l.missionId === missionId && l.epoch === epoch && (!write || l.writable);
  }
  function invalidate(principal: string, namespace: string, session: string) {
    const l = leases.get(key(namespace, principal, session)); if (l) { l.epoch += 1; l.revoked = true; }
  }
  return { bind, authorize, invalidate };
}
describe('CoS Next proposed lease-policy negative controls (illustrative)', () => {
  it('refuses mutation on metadata alone with no verified authenticated principal', () => {
    const p = policy();
    expect(p.bind(null, 'chatgpt', 'session-A', 'mission-A')).toBe(false);
    expect(p.authorize(null, 'chatgpt', 'session-A', 'mission-A', 1, true)).toBe(false);
  });
  it('requires explicit session-to-mission binding before mutation', () => {
    const p = policy();
    expect(p.authorize('subject-A', 'chatgpt', 'session-A', 'mission-A', 1, true)).toBe(false);
    expect(p.bind('subject-A', 'chatgpt', 'session-A', 'mission-A')).toBe(true);
    expect(p.authorize('subject-A', 'chatgpt', 'session-A', 'mission-A', 1, true)).toBe(true);
  });
  it('prevents one chat from acting on another chat mission', () => {
    const p = policy();
    p.bind('subject-A', 'chatgpt', 'session-A', 'mission-A');
    p.bind('subject-A', 'chatgpt', 'session-B', 'mission-B');
    expect(p.authorize('subject-A', 'chatgpt', 'session-B', 'mission-A', 1, true)).toBe(false);
    expect(p.authorize('subject-A', 'chatgpt', 'session-A', 'mission-B', 1, true)).toBe(false);
  });
  it('does not share authorization across users or host namespaces', () => {
    const p = policy();
    p.bind('subject-A', 'chatgpt', 'session-A', 'mission-A');
    expect(p.authorize('subject-B', 'chatgpt', 'session-A', 'mission-A', 1, true)).toBe(false);
    expect(p.authorize('subject-A', 'other-client', 'session-A', 'mission-A', 1, true)).toBe(false);
  });
  it('stops stale agents when lease epoch changes', () => {
    const p = policy();
    p.bind('subject-A', 'chatgpt', 'session-A', 'mission-A');
    p.invalidate('subject-A', 'chatgpt', 'session-A');
    expect(p.authorize('subject-A', 'chatgpt', 'session-A', 'mission-A', 1, true)).toBe(false);
    expect(p.authorize('subject-A', 'chatgpt', 'session-A', 'mission-A', 2, true)).toBe(false);
  });
  it('requires read-only delegates to remain read-only', () => {
    const p = policy();
    p.bind('subject-A', 'chatgpt', 'session-A', 'mission-A', false);
    expect(p.authorize('subject-A', 'chatgpt', 'session-A', 'mission-A', 1, false)).toBe(true);
    expect(p.authorize('subject-A', 'chatgpt', 'session-A', 'mission-A', 1, true)).toBe(false);
  });
  it('does not allow an arbitrary task id to hijack an existing lease', () => {
    const p = policy();
    p.bind('subject-A', 'chatgpt', 'session-A', 'mission-A');
    expect(p.bind('subject-A', 'chatgpt', 'session-A', 'mission-B')).toBe(false);
    expect(p.authorize('subject-A', 'chatgpt', 'session-A', 'mission-B', 1, true)).toBe(false);
  });
});
