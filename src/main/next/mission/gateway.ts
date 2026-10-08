/**
 * CoS Next extensionless Mission gateway.
 *
 * A server/OS transport must construct the trusted host resolver. NEVER derive
 * a principal from the request's tool arguments, openai/session, subject, or
 * free-form MCP headers. This is not yet registered in tools/list until G2b.
 *
 * Gateway deliberately records Worker and Wait state but starts no Web model
 * turns: MCP servers cannot promise they can wake ChatGPT's next reasoning turn.
 */
import type { MissionCaller, MissionKernel } from './kernel.js';

type Action = 'inspect' | 'agent_delegate' | 'wait_arm' | 'pause' | 'stop' | 'rebind' | 'resume';
export interface NextMissionToolArgs {
  action: Action;
  mission_id: string;
  project_id: string;
  epoch: number;
  expected_revision?: number;
  agent_id?: string;
  task_digest?: string;
  obligation_id?: string;
  source_event_id?: string;
  wait_kind?: 'process' | 'ci' | 'model' | 'user';
}
export type VerifiedHostResolver = (hostTransportContext: unknown) => Promise<unknown | null>;
export type NativeApprovalResolver = (action: 'rebind' | 'resume', missionId: string) => Promise<unknown | null>;

function validName(x: unknown): x is string {
  return typeof x === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(x) &&
    !Object.prototype.hasOwnProperty.call(Object.prototype, x);
}
export class NextMissionGateway {
  constructor(
    private readonly kernel: MissionKernel,
    private readonly resolveVerifiedHost: VerifiedHostResolver,
    private readonly nativeApproval: NativeApprovalResolver = async () => null
  ) {}

  async run(args: NextMissionToolArgs, hostTransportContext: unknown): Promise<unknown> {
    if (!args || typeof args !== 'object' || !validName(args.mission_id) ||
        !validName(args.project_id) || !Number.isSafeInteger(args.epoch) || args.epoch < 1)
      throw new Error('INVALID_MISSION_REQUEST');
    if (typeof this.resolveVerifiedHost !== 'function') throw new Error('UNTRUSTED_CALLER');
    let inbound: unknown;
    try { inbound = await this.resolveVerifiedHost(hostTransportContext); } catch { inbound = null; }
    if (inbound == null) throw new Error('UNTRUSTED_CALLER');
    const ctx: MissionCaller = {
      missionId: args.mission_id, projectId: args.project_id, epoch: args.epoch, inbound
    };
    switch (args.action) {
      case 'inspect':
        return await this.kernel.inspect(ctx);
      case 'agent_delegate':
        if (!validName(args.agent_id) || typeof args.task_digest !== 'string') throw new Error('INVALID_AGENT_REQUEST');
        return {
          worker: await this.kernel.delegate(ctx, args.expected_revision ?? 0, args.agent_id, args.task_digest),
          delivery: 'QUEUED_NEEDS_VERIFIED_EXECUTOR' // No claim of a ChatGPT autonomous turn
        };
      case 'wait_arm':
        if (!validName(args.obligation_id) || !validName(args.source_event_id) ||
            !args.wait_kind) throw new Error('INVALID_WAIT_REQUEST');
        return {
          obligation: await this.kernel.armWait(ctx, args.expected_revision ?? 0,
            args.obligation_id, args.source_event_id, args.wait_kind),
          continuation: 'NEEDS_USER_OR_HOST' // No browser wake or synthetic model ACK
        };
      case 'pause':
        return await this.kernel.pause(ctx, args.expected_revision ?? 0);
      case 'stop':
        return await this.kernel.stop(ctx, args.expected_revision ?? 0);
      case 'rebind': {
        const ticket = await this.nativeApproval('rebind', ctx.missionId);
        if (ticket == null) throw new Error('NATIVE_APPROVAL_REQUIRED');
        return await this.kernel.rebindMission(ctx, args.expected_revision ?? 0, ticket);
      }
      case 'resume': {
        const ticket = await this.nativeApproval('resume', ctx.missionId);
        if (ticket == null) throw new Error('NATIVE_APPROVAL_REQUIRED');
        return await this.kernel.resume(ctx, args.expected_revision ?? 0, ticket);
      }
      default:
        throw new Error('UNSUPPORTED_MISSION_ACTION');
    }
  }
}
