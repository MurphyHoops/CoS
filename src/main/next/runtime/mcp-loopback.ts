/**
 * Loopback-only transport for the Next safety-checked MCP surface.
 * Random per-instance path is routing defense, NOT a substitute for OAuth
 * or native MissionLease approval. No Tunnel is started by this module.
 */
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { Readable } from 'node:stream';
import type { NextMcpRegistration } from './mcp-core.js';
import { createNextMcpHandler } from './mcp-core.js';

const MAX_BODY = 128 * 1024;
function error(res: http.ServerResponse, status: number, code: string): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ error: code }));
}
export async function serveNextMcpLoopback(registration: NextMcpRegistration, port = 0) {
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('INVALID_MCP_PORT');
  const local = createNextMcpHandler(registration);
  const token = randomBytes(24).toString('base64url');
  const endpointPath = '/next/' + token + '/mcp';
  const server = http.createServer(async (req, res) => {
    const host = req.headers.host ?? '';
    if (!/^127\.0\.0\.1(?::\d{1,5})?$/.test(host)) { error(res, 403, 'invalid_host'); return; }
    const origin = req.headers.origin;
    if (origin && !/^http:\/\/127\.0\.0\.1(?::\d{1,5})?$/.test(origin)) {
      error(res, 403, 'invalid_origin'); return;
    }
    if (req.url?.split('?')[0] !== endpointPath) { error(res, 404, 'not_found'); return; }
    if (!['GET', 'POST', 'DELETE'].includes(req.method ?? '')) {
      error(res, 405, 'method_not_allowed'); return;
    }
    const announced = Number(req.headers['content-length'] ?? 0);
    if (!Number.isFinite(announced) || announced < 0 || announced > MAX_BODY) {
      error(res, 413, 'payload_too_large'); return;
    }
    try {
      const chunks: Buffer[] = [];
      let total = 0;
      if (req.method === 'POST') {
        for await (const raw of req) {
          const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
          total += chunk.length;
          if (total > MAX_BODY) {
            error(res, 413, 'payload_too_large');
            req.resume();
            return;
          }
          chunks.push(chunk);
        }
      }
      const headers = new Headers();
      for (const [name, v] of Object.entries(req.headers)) {
        if (!v || ['host', 'connection', 'content-length'].includes(name)) continue;
        headers.set(name, Array.isArray(v) ? v.join(',') : v);
      }
      const response = await local.handler.fetch(new Request('http://127.0.0.1' + endpointPath, {
        method: req.method,
        headers,
        ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {})
      }));
      res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      if (response.body) Readable.fromWeb(response.body as unknown as Parameters<typeof Readable.fromWeb>[0]).pipe(res);
      else res.end();
    } catch {
      if (!res.headersSent) error(res, 500, 'mcp_request_failed');
      else res.end();
    }
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
  } catch (e) {
    await local.close();
    throw e;
  }
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('MCP_LISTEN_INVALID');
  let closeFlight: Promise<void> | null = null;
  const close = (): Promise<void> => closeFlight ??= (async () => {
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    await local.close();
  })();
  return {
    endpointUrl: 'http://127.0.0.1:' + address.port + endpointPath,
    port: address.port,
    close
  };
}
