import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LongRunSnapshot } from '../src/main/session/long-run.js';

const mocks = vi.hoisted(() => ({
  runCommand: vi.fn(),
  getConfig: vi.fn(),
  effectiveCapabilities: vi.fn(),
  loadSessionProjectRuntimeProfile: vi.fn(),
  evaluateSessionProjectCompletion: vi.fn(),
  goalSwitchFor: vi.fn(),
  agentInfoForOwnedConversation: vi.fn(),
  persistCriticalSwarmNow: vi.fn(),
  requestWorkerRevivals: vi.fn(),
  retireWorkerContinuationIfUnsent: vi.fn(),
  stageWorkerContinuation: vi.fn(),
  backgroundExecObligations: vi.fn(),
  execOwner: vi.fn(),
  enqueueInput: vi.fn(),
  getSession: vi.fn(),
  sessionAutonomyPaused: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  transportReady: true
}));

vi.mock('../src/main/exec.js', () => ({ runCommand: mocks.runCommand }));
vi.mock('../src/main/config.js', () => ({
  getConfig: mocks.getConfig,
  effectiveCapabilities: mocks.effectiveCapabilities
}));
vi.mock('../src/main/project-runtime.js', () => ({
  loadSessionProjectRuntimeProfile: mocks.loadSessionProjectRuntimeProfile,
  evaluateSessionProjectCompletion: mocks.evaluateSessionProjectCompletion
}));
vi.mock('../src/main/goal.js', () => ({ goalSwitchFor: mocks.goalSwitchFor }));
vi.mock('../src/main/agents.js', () => ({
  agentInfoForOwnedConversation: mocks.agentInfoForOwnedConversation,
  persistCriticalSwarmNow: mocks.persistCriticalSwarmNow,
  requestWorkerRevivals: mocks.requestWorkerRevivals,
  retireWorkerContinuationIfUnsent: mocks.retireWorkerContinuationIfUnsent,
  stageWorkerContinuation: mocks.stageWorkerContinuation
}));
vi.mock('../src/main/codex/ownership.js', () => ({
  backgroundExecObligations: mocks.backgroundExecObligations,
  execOwner: mocks.execOwner
}));
vi.mock('../src/main/session/input.js', () => ({ enqueueInput: mocks.enqueueInput }));
vi.mock('../src/main/session/store.js', () => ({
  getSession: mocks.getSession,
  sessionAutonomyPaused: mocks.sessionAutonomyPaused
}));
vi.mock('../src/main/logger.js', () => ({ logInfo: mocks.logInfo, logWarn: mocks.logWarn }));
vi.mock('../src/main/session/connectivity.js', () => ({
  providerTransportReady: () => mocks.transportReady
}));

const { initDurableStore, readDurable, resetDurableForTests } = await import('../src/main/durable.js');
const { noteDurableRecoveryIncident, resetDurableRecoveryForTests } = await import('../src/main/durable-recovery.js');
const {
  LONG_RUN_STATE,
  armLongRunWaitNow,
  captureExecutionTicket,
  claimProjectCompletionCheckNow,
  ensureRecoveryWorkNow,
  leaseLongRunWorkNow,
  longRunStatus,
  moveLongRunStateNow,
  pauseLongRunTransportNow,
  resolveLongRunWaitNow,
  restoreLongRunState,
  resumeLongRunTransportNow,
  markLongRunWorkQueuedNow,
  noteLongRunProgressNow,
  resetLongRunStateForTests
} = await import('../src/main/session/long-run.js');
const {
  pollLongRunRuntime,
  resetLongRunRuntimeForTests
} = await import('../src/main/session/long-run-runtime.js');
const { registerLongRunWaitProvider } = await import('../src/main/session/wait-providers.js');

const customInspect = vi.fn(async (_wait: unknown, _now: number) => ({
  kind: 'resolved' as const,
  result: 'Custom provider job completed successfully',
  failed: false
}));
registerLongRunWaitProvider({
  kind: 'fixture_job',
  describe: (_wait, detail) => `Fixture job: ${detail}`,
  inspect: (wait, now) => customInspect(wait, now)
});

const SESSION = 'session-runtime';
const CHAT = 'conversation-runtime';
let directory: string;

