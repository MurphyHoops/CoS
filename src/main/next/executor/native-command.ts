/**
 * CoS Next native bounded command executor.
 *
 * A model cannot invoke this class directly: the caller must already hold an
 * authorized MissionLease, an ADMITTED intent, and a locally approved executable
 * catalog. Stop and admission serialize inside MissionKernel.dispatchWithStarter.
 * Process exit evidence, not ChatGPT text, authorizes the result.
 */
import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { terminateProcessTree } from '../../exec.js';
import type { MissionCaller, MissionKernel, LocalVerifier } from '../mission/kernel.js';

type Evidence = Readonly<{ missionId: string; invocationId: string; digest: string }>;
export class NativeProcessEvidence implements LocalVerifier {
  private readonly receipts = new WeakMap<object, Evidence>();
  mint(missionId: string, invocationId: string, digest: string): object {
    const receipt = Object.freeze(Object.create(null)) as object;
    this.receipts.set(receipt, { missionId, invocationId, digest });
    return receipt;
  }
  async verifyEffect(receipt: unknown, missionId: string, invocationId: string, digest: string): Promise<boolean> {
    if (!receipt || typeof receipt !== 'object') return false;
    const known = this.receipts.get(receipt);
    return !!known && known.missionId === missionId &&
      known.invocationId === invocationId && known.digest === digest;
  }
  async verifyWait(): Promise<boolean> { return false; }
  async verifyContinuation(): Promise<boolean> { return false; }
  async verifyCompletion(): Promise<boolean> { return false; }
  async verifyWorkerClaim(): Promise<boolean> { return false; }
  async verifyWorkerReport(): Promise<boolean> { return false; }
  async verifyWorkerReconciliation(): Promise<boolean> { return false; }
}

export interface LocalCommand {
  /** OS-local administrator's exact approved executable, not remote tool input. */
  program: string;
  args: readonly string[];
  timeoutMs: number;
}
export interface CommandOutcome {
  invocationId: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  outputDigest: string;
  receiptDigest: string | null;
  timedOut: boolean;
  cancelled: boolean;
  observed: boolean;
}
function commandValid(spec: LocalCommand): boolean {
  return !!spec && typeof spec.program === 'string' && path.isAbsolute(spec.program) &&
    Array.isArray(spec.args) && spec.args.length <= 32 &&
    spec.args.every(x => typeof x === 'string' && x.length <= 4096 && !/[\u0000\r\n]/.test(x)) &&
    Number.isSafeInteger(spec.timeoutMs) && spec.timeoutMs >= 100 && spec.timeoutMs <= 60_000;
}

/** An OS-approved *exact* invocation, not just permission to use an interpreter. */
export type ApprovedCommand = Readonly<{ missionId: string; invocationId: string; spec: LocalCommand }>;
export class NextNativeCommandExecutor {
  private readonly approvedCommands: Map<string, ApprovedCommand>;
  private readonly active = new Map<string, { missionId: string; epoch: number; cancel: () => void }>();
  private readonly unsubscribeFence: () => void;
  constructor(
    private readonly kernel: MissionKernel,
    private readonly evidence: NativeProcessEvidence,
    approvedCommands: ReadonlyMap<string, ApprovedCommand>
  ) {
    // Deep immutable snapshot. Later mutation of the original map or argv list
    // cannot elevate an already admitted invocation into another shell command.
    this.approvedCommands = new Map([...approvedCommands].map(([key, value]) => [key, {
      missionId: value.missionId, invocationId: value.invocationId,
      spec: { program: value.spec.program, args: [...value.spec.args], timeoutMs: value.spec.timeoutMs }
    }]));
    this.unsubscribeFence = kernel.subscribeEpochFence((missionId, epoch) => {
      for (const running of this.active.values()) {
        if (running.missionId === missionId && running.epoch <= epoch) running.cancel();
      }
    });
  }
  /** Native runtime shutdown cancels in-flight commands, never claims completion. */
  dispose(): void {
    this.unsubscribeFence();
    for (const running of this.active.values()) running.cancel();
  }

