/**
 * CoS Next local-first headless Mission Runtime.
 *
 * Deliberately starts NO ChatGPT Tunnel, Chrome extension, inference API,
 * browser automation or legacy CoS service. Transport connectivity is an
 * independent, explicitly approved product gate; this class only bootstraps
 * isolated durable state and controls its single writer ownership.
 */
import { flushDurable, initDurableStore } from '../../durable.js';
import {
  MissionLeaseRegistry, DurableMissionLeaseStorage,
  type MissionLeaseAuthority
} from '../auth/mission-leases.js';
import {
  MissionKernel, DurableMissionStorage,
  type LocalAdministrator, type LocalVerifier
} from '../mission/kernel.js';
import { acquireNextWriter, defaultNextUserData, type NextWriterOwner } from './writer.js';

export type NextRuntimeState =
  | 'OFF' | 'STARTING' | 'READY' | 'REAPPROVAL_REQUIRED' | 'HOLD'
  | 'STOPPING' | 'STOPPED';
export interface LocalRuntimeDependencies {
  readonly userData?: string;
  /** Only honored by automated tests; cannot redirect production out of OS user home. */
  readonly testHome?: string;
  readonly authority: MissionLeaseAuthority;
  readonly admin: LocalAdministrator;
  readonly verifier: LocalVerifier;
}
export class NextLocalRuntime {
  private state: NextRuntimeState = 'OFF';
  private writer: NextWriterOwner | null = null;
  private owner: MissionLeaseRegistry | null = null;
  private journal: MissionKernel | null = null;
  private startFlight: Promise<void> | null = null;
  private stopFlight: Promise<void> | null = null;
  private stopRequested = false;

  constructor(private readonly deps: LocalRuntimeDependencies) {}

  get health(): Readonly<{
    state: NextRuntimeState; leases: string; mission: string;
    connector: 'NOT_STARTED'; model: 'NOT_STARTED';
  }> {
    return {
      state: this.state,
      leases: this.owner?.posture ?? 'new',
      mission: this.journal?.posture ?? 'NEW',
      connector: 'NOT_STARTED',
      model: 'NOT_STARTED'
    };
  }
  get mission(): MissionKernel {
    if (!this.journal || !['READY', 'REAPPROVAL_REQUIRED'].includes(this.state)) {
      throw new Error('NEXT_RUNTIME_NOT_AUTHORIZED');
    }
    return this.journal;
  }
  get leases(): MissionLeaseRegistry {
    if (!this.owner || !['READY', 'REAPPROVAL_REQUIRED'].includes(this.state)) {
      throw new Error('NEXT_RUNTIME_NOT_AUTHORIZED');
    }
    return this.owner;
  }

  async start(): Promise<void> {
    if (this.state !== 'OFF') throw new Error('NEXT_RUNTIME_ALREADY_STARTED');
    this.state = 'STARTING';
    this.startFlight = (async () => {
      try {
        if (this.deps.testHome !== undefined && process.env.NODE_ENV !== 'test') {
          throw new Error('TEST_HOME_FORBIDDEN_IN_PRODUCTION');
        }
        const writer = await acquireNextWriter(this.deps.userData ?? defaultNextUserData(),
          this.deps.testHome ? { home: this.deps.testHome } : undefined);
        this.writer = writer;
        if (this.stopRequested) { this.state = 'HOLD'; return; }
        // There is exactly one durable root for this isolated process instance.
        initDurableStore(writer.dataDir);
        const leases = new MissionLeaseRegistry(new DurableMissionLeaseStorage(), this.deps.authority);
        const missions = new MissionKernel(new DurableMissionStorage(), leases, this.deps.admin, this.deps.verifier);
        this.owner = leases;
        this.journal = missions;
        await leases.restore();
        await missions.restore();
        if (this.stopRequested) { this.state = 'HOLD'; return; }
        if (leases.posture === 'blocked' || missions.posture === 'BLOCKED') {
          this.state = 'HOLD';
          return;
        }
        this.state = leases.posture === 'restart_locked' ? 'REAPPROVAL_REQUIRED' : 'READY';
      } catch {
        this.state = 'HOLD';
        // Never release a possibly-initialized writer until shutdown has flushed.
        throw new Error('NEXT_STARTUP_FAILED');
      }
    })();
    await this.startFlight;
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    if (this.stopFlight) return this.stopFlight;
    this.stopFlight = (async () => {
      // An in-flight startup must finish before we can release the writer.
      try { await this.startFlight; } catch { /* remain HOLD, attempt safe flush */ }
      this.state = 'STOPPING';
      // A failed second contender never owned state. It must not flush another
      // runtime's process-global durable writer or touch its data root.
      if (!this.writer) { this.state = 'STOPPED'; return; }
      try {
        await flushDurable();
        await this.writer?.verify();
        await this.writer?.release();
      } catch {
        this.state = 'HOLD'; // retain uncertain lock rather than allowing another writer
        throw new Error('NEXT_SHUTDOWN_AMBIGUOUS');
      }
      this.state = 'STOPPED';
    })();
    return this.stopFlight;
  }
}
