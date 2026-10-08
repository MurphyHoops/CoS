import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { deriveHostIdentityDiagnostics } from '../../mcp/host-identity.js';
import type { NextLocalRuntime } from './local-runtime.js';
import type { NextMissionGateway } from '../mission/gateway.js';
import type { ServerContext } from '@modelcontextprotocol/server';

/** No Mission tool is published until the verified principal G2b gate. */
export interface NextMcpRegistration {
  runtime: Pick<NextLocalRuntime, 'health'>;
  gateway?: NextMissionGateway;
  allowMissionTools?: boolean;
}
const missionSchema = {
  action: z.enum(['inspect', 'agent_delegate', 'wait_arm', 'pause', 'stop', 'rebind', 'resume']),
  mission_id: z.string(),
  project_id: z.string(),
  epoch: z.number().int().positive(),
  expected_revision: z.number().int().positive().optional(),
  agent_id: z.string().optional(),
  task_digest: z.string().optional(),
  obligation_id: z.string().optional(),
  source_event_id: z.string().optional(),
  wait_kind: z.enum(['process', 'ci', 'model', 'user']).optional()
};
export function createNextMcpHandler(registration: NextMcpRegistration) {
  if (registration.allowMissionTools && !registration.gateway) throw new Error('VERIFIED_GATEWAY_REQUIRED');
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'cos-next-local', version: '4.0.0-alpha.0' });
    server.registerTool('runtime_health', {
      title: 'CoS Next Runtime Health',
      description: 'Read isolated Next runtime readiness; no tokens, projects or user data exposed.',
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
    }, async () => {
      const result = { ...registration.runtime.health, mission_authorized: false };
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result };
    });
    server.registerTool('identity_diagnostics', {
      title: 'CoS Next Host Session Diagnostics',
      description: 'Read host session presence and ephemeral fingerprints. Not authentication.',
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
    }, async (_args, ctx) => {
      const result = deriveHostIdentityDiagnostics(ctx as Pick<ServerContext, 'mcpReq' | 'http'>);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result };
    });
    if (registration.allowMissionTools && registration.gateway) {
      server.registerTool('mission', {
        title: 'CoS Next Authorized Mission',
        description: 'Only a trusted transport may authorize Mission operations, not user-supplied MCP args.',
        inputSchema: missionSchema,
        annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false }
      }, async (args, ctx) => {
        try {
          const result = await registration.gateway!.run(args, ctx);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }],
            structuredContent: { result } };
        } catch (error) {
          const code = error instanceof Error ? error.message : 'UNTRUSTED_CALLER';
          return { isError: true, content: [{ type: 'text',
            text: /^[A-Z_]+$/.test(code) ? code : 'MISSION_REQUEST_REJECTED' }] };
        }
      });
    }
    return server;
  });
  return { handler, close: () => handler.close() };
}