  async run(ctx: MissionCaller, invocationId: string, spec: LocalCommand): Promise<CommandOutcome> {
    const key = ctx.missionId + '\0' + invocationId;
    const approved = this.approvedCommands.get(key);
    if (!commandValid(spec) || !approved || approved.missionId !== ctx.missionId ||
        approved.invocationId !== invocationId || !commandValid(approved.spec) ||
        approved.spec.program !== spec.program || approved.spec.timeoutMs !== spec.timeoutMs ||
        approved.spec.args.length !== spec.args.length ||
        !approved.spec.args.every((x, i) => x === spec.args[i]))
      throw new Error('PROGRAM_NOT_APPROVED');
    const cwd = await this.kernel.projectRoot(ctx);
    let completion: Promise<CommandOutcome> | null = null;
    await this.kernel.dispatchWithStarter(ctx, invocationId, () => {
      // No shell interpolation, no inherited home secrets or arbitrary env.
      const child = spawn(spec.program, [...spec.args], {
        cwd,
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        env: { PATH: process.env.PATH ?? (process.platform === 'win32' ? '' : '/usr/bin:/bin') },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      const watcher = this.watch(child, invocationId, spec.timeoutMs);
      this.active.set(key, { missionId: ctx.missionId, epoch: ctx.epoch, cancel: watcher.cancel });
      completion = watcher.promise;
    });
    if (!completion) throw new Error('DISPATCH_LACKS_CHILD_RECEIPT');
    let outcome: CommandOutcome;
    try { outcome = await completion; }
    finally { this.active.delete(key); }
    if (outcome.cancelled || outcome.timedOut || outcome.exitCode === null) return outcome;
    const receipt = this.evidence.mint(ctx.missionId, invocationId, outcome.outputDigest);
    // If Stop committed meanwhile, the old lease fails closed and the effect
    // stays UNKNOWN until a newly approved out-of-band reconciliation.
    try {
      await this.kernel.observeEffect(ctx, invocationId, outcome.outputDigest, receipt);
      return { ...outcome, receiptDigest: outcome.outputDigest, observed: true };
    } catch {
      return { ...outcome, receiptDigest: null, observed: false };
    }
  }

  private watch(child: ChildProcess, invocationId: string,
    timeoutMs: number): { promise: Promise<CommandOutcome>; cancel: () => void } {
    let cancel: () => void = () => {};
    const promise = new Promise<CommandOutcome>(resolve => {
      const hasher = createHash('sha256');
      let outputBytes = 0;
      let timedOut = false;
      let cancelled = false;
      let terminating = false;
      let resolved = false;
      let forcedKill: NodeJS.Timeout | null = null;
      const terminate = (reason: 'timeout' | 'stop'): void => {
        if (terminating || resolved) return;
        terminating = true;
        timedOut = reason === 'timeout';
        cancelled = reason === 'stop';
        if (child.pid) void terminateProcessTree(child.pid, false).catch(() => child.kill('SIGTERM'));
        else child.kill('SIGTERM');
        // A cooperative SIGTERM cannot be assumed. Force the entire owned
        // process group after a bounded grace period.
        forcedKill = setTimeout(() => {
          if (!resolved && child.pid) void terminateProcessTree(child.pid, true).catch(() => child.kill('SIGKILL'));
        }, 1_000);
        forcedKill.unref?.();
      };
      const consume = (tag: string) => (data: Buffer) => {
        if (resolved) return;
        outputBytes += data.byteLength;
        if (outputBytes > 256 * 1024) { terminate('timeout'); return; }
        hasher.update(tag).update(data);
      };
      child.stdout?.on('data', consume('stdout'));
      child.stderr?.on('data', consume('stderr'));
      const timer = setTimeout(() => terminate('timeout'), timeoutMs);
      cancel = () => terminate('stop');
      timer.unref?.();
      const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        if (forcedKill) clearTimeout(forcedKill);
        resolve({
          invocationId, exitCode, signal, timedOut, cancelled,
          outputDigest: hasher.digest('hex'),
          receiptDigest: null, observed: false
        });
      };
      child.once('error', () => { timedOut = true; finish(null, null); });
      child.once('close', (code, signal) => finish(code, signal));
    });
    return { promise, cancel: () => cancel() };
  }
}
