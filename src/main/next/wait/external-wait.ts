/**
 * CoS Next external wait supervisor. Actual external completion is locally
 * attested, then persisted exactly once before a continuation is OWED.
 * Web mode never claims an autonomously delivered ChatGPT model turn.
 */
import { createHash } from 'node:crypto';
import type { MissionCaller, MissionKernel, Obligation, LocalVerifier } from '../mission/kernel.js';

type WaitEvidence = Readonly<{ missionId: string; obligationId: string; digest: string }>;
export class NativeWaitEvidence implements Pick<LocalVerifier, 'verifyWait' | 'verifyContinuation'> {
  private readonly observed = new WeakMap<object, WaitEvidence>();
  private readonly resumed = new WeakMap<object, WaitEvidence>();
  mintWait(missionId: string, obligationId: string, digest: string): object {
    const receipt = Object.freeze(Object.create(null)) as object;
    this.observed.set(receipt, { missionId, obligationId, digest });
    return receipt;
  }
  mintContinuation(missionId: string, obligationId: string, digest: string): object {
    const receipt = Object.freeze(Object.create(null)) as object;
    this.resumed.set(receipt, { missionId, obligationId, digest });
    return receipt;
  }
  async verifyWait(ticket: unknown, missionId: string, obligationId: string, digest: string): Promise<boolean> {
    if (!ticket || typeof ticket !== 'object') return false;
    const r = this.observed.get(ticket);
    return !!r && r.missionId === missionId && r.obligationId === obligationId && r.digest === digest;
  }
  async verifyContinuation(ticket: unknown, missionId: string, obligationId: string, digest: string): Promise<boolean> {
    if (!ticket || typeof ticket !== 'object') return false;
    const r = this.resumed.get(ticket);
    return !!r && r.missionId === missionId && r.obligationId === obligationId && r.digest === digest;
  }
}

export type WaitProbeState =
  | { state: 'PENDING' | 'UNKNOWN' }
  | { state: 'COMPLETE'; result: 'SUCCESS' | 'FAILURE'; externalRecord: Readonly<Record<string, unknown>> };
export type ExternalWaitProbe =
  (kind: Obligation['kind'], sourceEventId: string, signal: AbortSignal) => Promise<WaitProbeState>;
type TickOutcome = 'PENDING' | 'RETRY_LATER' | 'HOLD' | 'CONTINUATION_OWED' | 'ALREADY_RESOLVED';
export class NextExternalWaitSupervisor {
  private readonly active = new Set<string>();
  constructor(
    private readonly mission: MissionKernel,
    private readonly localEvidence: NativeWaitEvidence,
    private readonly provider: ExternalWaitProbe
  ) {}

  /** One external probe; never repeats an already recorded event. */
  async tick(ctx: MissionCaller, obligationId: string, maxWaitMs = 10_000): Promise<TickOutcome> {
    if (!Number.isSafeInteger(maxWaitMs) || maxWaitMs < 100 || maxWaitMs > 60_000)
      throw new Error('INVALID_WAIT_TIMEOUT');
    const key = ctx.missionId + '\0' + obligationId;
    if (this.active.has(key)) return 'PENDING'; // no parallel external reads for one obligation
    this.active.add(key);
    try {
      const view = await this.mission.inspect(ctx);
      const obligation = view.obligations.find(x => x.obligationId === obligationId);
      if (!obligation) throw new Error('WAIT_NOT_FOUND');
      if (obligation.state === 'RESOLVED') return 'ALREADY_RESOLVED';
      if (obligation.state !== 'ARMED') return 'HOLD';
      const controller = new AbortController();
      let timedOut = false;
      let timer: NodeJS.Timeout | null = null;
      let probe: WaitProbeState;
      try {
        // Enforce our own deadline: a buggy provider may ignore AbortSignal
        // forever. Promise.race retains a rejection handler for late failure.
        const deadline = new Promise<WaitProbeState>(resolve => {
          timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
            resolve({ state: 'UNKNOWN' });
          }, maxWaitMs);
        });
        probe = await Promise.race([
          this.provider(obligation.kind, obligation.sourceEventId, controller.signal),
          deadline
        ]);
      } catch { return 'RETRY_LATER'; }
      finally { if (timer) clearTimeout(timer); }
      if (timedOut || controller.signal.aborted || probe.state === 'UNKNOWN') return 'RETRY_LATER';
      if (probe.state !== 'COMPLETE') return 'PENDING';
      if ((probe.result !== 'SUCCESS' && probe.result !== 'FAILURE') ||
          !probe.externalRecord || typeof probe.externalRecord !== 'object' ||
          Array.isArray(probe.externalRecord)) return 'HOLD';
      // Hash only independently fetched evidence; no arbitrary model-provided "done".
      const digest = createHash('sha256').update(JSON.stringify([
        ctx.missionId, obligationId, obligation.sourceEventId, probe.result,
        probe.externalRecord
      ])).digest('hex');
      const receipt = this.localEvidence.mintWait(ctx.missionId, obligationId, digest);
      try {
        const updated = await this.mission.resolveWait(ctx, obligationId, digest, receipt, probe.result);
        return updated.continuation === 'OWED' ? 'CONTINUATION_OWED' : 'HOLD';
      } catch {
        // A second event, Stop or revoked lease won the commit race.
        // Never claim success without a committed record.
        return 'HOLD';
      }
    } finally {
      this.active.delete(key);
    }
  }

  /** Schedule only trusted locally registered waits; no ChatGPT browser wake. */
  watch(ctx: MissionCaller, obligationId: string, periodMs = 30_000): { close(): Promise<void> } {
    if (!Number.isSafeInteger(periodMs) || periodMs < 1_000 || periodMs > 60 * 60 * 1000)
      throw new Error('INVALID_POLL_PERIOD');
    let closed = false;
    let transientFailures = 0;
    let handle: NodeJS.Timeout | null = null;
    let running: Promise<void> = Promise.resolve();
    const tick = async (): Promise<void> => {
      if (closed) return;
      try {
        const result = await this.tick(ctx, obligationId);
        if (result === 'CONTINUATION_OWED' || result === 'ALREADY_RESOLVED' || result === 'HOLD') {
          closed = true; return;
        }
        transientFailures = result === 'RETRY_LATER' ? transientFailures + 1 : 0;
        // Five failed observations require manual review; never busy-loop
        // indefinitely on an unavailable provider or rate-limited account.
        if (transientFailures >= 5) { closed = true; return; }
      } catch { closed = true; return; }
      if (!closed) {
        const delay = Math.min(periodMs * (2 ** transientFailures), 5 * 60_000);
        handle = setTimeout(() => { running = tick(); }, delay);
        handle.unref?.();
      }
    };
    running = tick();
    return {
      close: async () => {
        closed = true;
        if (handle) clearTimeout(handle);
        await running;
      }
    };
  }
}
