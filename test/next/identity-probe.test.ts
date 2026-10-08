import { describe, expect, it } from 'vitest';
import { createIdentityProbe, serveIdentityProbe } from '../../scripts/next/identity-probe.mjs';

const FIXED_SECRET = Buffer.alloc(32, 51);

async function call(handler: { fetch: (request: Request) => Promise<Response> },
  name: string, providedMeta: Record<string, unknown>, url = 'http://127.0.0.1/mcp') {
  const response = await handler.fetch(new Request(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2026-07-28',
      'Mcp-Method': 'tools/call',
      'Mcp-Name': name
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: {
        name,
        arguments: {},
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientCapabilities': {},
          ...providedMeta
        }
      }
    })
  }));
  const raw = await response.text();
  const payload = JSON.parse(raw.startsWith('{') ? raw : [...raw.matchAll(/^data: (.+)$/gm)].at(-1)?.[1] ?? '{}');
  if (response.status !== 200 || payload.result?.isError || !payload.result?.structuredContent) {
    throw new Error('Probe failed: status ' + response.status + ', content ' + raw.slice(0, 250));
  }
  return payload.result.structuredContent;
}

describe('CoS Next read-only identity diagnostic', () => {
  it('reads both official metadata keys through the installed MCP SDK', async () => {
    const probe = createIdentityProbe({ secret: FIXED_SECRET });
    try {
      const result = await call(probe.handler, 'probe_host_session', { 'openai/session': 'CHAT_A', 'openai/subject': 'ACCOUNT_A' });
      expect(result).toMatchObject({
        probe: 'cos-next-v1',
        session_present: true,
        subject_present: true,
        oauth_authorized: false,
        mission_authorized: false,
        request_sequence: 1
      });
      expect(result.session_fingerprint).toMatch(/^[0-9a-f]{24}$/);
      expect(result.subject_fingerprint).toMatch(/^[0-9a-f]{24}$/);
      expect(JSON.stringify(result)).not.toContain('CHAT_A');
      expect(JSON.stringify(result)).not.toContain('ACCOUNT_A');
    } finally { await probe.close(); }
  });

  it('maintains a stable fingerprint within one process for the same host session', async () => {
    const probe = createIdentityProbe({ secret: FIXED_SECRET });
    try {
      const a = await call(probe.handler, 'probe_host_session', { 'openai/session': 'CHAT_A' });
      const b = await call(probe.handler, 'probe_host_session', { 'openai/session': 'CHAT_A' });
      expect(a.session_fingerprint).toBe(b.session_fingerprint);
      expect(b.request_sequence).toBe(2);
    } finally { await probe.close(); }
  });

  it('distinguishes two conversations even with the same user', async () => {
    const probe = createIdentityProbe({ secret: FIXED_SECRET });
    try {
      const a = await call(probe.handler, 'probe_host_session', { 'openai/session': 'CHAT_A', 'openai/subject': 'SAME_ACCOUNT' });
      const b = await call(probe.handler, 'probe_host_session', { 'openai/session': 'CHAT_B', 'openai/subject': 'SAME_ACCOUNT' });
      expect(a.session_fingerprint).not.toBe(b.session_fingerprint);
      expect(a.subject_fingerprint).toBe(b.subject_fingerprint);
    } finally { await probe.close(); }
  });

  it('does not invent identity for an empty or absent field', async () => {
    const probe = createIdentityProbe({ secret: FIXED_SECRET });
    try {
      const a = await call(probe.handler, 'probe_host_session', {});
      const b = await call(probe.handler, 'probe_host_session', { 'openai/session': '', 'openai/subject': null });
      expect(a).toMatchObject({ session_present: false, session_fingerprint: null, subject_present: false, subject_fingerprint: null });
      expect(b).toMatchObject({ session_present: false, subject_present: false });
    } finally { await probe.close(); }
  });

  it('rejects arrays, objects and control characters as identity', async () => {
    const probe = createIdentityProbe({ secret: FIXED_SECRET });
    try {
      const values = [1234, { id: 'bad' }, ['A'], 'bad\nnewline', 'X'.repeat(257)];
      for (const value of values) {
        const r = await call(probe.handler, 'probe_host_session', { 'openai/session': value });
        expect(r.session_present).toBe(false);
      }
    } finally { await probe.close(); }
  });

  it('does not treat metadata as an authenticated user or mission lease', async () => {
    const probe = createIdentityProbe({ secret: FIXED_SECRET });
    try {
      const r = await call(probe.handler, 'probe_host_session', { 'openai/session': 'forged', 'openai/subject': 'forged' });
      expect(r.mission_authorized).toBe(false);
      expect(r.oauth_authorized).toBe(false);
      expect('mission_id' in r).toBe(false);
    } finally { await probe.close(); }
  });

  it('keeps counters without storing identifiers or chat content', async () => {
    const probe = createIdentityProbe({ secret: FIXED_SECRET });
    try {
      await call(probe.handler, 'probe_host_session', { 'openai/session': 'a' });
      await call(probe.handler, 'probe_host_session', { 'openai/subject': 'b' });
      const r = await call(probe.handler, 'probe_diagnostics', {});
      expect(r).toMatchObject({
        calls: 2, withSession: 1, withSubject: 1, withAuthInfo: 0,
        no_user_content_stored: true, mission_authorized: false
      });
      expect(JSON.stringify(probe.counters)).not.toMatch(/"a"|"b"/);
    } finally { await probe.close(); }
  });

  it('uses different HMAC fingerprints across process secrets', async () => {
    const p1 = createIdentityProbe({ secret: Buffer.alloc(32, 51) });
    const p2 = createIdentityProbe({ secret: Buffer.alloc(32, 52) });
    try {
      const a = await call(p1.handler, 'probe_host_session', { 'openai/session': 'SAME' });
      const b = await call(p2.handler, 'probe_host_session', { 'openai/session': 'SAME' });
      expect(a.session_fingerprint).not.toBe(b.session_fingerprint);
    } finally { await p1.close(); await p2.close(); }
  });

  it('rejects short fingerprint salts', () => {
    expect(() => createIdentityProbe({ secret: Buffer.alloc(3) })).toThrow();
  });
});