beforeEach(async () => {
  vi.clearAllMocks();
  resetLongRunRuntimeForTests();
  resetLongRunStateForTests();
  resetDurableRecoveryForTests();
  resetDurableForTests();
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clf-long-run-runtime-'));
  initDurableStore(directory);

  mocks.transportReady = true;
  mocks.getConfig.mockReturnValue({ multiAgent: { enabled: true } });
  mocks.effectiveCapabilities.mockReturnValue({ command: true, read: true, metadata: true });
  mocks.loadSessionProjectRuntimeProfile.mockResolvedValue(null);
  mocks.evaluateSessionProjectCompletion.mockResolvedValue({
    state: 'unconfigured',
    projectId: null,
    projectName: null,
    profilePath: null,
    mode: null,
    checks: []
  });
  mocks.goalSwitchFor.mockReturnValue({ enabled: false, mode: 'goal', own: true, afterTurn: false });
  mocks.agentInfoForOwnedConversation.mockReturnValue(null);
  mocks.persistCriticalSwarmNow.mockResolvedValue(true);
  mocks.requestWorkerRevivals.mockReturnValue(1);
  mocks.retireWorkerContinuationIfUnsent.mockReturnValue('absent');
  mocks.stageWorkerContinuation.mockReturnValue(null);
  mocks.backgroundExecObligations.mockReturnValue({ running: [], exitedUnread: [] });
  mocks.execOwner.mockReturnValue(null);
  mocks.enqueueInput.mockResolvedValue({ state: 'queued' });
  mocks.sessionAutonomyPaused.mockImplementation((session: { autonomyPausedAt?: number | null } | null | undefined) =>
    typeof session?.autonomyPausedAt === 'number' && session.autonomyPausedAt > 0
  );
  mocks.getSession.mockResolvedValue({
    id: SESSION,
    conversationId: CHAT,
    recovery: null,
    origin: { kind: 'desktop' }
  });
});

afterEach(async () => {
  resetLongRunRuntimeForTests();
  resetLongRunStateForTests();
  resetDurableRecoveryForTests();
  resetDurableForTests();
  await fs.rm(directory, { recursive: true, force: true });
});

