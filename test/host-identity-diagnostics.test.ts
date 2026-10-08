import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { DEFAULT_CAPABILITIES } from '../src/shared/types.js';
import { buildServer, type ToolContext } from '../src/main/mcp/tools.js';
import { currentHostIdentityDiagnostics, deriveHostIdentityDiagnostics, withHostIdentityEvidence } from '../src/main/mcp/host-identity.js';

type Evidence = ReturnType<typeof currentHostIdentityDiagnostics>;
const context = (): ToolContext => ({
  roots: [],
  caps: { ...DEFAULT_CAPABILITIES, read: false, command: false },
  readOnly: true,
  sessionTools: false,
  agentTools: false,
  exposedFinishTool: false
});

function mockContext(meta: Record<string, unknown> | undefined, authenticated = false) {
  return {
    mcpReq: { _meta: meta },
    http: authenticated ? { authInfo: { token: 'opaque-test-token' } } : undefined
  } as Parameters<typeof deriveHostIdentityDiagnostics>[0];
}

function newCoreHandler() {
  return createMcpHandler(() => buildServer(context(), 'core'));
}

async function mcpRpc(
  endpoint: ReturnType<typeof createMcpHandler>,
  method: string, name?: string, metadata: Record<string, unknown> = {},
  args: Record<string, unknown> = {}
): Promise<{ result: { tools?: Array<{ name: string; annotations?: { readOnlyHint?: boolean } }>; structuredContent?: Evidence; isError?: boolean } }> {
  const response = await endpoint.fetch(new Request('http://localhost/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json', accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': method,
      ...(name ? { 'Mcp-Name': name } : {})
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method,
      params: {
        ...(name ? { name, arguments: args } : {}),
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientCapabilities': {},
          ...metadata
        }
      }
    })
  }));
  const raw = await response.text();
  const parsed = JSON.parse(raw.startsWith('{') ? raw : [...raw.matchAll(/^data: (.+)$/gm)].at(-1)?.[1] ?? '{}');
  expect(response.status).toBe(200);
  expect(parsed.error).toBeUndefined();
  return parsed;
}

describe('WP01 host identity source boundary', () => {
  it('does not invent identity when the SDK supplied no metadata', () => {
    expect(deriveHostIdentityDiagnostics(mockContext(undefined))).toMatchObject({
      session_present: false, subject_present: false, authority: 'missing',
      mission_authorized: false, mcp_auth_context_present: false
    });
    expect(currentHostIdentityDiagnostics().session_present).toBe(false);
  });

  it('reports correlation but never promotes metadata to a credential or a mission lease', () => {
    expect(deriveHostIdentityDiagnostics(mockContext({
      'openai/session': 'SESSION_A', 'openai/subject': 'SUBJECT_A'
    }, true))).toMatchObject({
      session_present: true, subject_present: true,
      mcp_auth_context_present: true, authority: 'correlation_only',
      mission_authorized: false, fingerprint_scope: 'current_process_only'
    });
  });

  it('forbids invalid or ambiguous types and control characters', () => {
    for (const value of [null, false, 12, [], ['A'], {}, '', 'x'.repeat(513), 'bad\u0000zero', 'bad\nnewline']) {
      expect(deriveHostIdentityDiagnostics(mockContext({ 'openai/session': value })).session_present).toBe(false);
    }
    expect(deriveHostIdentityDiagnostics(mockContext({ 'openai/session': 'x'.repeat(512) })).session_present).toBe(true);
  });

  it('separates subject and session domains even for the same opaque value', () => {
    const r = deriveHostIdentityDiagnostics(mockContext({
      'openai/session': 'SAME', 'openai/subject': 'SAME'
    }));
    expect(r.session_fingerprint).toMatch(/^[a-f0-9]{24}$/);
    expect(r.session_fingerprint).not.toEqual(r.subject_fingerprint);
    expect(JSON.stringify(r)).not.toContain('SAME');
  });

  it('keeps request-scoped values isolated across async concurrent turns', async () => {
    const seen = await Promise.all([
      withHostIdentityEvidence(mockContext({ 'openai/session': 'A' }), async () => {
        await new Promise(resolve => setTimeout(resolve, 8));
        return currentHostIdentityDiagnostics();
      }),
      withHostIdentityEvidence(mockContext({ 'openai/session': 'B' }), async () => {
        await Promise.resolve();
        return currentHostIdentityDiagnostics();
      })
    ]);
    expect(seen[0].session_fingerprint).not.toEqual(seen[1].session_fingerprint);
    expect(currentHostIdentityDiagnostics().session_present).toBe(false);
  });
});