describe('CoS Next HTTP loopback probe isolation', () => {
  it('listens only on localhost with random token path, and rejects wrong path', async () => {
    const instance = await serveIdentityProbe({ port: 0 });
    try {
      const url = new URL(instance.endpointUrl);
      expect(url.hostname).toBe('127.0.0.1');
      expect(url.pathname).toMatch(/^\/probe\/[A-Za-z0-9_-]{24,96}\/mcp$/);
      const wrong = await fetch(url.origin + '/probe/wrong/mcp', { method: 'POST' });
      expect(wrong.status).toBe(404);
      const badMethod = await fetch(instance.endpointUrl, { method: 'PUT' });
      expect(badMethod.status).toBe(405);
      const address = instance.server.address();
      expect(address && typeof address === 'object' && address.address).toBe('127.0.0.1');
    } finally { await instance.close(); }
  });

  it('accepts a local MCP tool call through its HTTP adapter', async () => {
    const instance = await serveIdentityProbe({ port: 0 });
    try {
      const r = await call({ fetch: (request: Request) => fetch(request) }, 'probe_host_session', {
        'openai/session': 'SESSION_A', 'openai/subject': 'SUBJECT_A'
      }, instance.endpointUrl);
      expect(r).toMatchObject({ session_present: true, subject_present: true, mission_authorized: false });
    } finally { await instance.close(); }
  });

  it('advertises only the two read-only diagnostic tools on the actual HTTP endpoint', async () => {
    const instance = await serveIdentityProbe({ port: 0 });
    try {
      const response = await fetch(instance.endpointUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': '2026-07-28',
          'Mcp-Method': 'tools/list'
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {
          _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} }
        } })
      });
      const raw = await response.text();
      const payload = JSON.parse(raw.startsWith('{') ? raw : [...raw.matchAll(/^data: (.+)$/gm)].at(-1)?.[1] ?? '{}');
      expect(response.status).toBe(200);
      const tools = payload.result?.tools;
      expect(tools.map((t: { name: string }) => t.name).sort()).toEqual(['probe_diagnostics', 'probe_host_session']);
      for (const tool of tools) {
        expect(tool.annotations?.readOnlyHint).toBe(true);
        expect(tool.annotations?.openWorldHint).toBe(false);
      }
    } finally { await instance.close(); }
  });

  it('refuses bodies larger than the bounded ingress limit', async () => {
    const instance = await serveIdentityProbe({ port: 0 });
    try {
      const r = await fetch(instance.endpointUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'x'.repeat(128 * 1024 + 1)
      });
      expect(r.status).toBe(413);
    } finally { await instance.close(); }
  });
});
