/**
 * CoS Next: isolation-only, read-only host identity diagnostic endpoint.
 *
 * SECURITY: this service never authorizes a mission, reads user files, sends
 * ChatGPT prompts, or treats the client-supplied MCP _meta as authentication.
 * It binds to 127.0.0.1 only; external exposure requires separate approved
 * transport and explicit user connection.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';

const MAX_BODY_BYTES = 128 * 1024;
const FINGERPRINT_CHARS = 24;

function suppliedIdentifier(value) {
  if (typeof value !== 'string') return null;
  if (!value || value.length > 256) return null;
  if (/[\u0000-\u001f\u007f]/.test(value)) return null;
  return value;
}

export function createIdentityProbe({ secret = randomBytes(32) } = {}) {
  if (!Buffer.isBuffer(secret) || secret.length < 16) throw new Error('An ephemeral secret of at least 16 bytes is required');

  const counters = { calls: 0, withSession: 0, withSubject: 0, withAuthInfo: 0 };
  const fingerprint = (type, value) =>
    createHmac('sha256', secret).update(type).update('\0').update(value).digest('hex').slice(0, FINGERPRINT_CHARS);

  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'cos-next-session-diagnostic', version: '0.1.0' });
    server.registerTool('probe_host_session', {
      title: 'Diagnose ChatGPT session metadata (read-only)',
      description:
        'Privacy-minimal test of official ChatGPT MCP host metadata. Returns only presence flags and short, ephemeral, salted fingerprints for comparing two calls. ' +
        'Does not touch CoS missions, files, browser, account tokens, or ChatGPT transcripts. These fields are NOT proof of authorization.',
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
    }, async (_args, ctx) => {
      const meta = ctx.mcpReq?._meta;
      const session = suppliedIdentifier(meta?.['openai/session']);
      const subject = suppliedIdentifier(meta?.['openai/subject']);
      counters.calls++;
      if (session) counters.withSession++;
      if (subject) counters.withSubject++;
      if (ctx.http?.authInfo) counters.withAuthInfo++;
      const result = {
        probe: 'cos-next-v1',
        session_present: session !== null,
        session_fingerprint: session ? fingerprint('session', session) : null,
        subject_present: subject !== null,
        subject_fingerprint: subject ? fingerprint('subject', subject) : null,
        oauth_authorized: !!ctx.http?.authInfo,
        // This probe is intentionally not a CoS mission-authorizing service.
        mission_authorized: false,
        request_sequence: counters.calls,
        fingerprint_scope: 'current_probe_process_only'
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result
      };
    });
    server.registerTool('probe_diagnostics', {
      title: 'Inspect diagnostic counts',
      description: 'Read aggregate call/metadata-presence counts for the current isolated diagnostic process only.',
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
    }, async () => {
      const result = { ...counters, no_user_content_stored: true, mission_authorized: false };
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    });
    return server;
  });
  return { handler, counters, close: () => handler.close() };
}

function errorJson(response, status, code) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify({ error: code }));
}

/**
 * Temporary loopback endpoint with a random path token. This restricts casual
 * local access but does NOT establish OAuth identity or authorize missions.
 */
export async function serveIdentityProbe({ port = 0, token = randomBytes(24).toString('base64url') } = {}) {
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port');
  if (!/^[A-Za-z0-9_-]{24,96}$/.test(token)) throw new Error('Invalid probe token');
  const probe = createIdentityProbe();
  const path = '/probe/' + token + '/mcp';
  const server = http.createServer(async (request, response) => {
    if (request.url?.split('?')[0] !== path) {
      errorJson(response, 404, 'not_found'); return;
    }
    if (!['POST', 'GET', 'DELETE'].includes(request.method ?? '')) {
      errorJson(response, 405, 'method_not_allowed'); return;
    }
    const declared = Number(request.headers['content-length'] ?? 0);
    if (!Number.isFinite(declared) || declared > MAX_BODY_BYTES) {
      errorJson(response, 413, 'payload_too_large'); return;
    }
    try {
      const bodyChunks = [];
      let size = 0;
      if (request.method === 'POST') {
        for await (const chunk of request) {
          size += chunk.length;
          if (size > MAX_BODY_BYTES) {
            errorJson(response, 413, 'payload_too_large'); return;
          }
          bodyChunks.push(chunk);
        }
      }
      const url = 'http://127.0.0.1' + path;
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (value === undefined || name === 'host' || name === 'content-length' || name === 'connection') continue;
        headers.set(name, Array.isArray(value) ? value.join(',') : value);
      }
      const upstream = await probe.handler.fetch(new Request(url, {
        method: request.method, headers,
        ...(request.method === 'POST' ? { body: Buffer.concat(bodyChunks) } : {})
      }));
      response.writeHead(upstream.status, Object.fromEntries(upstream.headers.entries()));
      if (upstream.body) Readable.fromWeb(upstream.body).pipe(response);
      else response.end();
    } catch {
      if (!response.headersSent) errorJson(response, 500, 'probe_error');
      else response.end();
    }
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
  } catch (error) {
    await probe.close(); throw error;
  }
  const address = server.address();
  const endpointUrl = 'http://127.0.0.1:' + address.port + path;
  const close = async () => {
    await new Promise(resolve => server.close(resolve));
    await probe.close();
  };
  return { probe, server, endpointUrl, close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = process.env.COS_NEXT_PROBE_PORT === undefined ? 0 : Number(process.env.COS_NEXT_PROBE_PORT);
  const token = process.env.COS_NEXT_PROBE_TOKEN;
  const { endpointUrl, close } = await serveIdentityProbe({ port, ...(token ? { token } : {}) });
  // Do not print the credential in normal logs. A separate user-approved
  // enrollment step is required before reaching this loopback service from ChatGPT.
  const address = new URL(endpointUrl);
  process.stderr.write('CoS Next diagnostic listening at ' + address.origin + ' (loopback only; not ChatGPT connected)\n');
  let closing = false;
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      if (closing) return;
      closing = true;
      void close().finally(() => process.exit(0));
    });
  }
}
