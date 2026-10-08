/**
 * CoS Next optional plan-backed Worker bridge.
 *
 * Never assumes a webpage ChatGPT turn can be re-triggered via MCP. The only
 * automatic reasoning surface here is an explicitly opted-in authenticated
 * local Codex app-server provider, with its own *separate* thread IDs.
 * Uncertain model outcomes always become durable DELIVERY_UNKNOWN (HOLD).
 */
import { createHash } from 'node:crypto';
import type { MissionCaller, MissionKernel, LocalVerifier } from '../mission/kernel.js';
import type { TurnReceipt } from './codex-app-server.js';
import type { NativeWaitEvidence } from '../wait/external-wait.js';

type WorkerEvidence = Readonly<{ missionId: string; workerId: string; epoch: number; digest?: string }>;
export class NativeWorkerEvidence implements Pick<LocalVerifier,
  'verifyWorkerClaim' | 'verifyWorkerReport' | 'verifyWorkerReconciliation'> {
  private readonly claims = new WeakMap<object, WorkerEvidence>();
  private readonly reports = new WeakMap<object, WorkerEvidence>();
  private readonly reconciliations = new WeakMap<object, WorkerEvidence & { outcome: 'FINISHED' | 'CANCELLED' }>();
  mintClaim(missionId: string, workerId: string, epoch: number): object {
    const receipt = Object.freeze(Object.create(null)) as object;
    this.claims.set(receipt, { missionId, workerId, epoch });
    return receipt;
  }
  mintReport(missionId: string, workerId: string, epoch: number, digest: string): object {
    const receipt = Object.freeze(Object.create(null)) as object;
    this.reports.set(receipt, { missionId, workerId, epoch, digest });
    return receipt;
  }
  async verifyWorkerClaim(ticket: unknown, missionId: string, workerId: string, epoch: number): Promise<boolean> {
    if (!ticket || typeof ticket !== 'object') return false;
    const v = this.claims.get(ticket);
    return !!v && v.missionId === missionId && v.workerId === workerId && v.epoch === epoch;
  }
  async verifyWorkerReport(ticket: unknown, missionId: string, workerId: string, digest: string): Promise<boolean> {
    if (!ticket || typeof ticket !== 'object') return false;
    const v = this.reports.get(ticket);
    return !!v && v.missionId === missionId && v.workerId === workerId && v.digest === digest;
  }
  async verifyWorkerReconciliation(ticket: unknown, missionId: string, workerId: string,
    outcome: 'FINISHED' | 'CANCELLED', digest: string): Promise<boolean> {
    if (!ticket || typeof ticket !== 'object') return false;
    const v = this.reconciliations.get(ticket);
    return !!v && v.missionId === missionId && v.workerId === workerId &&
      v.outcome === outcome && v.digest === digest;
  }
}
/** The minimum independent provider capability; no browser/plugin assumed. */
export interface WorkerModel {
  runTurn(threadId: string, prompt: string): Promise<TurnReceipt>;
}
export interface WorkerRequest {
  agentId: string;
  threadId: string;
  prompt: string;
  /** Optional external wait already verified and owed to the local model. */
  continuationObligationId?: string;
}
export type WorkerRunResult = { status: 'FINISHED' | 'HOLD'; agentId: string; digest?: string };

export class NextWorkerBroker {
  private active = 0;
  constructor(
    private readonly mission: MissionKernel,
    private readonly receipts: NativeWorkerEvidence,
    private readonly model: WorkerModel,
    private readonly planInferenceApproved: () => boolean,
    private readonly maxConcurrent = 4,
    private readonly waitEvidence?: NativeWaitEvidence
  ) {
    if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 16)
      throw new Error('INVALID_WORKER_CONCURRENCY');
  }
  get running(): number { return this.active; }

  async run(ctx: MissionCaller, request: WorkerRequest): Promise<WorkerRunResult> {
    if (!this.planInferenceApproved()) throw new Error('PLAN_INFERENCE_NOT_APPROVED');
    if (this.active >= this.maxConcurrent) throw new Error('WORKER_POOL_FULL');
    if (!request.agentId || request.agentId.length > 128 || !request.threadId ||
        request.threadId.length > 128 || !request.prompt || request.prompt.length > 128 * 1024)
      throw new Error('WORKER_INPUT_INVALID');
    let continuationDigest: string | null = null;
    if (request.continuationObligationId) {
      if (!this.waitEvidence) throw new Error('CONTINUATION_VERIFIER_REQUIRED');
      const state = await this.mission.inspect(ctx);
      const obligation = state.obligations.find(x => x.obligationId === request.continuationObligationId);
      if (!obligation || obligation.state !== 'RESOLVED' || obligation.continuation !== 'OWED' ||
          obligation.epoch !== ctx.epoch || !obligation.evidenceDigest)
        throw new Error('CONTINUATION_NOT_OWED');
      continuationDigest = obligation.evidenceDigest;
    }
    this.active++;
    let claimed = false;
    try {
      const ticket = this.receipts.mintClaim(ctx.missionId, request.agentId, ctx.epoch);
      await this.mission.claimWorker(ctx, request.agentId, ticket);
      claimed = true;
      let result: TurnReceipt;
      try { result = await this.model.runTurn(request.threadId, request.prompt); }
      catch { return await this.unknown(ctx, request.agentId); }
      if (result.status !== 'completed' || result.threadId !== request.threadId ||
          !result.turnId || result.turnId.length > 128) {
        return await this.unknown(ctx, request.agentId);
      }
      const digest = createHash('sha256')
        .update(JSON.stringify([ctx.missionId, request.agentId, ctx.epoch,
          result.threadId, result.turnId, result.status])).digest('hex');
      const signed = this.receipts.mintReport(ctx.missionId, request.agentId, ctx.epoch, digest);
      try {
        await this.mission.finishWorker(ctx, request.agentId, digest, signed);
        if (request.continuationObligationId && continuationDigest && this.waitEvidence) {
          const verified = this.waitEvidence.mintContinuation(ctx.missionId,
            request.continuationObligationId, continuationDigest);
          await this.mission.ackContinuation(ctx, request.continuationObligationId, verified);
        }
        return { status: 'FINISHED', agentId: request.agentId, digest };
      } catch {
        return { status: 'HOLD', agentId: request.agentId };
      }
    } finally {
      // The slot is a local process resource, not a persisted grant.
      this.active--;
      void claimed;
    }
  }
  private async unknown(ctx: MissionCaller, agentId: string): Promise<WorkerRunResult> {
    try { await this.mission.markWorkerDeliveryUnknown(ctx, agentId); }
    catch { /* after Stop or failed persistence, restart remains fail-closed */ }
    return { status: 'HOLD', agentId };
  }
}