describe('WP01 diagnostic is absent by default', () => {
  it('does not publish session fingerprint tools without local opt-in', async () => {
    const previous = process.env.COS_NEXT_IDENTITY_DIAGNOSTICS;
    delete process.env.COS_NEXT_IDENTITY_DIAGNOSTICS;
    const ep = newCoreHandler();
    try {
      const result = await mcpRpc(ep, 'tools/list');
      expect((result.result.tools ?? []).some(t => t.name === 'identity_diagnostics')).toBe(false);
    } finally {
      await ep.close();
      if (previous !== undefined) process.env.COS_NEXT_IDENTITY_DIAGNOSTICS = previous;
    }
  });
});

describe('WP01 actual Core MCP tool dispatch', () => {
  const priorFlag = process.env.COS_NEXT_IDENTITY_DIAGNOSTICS;
  beforeAll(() => { process.env.COS_NEXT_IDENTITY_DIAGNOSTICS = '1'; });
  afterAll(() => {
    if (priorFlag === undefined) delete process.env.COS_NEXT_IDENTITY_DIAGNOSTICS;
    else process.env.COS_NEXT_IDENTITY_DIAGNOSTICS = priorFlag;
  });

  it('advertises a single read-only Core diagnostic tool when explicitly enabled', async () => {
    const ep = newCoreHandler();
    try {
      const result = await mcpRpc(ep, 'tools/list');
      const tools = result.result.tools ?? [];
      expect(tools.filter(t => t.name === 'identity_diagnostics')).toHaveLength(1);
      expect(tools.find(t => t.name === 'identity_diagnostics')?.annotations?.readOnlyHint).toBe(true);
    } finally { await ep.close(); }
  });

  it('delivers session and subject through ServerContext without leaking raw values', async () => {
    const ep = newCoreHandler();
    try {
      const result = (await mcpRpc(ep, 'tools/call', 'identity_diagnostics', {
        'openai/session': 'SESSION_A',
        'openai/subject': 'SUBJECT_A'
      })).result.structuredContent!;
      expect(result).toMatchObject({
        session_present: true, subject_present: true, authority: 'correlation_only',
        mission_authorized: false, mcp_auth_context_present: false
      });
      expect(JSON.stringify(result)).not.toContain('SESSION_A');
      expect(JSON.stringify(result)).not.toContain('SUBJECT_A');
    } finally { await ep.close(); }
  });

  it('produces stable fingerprints for the same session and distinct fingerprints for different chats', async () => {
    const ep = newCoreHandler();
    try {
      const a = (await mcpRpc(ep, 'tools/call', 'identity_diagnostics',
        { 'openai/session': 'SESSION_A', 'openai/subject': 'SUBJECT_X' })).result.structuredContent!;
      const a2 = (await mcpRpc(ep, 'tools/call', 'identity_diagnostics',
        { 'openai/session': 'SESSION_A', 'openai/subject': 'SUBJECT_X' })).result.structuredContent!;
      const b = (await mcpRpc(ep, 'tools/call', 'identity_diagnostics',
        { 'openai/session': 'SESSION_B', 'openai/subject': 'SUBJECT_X' })).result.structuredContent!;
      expect(a.session_fingerprint).toEqual(a2.session_fingerprint);
      expect(a.session_fingerprint).not.toEqual(b.session_fingerprint);
      expect(a.subject_fingerprint).toEqual(b.subject_fingerprint);
    } finally { await ep.close(); }
  });

  it('does not infer a session from request IDs, transport or tool arguments', async () => {
    const ep = newCoreHandler();
    try {
      const r = (await mcpRpc(ep, 'tools/call', 'identity_diagnostics')).result.structuredContent!;
      expect(r.session_present).toBe(false);
      expect(r.authority).toBe('missing');
      const forged = await mcpRpc(ep, 'tools/call', 'identity_diagnostics', {}, { session: 'FORGED' });
      expect(forged.result.isError).toBe(true);
    } finally { await ep.close(); }
  });
});
