import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  runCommand: vi.fn(),
  getConfig: vi.fn(),
  goalSwitchFor: vi.fn(),
  agentInfoForOwnedConversation: vi.fn(),
  persistCriticalSwarmNow: vi.fn(),
  requestWorkerRevivals: vi.fn(),
  stageWorkerContinuation: vi.fn(),
  backgroundExecObligations: vi.fn(),
  execOwner: vi.fn(),
  enqueueInput: vi.fn(),
  getSession: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn()
}));

vi.mock('../src/main/exec.js', () => ({ runCommand: mocks.runCommand }));
vi.mock('../src/main/config.js', () => ({ getConfig: mocks.getConfig }));
vi.mock('../src/main/goal.js', () => ({ goalSwitchFor: mocks.goalSwitchFor }));
vi.mock('../src/main/agents.js', () => ({
  agentInfoForOwnedConversation: mocks.agentInfoForOwnedConversation,
  persistCriticalSwarmNow: mocks.persistCriticalSwarmNow,
  requestWorkerRevivals: mocks.requestWorkerRevivals,
  stageWorkerContinuation: mocks.stageWorkerContinuation
}));
vi.mock('../src/main/codex/ownership.js', () => ({
  backgroundExecObligations: mocks.backgroundExecObligations,
  execOwner: mocks.execOwner
}));
vi.mock('../src/main/session/input.js', () => ({ enqueueInput: mocks.enqueueInput }));
vi.mock('../src/main/session/store.js', () => ({ getSession: mocks.getSession }));
vi.mock('../src/main/logger.js', () => ({ logInfo: mocks.logInfo, logWarn: mocks.logWarn }));

const { initDurableStore, resetDurableForTests } = await import('../src/main/durable.js');
const {
  armLongRunWaitNow,
  ensureRecoveryWorkNow,
  longRunStatus,
  resetLongRunStateForTests
} = await import('../src/main/session/long-run.js');
const {
  pollLongRunRuntime,
  resetLongRunRuntimeForTests
} = await import('../src/main/session/long-run-runtime.js');

const SESSION = 'session-runtime';
const CHAT = 'conversation-runtime';
let directory: string;

beforeEach(async () => {
  vi.clearAllMocks();
  resetLongRunRuntimeForTests();
  resetLongRunStateForTests();
  resetDurableForTests();
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clf-long-run-runtime-'));
  initDurableStore(directory);

  mocks.getConfig.mockReturnValue({ multiAgent: { enabled: true } });
  mocks.goalSwitchFor.mockReturnValue({ enabled: false, mode: 'goal', own: true, afterTurn: false });
  mocks.agentInfoForOwnedConversation.mockReturnValue(null);
  mocks.persistCriticalSwarmNow.mockResolvedValue(true);
  mocks.requestWorkerRevivals.mockReturnValue(1);
  mocks.stageWorkerContinuation.mockReturnValue(null);
  mocks.backgroundExecObligations.mockReturnValue({ running: [], exitedUnread: [] });
  mocks.execOwner.mockReturnValue(null);
  mocks.enqueueInput.mockResolvedValue({ state: 'queued' });
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
  resetDurableForTests();
  await fs.rm(directory, { recursive: true, force: true });
});

describe('local long-run supervisor', () => {
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