describe('local long-run supervisor', () => {
  it('does no runtime or broker work while long-run durable recovery is paused', async () => {
    await ensureRecoveryWorkNow(SESSION, CHAT, 'recovery:paused-runtime');
    noteDurableRecoveryIncident({
      domain: 'long-run',
      ledger: 'long-run',
      failure: 'json_corrupt',
      disposition: 'pause'
    });

    await pollLongRunRuntime(Date.now() + 120_000);

    expect(mocks.loadSessionProjectRuntimeProfile).not.toHaveBeenCalled();
    expect(mocks.evaluateSessionProjectCompletion).not.toHaveBeenCalled();
    expect(mocks.enqueueInput).not.toHaveBeenCalled();
    expect(mocks.retireWorkerContinuationIfUnsent).not.toHaveBeenCalled();
    expect(mocks.stageWorkerContinuation).not.toHaveBeenCalled();
    expect(customInspect).not.toHaveBeenCalled();
  });

  it('turns a timer completion into exactly one durable continuation', async () => {
    const dueAt = Date.now() + 1_000;
    await armLongRunWaitNow({
      sessionId: SESSION,
      conversationId: CHAT,
      sourceTurnId: 'turn-before-wait',
      kind: 'timer',
      dueAt,
      description: 'wait outside provider turn'
    });

    await pollLongRunRuntime(dueAt + 1);

    const work = longRunStatus(SESSION).work;
    expect(work).toMatchObject({ reason: 'wait_resolved', state: 'queued' });
    expect(mocks.enqueueInput).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueInput.mock.calls[0]?.[2]).toBe(work?.id);
    expect(mocks.enqueueInput.mock.calls[0]?.[0]).toMatchObject({
      id: work?.inputId,
      sessionId: SESSION,
      mode: 'after-turn',
      afterTurn: true
    });

    await pollLongRunRuntime(dueAt + 10_000);
    expect(mocks.enqueueInput).toHaveBeenCalledTimes(1);
  });

  it('stops an owed continuation when an opted-in machine completion rule is satisfied', async () => {
    mocks.loadSessionProjectRuntimeProfile.mockResolvedValue({
      projectId: 'project-1',
      projectName: 'Generic project',
      projectReal: '/project',
      profilePath: '/project/.cos/project.json',
      profile: {
        version: 1,
        tasks: {},
        completion: {
          mode: 'all',
          autoStop: true,
          checks: [{ kind: 'path_exists', path: 'done.marker' }]
        }
      }
    });
    mocks.evaluateSessionProjectCompletion.mockResolvedValue({
      state: 'satisfied',
      projectId: 'project-1',
      projectName: 'Generic project',
      profilePath: '/project/.cos/project.json',
      mode: 'all',
      checks: [{ check: { kind: 'path_exists', path: 'done.marker' }, state: 'satisfied', detail: 'path exists' }]
    });

    const dueAt = Date.now() + 1_000;
    await armLongRunWaitNow({
      sessionId: SESSION,
      conversationId: CHAT,
      sourceTurnId: 'turn-complete',
      kind: 'timer',
      dueAt
    });

    await pollLongRunRuntime(dueAt + 1);

    expect(longRunStatus(SESSION).work).toMatchObject({ state: 'fulfilled', reason: 'wait_resolved' });
    expect(mocks.evaluateSessionProjectCompletion).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueInput).not.toHaveBeenCalled();

    await pollLongRunRuntime(dueAt + 10_000);
    expect(mocks.evaluateSessionProjectCompletion).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueInput).not.toHaveBeenCalled();
  });

  it.each(['unsatisfied', 'blocked'] as const)(
    'continues durable work when an opted-in completion rule is %s',
    async state => {
      mocks.loadSessionProjectRuntimeProfile.mockResolvedValue({
        projectId: 'project-1',
        projectName: 'Generic project',
        projectReal: '/project',
        profilePath: '/project/.cos/project.json',
        profile: {
          version: 1,
          tasks: {},
          completion: {
            mode: 'all',
            autoStop: true,
            checks: [{ kind: 'path_exists', path: 'done.marker' }]
          }
        }
      });
      mocks.evaluateSessionProjectCompletion.mockResolvedValue({
        state,
        projectId: 'project-1',
        projectName: 'Generic project',
        profilePath: '/project/.cos/project.json',
        mode: 'all',
        checks: []
      });

      const dueAt = Date.now() + 1_000;
      await armLongRunWaitNow({
        sessionId: SESSION,
        conversationId: CHAT,
        sourceTurnId: `turn-${state}`,
        kind: 'timer',
        dueAt
      });

      await pollLongRunRuntime(dueAt + 1);

      expect(mocks.evaluateSessionProjectCompletion).toHaveBeenCalledTimes(1);
      expect(mocks.enqueueInput).toHaveBeenCalledTimes(1);
      expect(longRunStatus(SESSION).work).toMatchObject({ state: 'queued' });
    }
  );

  it('does not evaluate completion automatically unless the project explicitly opts in', async () => {
    mocks.loadSessionProjectRuntimeProfile.mockResolvedValue({
      projectId: 'project-1',
      projectName: 'Generic project',
      projectReal: '/project',
      profilePath: '/project/.cos/project.json',
      profile: {
        version: 1,
        tasks: {},
        completion: {
          mode: 'all',
          autoStop: false,
          checks: [{ kind: 'path_exists', path: 'done.marker' }]
        }
      }
    });
    const dueAt = Date.now() + 1_000;
    await armLongRunWaitNow({
      sessionId: SESSION,
      conversationId: CHAT,
      sourceTurnId: 'turn-no-auto-stop',
      kind: 'timer',
      dueAt
    });

    await pollLongRunRuntime(dueAt + 1);

    expect(mocks.evaluateSessionProjectCompletion).not.toHaveBeenCalled();
    expect(mocks.enqueueInput).toHaveBeenCalledTimes(1);
    expect(longRunStatus(SESSION).work).toMatchObject({ state: 'queued' });
  });

  it('persists a completion claim across crash restore and executor rebind without replaying the verifier', async () => {
    const reboundConversation = 'conversation-runtime-rebound';
    const dueAt = Date.now() + 60_000;
    const wait = await armLongRunWaitNow({
      sessionId: SESSION,
      conversationId: CHAT,
      sourceTurnId: 'turn-claim-crash',
      kind: 'timer',
      dueAt
    });
    const ticket = captureExecutionTicket(SESSION, CHAT);
    expect(ticket).not.toBeNull();
    expect(await resolveLongRunWaitNow(SESSION, wait.id, ticket!, 'timer resolved')).toBe(true);
    const owed = longRunStatus(SESSION).work!;
    expect(owed.state).toBe('owed');

    expect(await claimProjectCompletionCheckNow(SESSION, owed.id, ticket!)).toBe(true);
    const claimedAt = longRunStatus(SESSION).work?.completionCheckClaimedAt;
    expect(claimedAt).toEqual(expect.any(Number));

    // The claim is part of the fsynced WAL, not a process-memory retry cache.
    const persisted = await readDurable<LongRunSnapshot>(LONG_RUN_STATE);
    expect(persisted?.obligations[0]?.completionCheckClaimedAt).toBe(claimedAt);

    // Rebinding authority must not reopen an ambiguous command-backed evaluation.
    expect(await moveLongRunStateNow(SESSION, CHAT, reboundConversation)).toBe(true);
    const reboundTicket = captureExecutionTicket(SESSION, reboundConversation);
    expect(reboundTicket).not.toBeNull();
    expect(await claimProjectCompletionCheckNow(SESSION, owed.id, reboundTicket!)).toBe(false);
    expect(longRunStatus(SESSION).work?.completionCheckClaimedAt).toBe(claimedAt);

    const reboundSnapshot = await readDurable<LongRunSnapshot>(LONG_RUN_STATE);
    resetLongRunStateForTests();
    restoreLongRunState(reboundSnapshot);
    mocks.getSession.mockResolvedValue({
      id: SESSION,
      conversationId: reboundConversation,
      recovery: null,
      origin: { kind: 'desktop' }
    });
    mocks.loadSessionProjectRuntimeProfile.mockResolvedValue({
      projectId: 'project-1',
      projectName: 'Generic project',
      projectReal: '/project',
      profilePath: '/project/.cos/project.json',
      profile: {
        version: 1,
        tasks: { verify: { argv: ['verifier'], timeoutMs: 5_000 } },
        completion: {
          mode: 'all',
          autoStop: true,
          checks: [{ kind: 'task_success', task: 'verify' }]
        }
      }
    });
    mocks.evaluateSessionProjectCompletion.mockResolvedValue({
      state: 'satisfied',
      projectId: 'project-1',
      projectName: 'Generic project',
      profilePath: '/project/.cos/project.json',
      mode: 'all',
      checks: [{ check: { kind: 'task_success', task: 'verify' }, state: 'satisfied', detail: 'ok' }]
    });

    await pollLongRunRuntime(Date.now());

    expect(mocks.loadSessionProjectRuntimeProfile).not.toHaveBeenCalled();
    expect(mocks.evaluateSessionProjectCompletion).not.toHaveBeenCalled();
    expect(mocks.enqueueInput).toHaveBeenCalledTimes(1);
    expect(longRunStatus(SESSION).work).toMatchObject({
      id: owed.id,
      conversationId: reboundConversation,
      state: 'queued',
      completionCheckClaimedAt: claimedAt
    });
  });

  it('resolves a GitHub Actions run locally and wakes the durable task once', async () => {
    mocks.runCommand.mockResolvedValue({
      exitCode: 0,
      stdout: '{"status":"completed","conclusion":"success"}',
      stderr: '',
      truncated: false,
      timedOut: false,
      durationMs: 10
    });
    const wait = await armLongRunWaitNow({
      sessionId: SESSION,
      conversationId: CHAT,
      sourceTurnId: 'turn-ci',
      kind: 'github_run',
      repository: 'MurphyHoops/UEOT',
      runId: 123456
    });

    await pollLongRunRuntime(wait.nextCheckAt + 1);

    expect(mocks.runCommand).toHaveBeenCalledWith(
      'gh',
      ['run', 'view', '123456', '--repo', 'MurphyHoops/UEOT', '--json', 'status,conclusion'],
      expect.any(String),
      10_000
    );
    expect(longRunStatus(SESSION).wait).toMatchObject({ state: 'resolved' });
    expect(longRunStatus(SESSION).work).toMatchObject({ state: 'queued', reason: 'wait_resolved' });
    expect(mocks.enqueueInput).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueInput.mock.calls[0]?.[0]?.text).toContain('completed with conclusion success');
  });

  it('parks connectivity-dependent providers offline without spending their failure budget', async () => {
    mocks.transportReady = false;
    const wait = await armLongRunWaitNow({
      sessionId: SESSION,
      conversationId: CHAT,
      sourceTurnId: 'turn-offline-provider',
      kind: 'fixture_job',
      providerKey: 'fixture:offline',
      providerData: { job: 7 }
    });

    await pollLongRunRuntime(wait.nextCheckAt + 1);

    expect(customInspect).not.toHaveBeenCalled();
    expect(longRunStatus(SESSION).wait).toMatchObject({
      id: wait.id,
      state: 'waiting',
      attempts: 0,
      lastError: null
    });
    expect(longRunStatus(SESSION).work).toMatchObject({ state: 'waiting' });
    expect(mocks.enqueueInput).not.toHaveBeenCalled();

    mocks.transportReady = true;
    const deferred = longRunStatus(SESSION).wait!;
    await pollLongRunRuntime(deferred.nextCheckAt + 1);

    expect(customInspect).toHaveBeenCalledTimes(1);
    expect(longRunStatus(SESSION).wait).toMatchObject({ state: 'resolved' });
    expect(longRunStatus(SESSION).work).toMatchObject({ state: 'queued', reason: 'wait_resolved' });
    expect(mocks.enqueueInput).toHaveBeenCalledTimes(1);
  });

  it('lets a local timer resolve offline but parks its provider continuation until reconnect', async () => {
    mocks.transportReady = false;
    const dueAt = Date.now() + 1_000;
    await armLongRunWaitNow({
      sessionId: SESSION,
      conversationId: CHAT,
      sourceTurnId: 'turn-offline-timer',
      kind: 'timer',
      dueAt
    });

    await pollLongRunRuntime(dueAt + 1);

    expect(longRunStatus(SESSION).wait).toMatchObject({ state: 'resolved' });
    expect(longRunStatus(SESSION).work).toMatchObject({ state: 'owed', reason: 'wait_resolved' });
    expect(mocks.enqueueInput).not.toHaveBeenCalled();

    mocks.transportReady = true;
    await pollLongRunRuntime(dueAt + 2);

    expect(longRunStatus(SESSION).work).toMatchObject({ state: 'queued' });
    expect(mocks.enqueueInput).toHaveBeenCalledTimes(1);
  });

  it('dispatches a project-specific wait through the generic provider registry', async () => {
    const wait = await armLongRunWaitNow({
      sessionId: SESSION,
      conversationId: CHAT,
      sourceTurnId: 'turn-custom-provider',
      kind: 'fixture_job',
      providerKey: 'fixture:job:42',
      providerData: { job: 42, project: 'generic-project' },
      description: 'generic adapter wait'
    });

    await pollLongRunRuntime(wait.nextCheckAt + 1);

    expect(customInspect).toHaveBeenCalledTimes(1);
    expect(customInspect).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'fixture_job',
        providerKey: 'fixture:job:42',
        providerData: { job: 42, project: 'generic-project' }
      }),
      wait.nextCheckAt + 1
    );
    expect(longRunStatus(SESSION).wait).toMatchObject({
      kind: 'fixture_job',
      providerKey: 'fixture:job:42',
      state: 'resolved'
    });
    expect(longRunStatus(SESSION).work).toMatchObject({
      state: 'queued',
      reason: 'wait_resolved',
      source: 'fixture:job:42'
    });
    expect(mocks.enqueueInput).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueInput.mock.calls[0]?.[0]?.text).toContain('Custom provider job completed successfully');
  });

  it('continues a recovered worker through the durable revival broker even when Goal is off', async () => {
    mocks.agentInfoForOwnedConversation.mockReturnValue({
      id: 'worker-1',
      role: 'worker',
      runId: 'run-1',
      primeConversationId: 'prime-conversation',
      state: 'sleeping'
    });
    const commit = vi.fn();
    const rollback = vi.fn();
    mocks.stageWorkerContinuation.mockImplementation((_conversationId: string, stableId: string) => ({
      messages: [{ id: stableId }],
      waking: ['worker-1'],
      runId: 'run-1',
      commit,
      rollback
    }));
    mocks.getSession.mockResolvedValue({
      id: SESSION,
      conversationId: CHAT,
      recovery: { phase: 'recovered' },
      origin: { kind: 'worker' }
    });
    const work = await ensureRecoveryWorkNow(SESSION, CHAT, 'recovery:episode:1');

    await pollLongRunRuntime(work!.createdAt + 90_001);

    expect(mocks.enqueueInput).not.toHaveBeenCalled();
    expect(mocks.stageWorkerContinuation).toHaveBeenCalledTimes(1);
    expect(mocks.stageWorkerContinuation).toHaveBeenCalledWith(
      CHAT,
      expect.any(String),
      expect.stringContaining('CLF-CONTINUE')
    );
    const stableId = mocks.stageWorkerContinuation.mock.calls[0]?.[1];
    expect(stableId).toBe(longRunStatus(SESSION).work?.inputId);
    expect(mocks.persistCriticalSwarmNow).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(rollback).not.toHaveBeenCalled();
    expect(mocks.requestWorkerRevivals).toHaveBeenCalledWith(['worker-1'], 'run-1');
    expect(longRunStatus(SESSION).work).toMatchObject({
      id: work!.id,
      reason: 'recovery_resume',
      state: 'queued'
    });
  });

  it('does not spend recovery probation while provider transport is suspended', async () => {
    mocks.agentInfoForOwnedConversation.mockReturnValue({
      id: 'worker-1',
      role: 'worker',
      runId: 'run-1',
      primeConversationId: 'prime-conversation',
      state: 'sleeping'
    });
    const commit = vi.fn();
    mocks.stageWorkerContinuation.mockImplementation((_conversationId: string, stableId: string) => ({
      messages: [{ id: stableId }], waking: ['worker-1'], runId: 'run-1', commit, rollback: vi.fn()
    }));
    mocks.getSession.mockResolvedValue({
      id: SESSION,
      conversationId: CHAT,
      recovery: { phase: 'recovered' },
      origin: { kind: 'worker' }
    });
    const work = await ensureRecoveryWorkNow(SESSION, CHAT, 'recovery:episode:transport-budget');
    expect(work).not.toBeNull();

    const pausedAt = work!.createdAt + 30_000;
    await pauseLongRunTransportNow(pausedAt);
    mocks.transportReady = false;
    await pollLongRunRuntime(pausedAt + 10 * 60_000);
    expect(mocks.stageWorkerContinuation).not.toHaveBeenCalled();

    const resumedAt = pausedAt + 10 * 60_000;
    await resumeLongRunTransportNow(resumedAt);
    mocks.transportReady = true;
    await pollLongRunRuntime(resumedAt + 59_999);
    expect(mocks.stageWorkerContinuation).not.toHaveBeenCalled();

    await pollLongRunRuntime(resumedAt + 60_000);
    expect(mocks.stageWorkerContinuation).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(longRunStatus(SESSION).work).toMatchObject({ id: work!.id, state: 'queued' });
  });

  it('reconciles a revoked provably-unsent worker continuation out of the durable broker', async () => {
    mocks.agentInfoForOwnedConversation.mockReturnValue({
      id: 'worker-1',
      role: 'worker',
      runId: 'run-1',
      primeConversationId: 'prime-conversation',
      state: 'sleeping'
    });
    mocks.getSession.mockResolvedValue({
      id: SESSION,
      conversationId: CHAT,
      recovery: null,
      origin: { kind: 'worker' }
    });
    mocks.retireWorkerContinuationIfUnsent.mockReturnValue('retired');

    const work = await ensureRecoveryWorkNow(SESSION, CHAT, 'recovery:episode:cleanup');
    const leased = await leaseLongRunWorkNow(SESSION, CHAT);
    expect(leased?.work.inputId).toEqual(expect.any(String));
    expect(await markLongRunWorkQueuedNow(
      SESSION,
      leased!.work.id,
      leased!.ticket,
      leased!.work.inputId!
    )).toBe(true);
    expect(await noteLongRunProgressNow(
      SESSION,
      CHAT,
      work!.createdAt + 1,
      'certified-new-turn',
      'mcp'
    )).toBe(true);
    expect(longRunStatus(SESSION).work?.state).toBe('fulfilled');

    await pollLongRunRuntime(work!.createdAt + 2);

    expect(mocks.retireWorkerContinuationIfUnsent).toHaveBeenCalledWith(
      CHAT,
      leased!.work.inputId!,
      expect.stringContaining('is fulfilled')
    );
    expect(mocks.persistCriticalSwarmNow).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueInput).not.toHaveBeenCalled();
  });

  it('parks worker continuation debt while multi-agent mode is disabled', async () => {
    mocks.getConfig.mockReturnValue({ multiAgent: { enabled: false } });
    mocks.agentInfoForOwnedConversation.mockReturnValue({
      id: 'worker-1',
      role: 'worker',
      runId: 'run-1',
      primeConversationId: 'prime-conversation',
      state: 'sleeping'
    });
    mocks.getSession.mockResolvedValue({
      id: SESSION,
      conversationId: CHAT,
      recovery: null,
      origin: { kind: 'worker' }
    });
    const work = await ensureRecoveryWorkNow(SESSION, CHAT, 'recovery:episode:disabled');

    await pollLongRunRuntime(work!.createdAt + 90_001);

    expect(mocks.stageWorkerContinuation).not.toHaveBeenCalled();
    expect(mocks.enqueueInput).not.toHaveBeenCalled();
    expect(longRunStatus(SESSION).work).toMatchObject({ id: work!.id, state: 'dispatching' });
  });

  it('does not bypass the agent broker while a worker is still active', async () => {
    mocks.agentInfoForOwnedConversation.mockReturnValue({
      id: 'worker-1',
      role: 'worker',
      runId: 'run-1',
      primeConversationId: 'prime-conversation',
      state: 'active'
    });
    mocks.getSession.mockResolvedValue({
      id: SESSION,
      conversationId: CHAT,
      recovery: null,
      origin: { kind: 'worker' }
    });
    mocks.stageWorkerContinuation.mockReturnValue(null);
    const work = await ensureRecoveryWorkNow(SESSION, CHAT, 'recovery:episode:active');

    await pollLongRunRuntime(work!.createdAt + 90_001);

    expect(mocks.enqueueInput).not.toHaveBeenCalled();
    expect(mocks.stageWorkerContinuation).toHaveBeenCalledTimes(1);
    expect(mocks.persistCriticalSwarmNow).not.toHaveBeenCalled();
    expect(mocks.requestWorkerRevivals).not.toHaveBeenCalled();
    expect(longRunStatus(SESSION).work).toMatchObject({
      id: work!.id,
      state: 'dispatching'
    });
  });

  it('keeps resolved autonomous work dormant while the durable session is user-paused', async () => {
    mocks.goalSwitchFor.mockReturnValue({ enabled: true, mode: 'goal', own: true, afterTurn: false });
    mocks.getSession.mockResolvedValue({
      id: SESSION,
      conversationId: CHAT,
      autonomyPausedAt: Date.now(),
      recovery: null,
      origin: { kind: 'desktop' }
    });
    const work = await ensureRecoveryWorkNow(SESSION, CHAT, 'recovery:episode:paused');

    await pollLongRunRuntime(work!.createdAt + 90_001);

    expect(mocks.enqueueInput).not.toHaveBeenCalled();
    expect(mocks.stageWorkerContinuation).not.toHaveBeenCalled();
    expect(longRunStatus(SESSION).work).toMatchObject({ id: work!.id, state: 'owed' });
  });

  it('does not dispatch autonomous work while recovery_failed may still hold ambiguous-send fences', async () => {
    mocks.goalSwitchFor.mockReturnValue({ enabled: true, mode: 'goal', own: true, afterTurn: false });
    mocks.getSession.mockResolvedValue({
      id: SESSION,
      conversationId: CHAT,
      recovery: { phase: 'recovery_failed' },
      origin: { kind: 'desktop' }
    });
    const work = await ensureRecoveryWorkNow(SESSION, CHAT, 'recovery:episode:failed');

    await pollLongRunRuntime(work!.createdAt + 90_001);

    expect(mocks.enqueueInput).not.toHaveBeenCalled();
    expect(longRunStatus(SESSION).work).toMatchObject({ id: work!.id, state: 'owed' });
  });

  it('keeps recovery debt dormant when neither Goal nor an agent owns autonomy', async () => {
    const work = await ensureRecoveryWorkNow(SESSION, CHAT, 'recovery:episode:2');

    await pollLongRunRuntime(work!.createdAt + 90_001);

    expect(mocks.enqueueInput).not.toHaveBeenCalled();
    expect(longRunStatus(SESSION).work).toMatchObject({ id: work!.id, state: 'owed' });
  });
});
