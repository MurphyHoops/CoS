import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { serveNextMcpLoopback } from '../../src/main/next/runtime/mcp-loopback.js';
import { NextMissionGateway } from '../../src/main/next/mission/gateway.js';

const health = {
  state: 'READY' as const, leases: 'ready', mission: 'READY',
  connector: 'NOT_STARTED' as const, model: 'NOT_STARTED' as const
};
const config = { runtime: { get health() { return health; } } };
let service: Awaited<ReturnType<typeof serveNextMcpLoopback>>;
const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {} };
const headers = {
  'content-type': 'application/json', accept: 'application/json, text/event-stream',
  'MCP-Protocol-Version': '2026-07-28'
};
async function call(name: string, args: Record<string, unknown> = {},
  sourceMeta: Record<string, unknown> = {}) {
  const result = await fetch(service.endpointUrl, {
    method: 'POST', headers: { ...headers, 'Mcp-Method': 'tools/call', 'Mcp-Name': name },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name, arguments: args, _meta: { ...meta, ...sourceMeta } } })
  });
  const raw = await result.text();
  return { status: result.status, raw,
    data: JSON.parse(raw.startsWith('{') ? raw : [...raw.matchAll(/^data: (.+)$/gm)].at(-1)?.[1] ?? '{}') };
}
async function listTools() {
  const r = await fetch(service.endpointUrl, {
    method: 'POST', headers: { ...headers, 'Mcp-Method': 'tools/list' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: { _meta: meta } })
  });
  const raw = await r.text();
  const parsed = JSON.parse(raw.startsWith('{') ? raw : [...raw.matchAll(/^data: (.+)$/gm)].at(-1)?.[1] ?? '{}');
  return parsed.result.tools;
}
beforeEach(async () => { service = await serveNextMcpLoopback(config); });
afterEach(async () => { await service.close(); });
describe('CoS Next real loopback MCP HTTP without browser companion', () => {
  it('binds only to loopback with an opaque random URL and default read-only tool surface', async () => {
    const url = new URL(service.endpointUrl);
    expect(url.hostname).toBe('127.0.0.1');
    expect(url.pathname).toMatch(/^\/next\/[a-zA-Z0-9_-]{24,96}\/mcp$/);
    const tools = await listTools();
    expect(tools.map((t: { name: string }) => t.name).sort())
      .toEqual(['identity_diagnostics', 'runtime_health']);
    expect(tools.every((t: { annotations: { readOnlyHint: boolean } }) => t.annotations.readOnlyHint)).toBe(true);
  });
  it('reports bounded runtime health and no unverified Mission authority', async () => {
    const result = await call('runtime_health');
    expect(result.status).toBe(200);
    expect(result.data.result.structuredContent).toMatchObject({
      state: 'READY', mission_authorized: false,
      connector: 'NOT_STARTED', model: 'NOT_STARTED'
    });
  });
  it('extracts synthetic host correlation fields but grants NO Mission capability', async () => {
    const result = await call('identity_diagnostics', {}, {
      'openai/session': 'SYNTHETIC_CHAT_A',
      'openai/subject': 'SYNTHETIC_USER'
    });
    expect(result.status).toBe(200);
    const data = result.data.result.structuredContent;
    expect(data).toMatchObject({ session_present: true,
      subject_present: true, mission_authorized: false, authority: 'correlation_only' });
    expect(JSON.stringify(data)).not.toContain('SYNTHETIC_CHAT_A');
  });
  it('does not publish Mission tools even when untrusted metadata claims an account', async () => {
    const available = await listTools();
    expect(available.some((x: { name: string }) => x.name === 'mission')).toBe(false);
    const fake = await call('mission', { action: 'stop', mission_id: 'mission-A',
      project_id: 'project-A', epoch: 1, expected_revision: 1 },
    { 'openai/session': 'forged', 'openai/subject': 'forged' });
    expect(fake.data.result?.structuredContent).toBeUndefined();
  });
  it('requires a server-verified gateway before allowing opt-in Mission registration', async () => {
    const gateway = new NextMissionGateway({} as never, async () => null);
    const connected = await serveNextMcpLoopback({ ...config, gateway, allowMissionTools: true });
    try {
      const result = await fetch(connected.endpointUrl, {
        method: 'POST', headers: { ...headers, 'Mcp-Method': 'tools/call', 'Mcp-Name': 'mission' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call',
          params: { name: 'mission', arguments: {
            action: 'stop', mission_id: 'mission-A', project_id: 'project-A',
            epoch: 1, expected_revision: 1,
            inbound: 'verified' // Model-supplied string is ignored.
          }, _meta: { ...meta, 'openai/session': 'forged' } } })
      });
      const raw = await result.text();
      expect(raw).toMatch(/UNTRUSTED_CALLER|MISSION_REQUEST_REJECTED|validation error/);
    } finally { await connected.close(); }
  });
  it('rejects wrong route, external Host and web Origin before MCP processing', async () => {
    const url = new URL(service.endpointUrl);
    const wrong = await fetch(url.origin + '/unapproved', { method: 'POST' });
    expect(wrong.status).toBe(404);
    // A real socket is required: Fetch may rewrite/normalize the Host header.
    const direct = async (custom: Record<string, string>) => await new Promise<number>((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: Number(url.port),
        path: url.pathname, method: 'POST', headers: { host: '127.0.0.1:' + url.port, ...custom } }, response => {
        response.resume();
        response.on('end', () => resolve(response.statusCode ?? 0));
      });
      req.on('error', reject); req.end();
    });
    expect(await direct({ host: 'evil.invalid' })).toBe(403);
    expect(await direct({ origin: 'https://evil.invalid' })).toBe(403);
  });
  it('blocks oversized bodies at the TCP handler rather than letting them reach the SDK', async () => {
    const large = await fetch(service.endpointUrl, {
      method: 'POST', headers,
      body: 'X'.repeat(128 * 1024 + 5)
    });
    expect(large.status).toBe(413);
  });
});
