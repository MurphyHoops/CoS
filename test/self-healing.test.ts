import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionEvent } from '../src/shared/session.js';
import type { CallContext } from '../src/main/mcp/call-context.js';

vi.mock('electron', () => ({
  safeStorage: {
    isAsyncEncryptionAvailable: async () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptStringAsync: async (value: string) => Buffer.from(value, 'utf8'),
    decryptStringAsync: async (buffer: Buffer) => ({ result: buffer.toString('utf8'), shouldReEncrypt: false })
  },
  clipboard: { readText: () => '', writeText: () => undefined },
  shell: { openExternal: async () => undefined }
}));

const { defaultConfig, initConfigPath, saveConfig } = await import('../src/main/config.js');
const {
  pendingCommands,
  resetBridgeForTests,
  restoreCommands,
  sessionControlsFor,
  setBrowserOpener,
  startEmergencyRecoveryForSpentForTests
} = await import('../src/main/bridge.js');
const {
  agentInfoForOwnedConversation,
  bindConversation,
  currentRunId,
  onSwarmPersistNow,
  primeConversation,
  repairWorkerConversationAfterRecovery,
  resetAgentsForTests,
  restoreSwarm,
  sendMessage,
  snapshotSwarm,
  spawn,
  swarmState
} = await import('../src/main/agents.js');
const { initDurableStore, readDurable, resetDurableForTests, writeDurableNow } = await import('../src/main/durable.js');
const { emptyEvidence, holdWhileSettling, settlingToolCalls } = await import('../src/main/mcp/call-context.js');
const {
  GOAL_OBJECTIVES_STATE,
  GOAL_REPLIES_STATE,
  GOAL_SWITCHES_STATE,
  goalObjectiveFor,
  goalPendingReplyFor,
  goalSwitchFor,
  restoreGoalObjectives,
  restoreGoalReplies,
  restoreGoalSwitches,
  resetGoalStateForTests,
  setGoalObjectiveNow,
  setGoalSwitchNow
} = await import('../src/main/goal.js');
const { resetWorkspaces } = await import('../src/main/workspace.js');
const { longRunStatus, resetLongRunStateForTests } = await import('../src/main/session/long-run.js');
const { openContinuationNow } = await import('../src/main/session/continuation.js');
const { recordChatObservations, resetRecorderForTests, sessionForConversation } = await import('../src/main/session/recorder.js');
const {
  armRecoveryFence,
  disarmRecoveryFence,
  recoveryFenceActive,
  recoveryFenceOwnerActive,
  resetRecoveryFences
} = await import('../src/main/session/recovery-fence.js');
const { endResumeClaim, resetResumeGate, resumeOpeningChat } = await import('../src/main/session/resume-gate.js');
const {
  beginEmergencyResumeDestinationSend,
  beginSelfHealingEpisode,
  bindEmergencyResumeDestination,
  commitEmergencyResume,
  dispatchEmergencyResumeDestinationSend,
  failSelfHealingRecovery,
  markSoftRecovery,
  noteSelfHealingProgress,
  prepareEmergencyResume,
  reconcileSelfHealingAfterRestart,
  recoveryMutationSafety,
  recoveryStatusLabel,
  setSelfHealingRecoveryHooksForTests
} = await import('../src/main/session/self-healing.js');
const {
  appendEvent,
  commitSelfHealingRebind,
  createSession,
  getSession,
  initSessionStore,
  resetSessionStoreForTests
} = await import('../src/main/session/store.js');
const { makeTempDir, removeTempDir } = await import('./helpers.js');

const CHAT_A = '11111111-1111-4111-8111-111111111111';
const CHAT_B = '22222222-2222-4222-8222-222222222222';
const PRIME_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PRIME_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const WORKER_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const WORKER_B = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

let dir: string;

beforeAll(async () => {
  dir = await makeTempDir('clf-self-healing-');
  initConfigPath(dir);
});

beforeEach(async () => {
  resetAgentsForTests();
  resetBridgeForTests();
  resetGoalStateForTests();
  resetRecorderForTests();
  resetWorkspaces();
  resetLongRunStateForTests();
  resetRecoveryFences();
  resetResumeGate();
  resetSessionStoreForTests();
  resetDurableForTests();
  await fs.rm(path.join(dir, 'sessions'), { recursive: true, force: true });
  await fs.rm(path.join(dir, 'state'), { recursive: true, force: true });
  initSessionStore(dir);
  initDurableStore(dir);
  const config = defaultConfig();
  await saveConfig({
    ...config,
    multiAgent: {
      ...config.multiAgent,
      enabled: true,
      maxWorkers: 3,
      selfHealingSessions: true
    }
  });
  onSwarmPersistNow(async () => undefined);
});

afterEach(() => {
  setSelfHealingRecoveryHooksForTests({});
  resetLongRunStateForTests();
  resetBridgeForTests();
  resetResumeGate();
  onSwarmPersistNow(null);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

afterAll(async () => {
  resetAgentsForTests();
  resetSessionStoreForTests();
  resetDurableForTests();
  await removeTempDir(dir);
});

function callEvent(tool: string, changes: unknown[] = []): SessionEvent {
  return {
    seq: 2,
    source: 'mcp',
    kind: 'tool_call',
    turnId: 'turn-one',
    time: 2,
    call: {
      callId: 'call-one',
      tool,
      attribution: 'request_id',
      requestId: 'wfr_self_heal',
      conversationId: CHAT_A,
      attributionMethod: 'request_id',
      args: { text: '{}', chars: 2, truncated: false },
      result: { text: 'ok', chars: 2, truncated: false },
      outcome: 'ok',
      durationMs: 1,
      summary: { title: 'Tool', tone: 'neutral', kind: 'other' },
      changes: changes as never[]
    }
  };
}

async function proveRecoveryDestination(
  sessionId: string,
  episodeId: string,
  destination: string,
  commandId = `test-recovery-${destination.slice(0, 8)}`
): Promise<void> {
  const session = await getSession(sessionId);
  const generation = session?.recovery?.recoveryGeneration;
  expect(generation).toEqual(expect.any(Number));
  expect((await beginEmergencyResumeDestinationSend(sessionId, episodeId, generation!, commandId))?.allowed).toBe(true);
  expect(await dispatchEmergencyResumeDestinationSend(sessionId, episodeId, generation!, commandId)).toBe(true);
  expect(await bindEmergencyResumeDestination(sessionId, episodeId, generation!, commandId, destination, 'test-provider-message')).toBe(true);
}

describe('self-healing mutation safety', () => {
  const start: SessionEvent = { seq: 1, source: 'extension', kind: 'turn_start', turnId: 'turn-one', time: 1 };

  it('permits retry only for an explicitly proven read-only local turn', () => {
    expect(recoveryMutationSafety([start])).toBe('mutating_or_ambiguous');
    expect(recoveryMutationSafety([start, callEvent('read')])).toBe('read_only_safe_retry');
    expect(recoveryMutationSafety([callEvent('read')])).toBe('mutating_or_ambiguous');
    expect(recoveryMutationSafety([start, callEvent('exec_command')])).toBe('mutating_or_ambiguous');
    expect(recoveryMutationSafety([start, callEvent('read', [{ path: '/tmp/x' }])])).toBe('mutating_or_ambiguous');
  });

  it('classifies a read-only Message delivery timed out turn as SAFE_RETRY without losing the recovery fence', async () => {
    const session = await createSession({ title: 'read-only delivery timeout', conversationId: CHAT_A });
    const t = Date.now();
    await appendEvent(session.id, { source: 'extension', kind: 'turn_start', turnId: 'turn-one', time: t });
    await appendEvent(session.id, {
      source: 'mcp', kind: 'tool_call', turnId: 'turn-one', time: t + 1,
      call: { ...(callEvent('read') as Extract<SessionEvent, { kind: 'tool_call' }>).call, callId: 'read-before-timeout' }
    });
    const timeout = 'Message delivery timed out. Please try again.';
    await appendEvent(session.id, {
      source: 'extension', kind: 'chat_error', turnId: 'turn-one', time: t + 2, recoverable: true,
      message: { text: timeout, truncated: false, chars: timeout.length }
    });

    const episode = await beginSelfHealingEpisode(session.id, CHAT_A, 'provider-error', t + 2);
    expect(episode).toMatchObject({ failureKind: 'provider-error', mutationSafety: 'read_only_safe_retry' });
    const prepared = await prepareEmergencyResume(session.id, CHAT_A, episode!.failureEpisodeId);
    expect(prepared?.state.mutationSafety).toBe('read_only_safe_retry');
    expect(recoveryFenceActive(CHAT_A)).toBe(true);
  });

  it('classifies a timeout after a mutating tool as MUTATING_OR_AMBIGUOUS and requires reconciliation instead of replay', async () => {
    const session = await createSession({ title: 'mutating delivery timeout', conversationId: CHAT_A });
    const t = Date.now();
    await appendEvent(session.id, { source: 'extension', kind: 'turn_start', turnId: 'mutating-timeout', time: t });
    await appendEvent(session.id, {
      source: 'mcp', kind: 'tool_call', turnId: 'mutating-timeout', time: t + 1,
      call: { ...(callEvent('exec_command') as Extract<SessionEvent, { kind: 'tool_call' }>).call,
        callId: 'mutation-before-timeout', tool: 'exec_command' }
    });
    await appendEvent(session.id, {
      source: 'extension', kind: 'chat_error', turnId: 'mutating-timeout', time: t + 2, recoverable: true,
      message: { text: 'Message delivery timed out. Please try again.', truncated: false, chars: 45 }
    });

    const episode = await beginSelfHealingEpisode(session.id, CHAT_A, 'provider-error', t + 2);
    expect(episode?.mutationSafety).toBe('mutating_or_ambiguous');
    const prepared = await prepareEmergencyResume(session.id, CHAT_A, episode!.failureEpisodeId);
    expect(prepared?.state.mutationSafety).toBe('mutating_or_ambiguous');
    expect(prepared?.text).toContain('Do not blindly repeat the interrupted turn.');
    expect(prepared?.text).toContain('Only redo an operation if durable evidence proves it did not occur.');
  });

  it('keeps tunnel-interrupted work conservative after an ambiguous mutation result', async () => {
    const session = await createSession({ title: 'tunnel mutation ambiguity', conversationId: CHAT_A });
    const t = Date.now();
    await appendEvent(session.id, { source: 'extension', kind: 'turn_start', turnId: 'tunnel-turn', time: t });
    await appendEvent(session.id, {
      source: 'mcp', kind: 'tool_call', turnId: 'tunnel-turn', time: t + 1,
      call: { ...(callEvent('exec_command') as Extract<SessionEvent, { kind: 'tool_call' }>).call,
        callId: 'tunnel-mutation', tool: 'exec_command' }
    });
    const episode = await beginSelfHealingEpisode(session.id, CHAT_A, 'tunnel-interrupted', t + 1);
    expect(episode).toMatchObject({ failureKind: 'tunnel-interrupted', mutationSafety: 'mutating_or_ambiguous' });
    const prepared = await prepareEmergencyResume(session.id, CHAT_A, episode!.failureEpisodeId);
    expect(prepared?.state).toMatchObject({ phase: 'hard_recovery', mutationSafety: 'mutating_or_ambiguous' });
  });

  it('projects every required recovery phase label through session controls', async () => {
    const expected = [
      ['suspected_stall', 'Suspected stall'],
      ['soft_recovery', 'Reloading'],
      ['hard_recovery', 'Rebinding'],
      ['reconciling', 'Reconciling'],
      ['recovered', 'Recovered'],
      ['recovery_failed', 'Recovery failed']
    ] as const;
    expect(recoveryStatusLabel(null)).toBe('Healthy');
    for (const [phase, label] of expected) expect(recoveryStatusLabel({ phase } as any)).toBe(label);

    const session = await createSession({ title: 'status projection', conversationId: CHAT_A });
    expect((await sessionControlsFor(session.id)).selfHealingStatus).toBe('Healthy');
    await beginSelfHealingEpisode(session.id, CHAT_A, 'silence');
    expect((await sessionControlsFor(session.id)).selfHealingStatus).toBe('Suspected stall');
  });
});

describe('Emergency Resume transaction', () => {
  it('keeps Compact & Resume and Self-Healing mutually exclusive in both directions', async () => {
    const compactFirst = await createSession({ title: 'compact wins replacement', conversationId: CHAT_A });
    const continuation = await openContinuationNow(compactFirst.id, CHAT_A, false);
    expect((await getSession(compactFirst.id))?.replacementTransfer).toMatchObject({
      kind: 'continuation',
      transactionId: continuation.token,
      sourceConversationId: CHAT_A
    });
    expect(await beginSelfHealingEpisode(compactFirst.id, CHAT_A, 'silence')).toBeNull();
    expect((await getSession(compactFirst.id))?.recovery).toBeNull();

    const recoveryChat = '41414141-4141-4141-8141-414141414141';
    const recoveryFirst = await createSession({ title: 'recovery wins replacement', conversationId: recoveryChat });
    const episode = await beginSelfHealingEpisode(recoveryFirst.id, recoveryChat, 'provider-error');
    expect(episode).not.toBeNull();
    expect(await prepareEmergencyResume(recoveryFirst.id, recoveryChat, episode!.failureEpisodeId)).not.toBeNull();
    expect((await getSession(recoveryFirst.id))?.replacementTransfer).toMatchObject({
      kind: 'recovery',
      transactionId: episode!.failureEpisodeId,
      sourceConversationId: recoveryChat,
      recoveryGeneration: episode!.recoveryGeneration
    });
    await expect(openContinuationNow(recoveryFirst.id, recoveryChat, false))
      .rejects.toThrow('another provider-replacement transaction already owns this session');
  });

  it('serializes competing same-generation replacement destinations so exactly one wins', async () => {
    const chatC = '33333333-3333-4333-8333-333333333333';
    spawn({ workers: [{ task: 'winner witness' }], caller: { conversationId: PRIME_A } });
    const runId = currentRunId(PRIME_A)!;
    const session = await createSession({ title: 'competing replacement ACKs', conversationId: PRIME_A });
    await setGoalObjectiveNow(PRIME_A, 'Keep one exact replacement owner');
    await setGoalSwitchNow(PRIME_A, 'loop', true, true);
    const episode = await beginSelfHealingEpisode(session.id, PRIME_A, 'prime-unresponsive');
    expect(episode).not.toBeNull();
    await prepareEmergencyResume(session.id, PRIME_A, episode!.failureEpisodeId);
    const commandId = 'same-generation-race';
    expect((await beginEmergencyResumeDestinationSend(
      session.id, episode!.failureEpisodeId, episode!.recoveryGeneration, commandId
    ))?.allowed).toBe(true);
    expect(await dispatchEmergencyResumeDestinationSend(
      session.id, episode!.failureEpisodeId, episode!.recoveryGeneration, commandId
    )).toBe(true);

    const [bWon, cWon] = await Promise.all([
      bindEmergencyResumeDestination(
        session.id, episode!.failureEpisodeId, episode!.recoveryGeneration, commandId, PRIME_B, 'msg-b'
      ),
      bindEmergencyResumeDestination(
        session.id, episode!.failureEpisodeId, episode!.recoveryGeneration, commandId, chatC, 'msg-c'
      )
    ]);
    expect([bWon, cWon].filter(Boolean)).toHaveLength(1);
    const winner = bWon ? PRIME_B : chatC;
    const loser = bWon ? chatC : PRIME_B;

    expect(await commitEmergencyResume(session.id, episode!.failureEpisodeId, winner)).toEqual({
      status: 'committed',
      conversationId: winner
    });
    const after = await getSession(session.id);
    expect(after).toMatchObject({
      conversationId: winner,
      recovery: {
        replacementConversationId: winner,
        recoveryGeneration: episode!.recoveryGeneration,
        phase: 'recovered'
      }
    });
    expect(goalObjectiveFor(winner)).toBe('Keep one exact replacement owner');
    expect(goalSwitchFor(winner)).toMatchObject({ enabled: true, mode: 'loop', afterTurn: true });
    expect(primeConversation(runId)).toBe(winner);
    expect(agentInfoForOwnedConversation(winner)).toMatchObject({ id: 'prime', runId });
    expect(agentInfoForOwnedConversation(loser)).toBeNull();
    expect(await commitEmergencyResume(session.id, episode!.failureEpisodeId, loser)).toEqual({
      status: 'rejected',
      reason: 'replacement destination has not crossed the durable Send boundary'
    });
  });

  it('moves one durable session A→B and keeps the exact Goal/Loop state', async () => {
    const session = await createSession({ title: 'prime work', conversationId: CHAT_A });
    await setGoalObjectiveNow(CHAT_A, 'Finish the exact durable objective');
    await setGoalSwitchNow(CHAT_A, 'loop', true, true);
    const beforeSwitch = goalSwitchFor(CHAT_A);
    const episode = await beginSelfHealingEpisode(session.id, CHAT_A, 'provider-error');
    expect(episode?.phase).toBe('suspected_stall');
    expect((await markSoftRecovery(
      session.id,
      CHAT_A,
      episode!.failureEpisodeId,
      episode!.recoveryGeneration
    ))?.phase).toBe('soft_recovery');
    const prepared = await prepareEmergencyResume(session.id, CHAT_A, episode!.failureEpisodeId);
    expect(prepared?.text).toContain('Do not blindly repeat the interrupted turn.');
    expect(prepared?.text).toContain('Treat completed operations as completed.');
    expect(prepared?.text).toContain('Only redo an operation if durable evidence proves it did not occur.');
    expect(recoveryFenceActive(CHAT_A)).toBe(true);

    await proveRecoveryDestination(session.id, episode!.failureEpisodeId, CHAT_B);
    expect(await commitEmergencyResume(session.id, episode!.failureEpisodeId, CHAT_B)).toEqual({
      status: 'committed', conversationId: CHAT_B
    });
    expect(await getSession(session.id)).toMatchObject({
      conversationId: CHAT_B,
      recovery: {
        failureEpisodeId: episode!.failureEpisodeId,
        previousConversationId: CHAT_A,
        replacementConversationId: CHAT_B,
        phase: 'recovered'
      }
    });
    expect(goalObjectiveFor(CHAT_A)).toBe('');
    expect(goalObjectiveFor(CHAT_B)).toBe('Finish the exact durable objective');
    expect(goalSwitchFor(CHAT_B)).toMatchObject({
      enabled: beforeSwitch.enabled,
      mode: beforeSwitch.mode,
      afterTurn: beforeSwitch.afterTurn
    });
    expect(longRunStatus(session.id)).toMatchObject({
      epoch: { conversationId: CHAT_B },
      work: { conversationId: CHAT_B, reason: 'recovery_resume', state: 'owed' }
    });
    expect(recoveryFenceActive(CHAT_A)).toBe(false);
  });

  it('does not start an episode for a manually stopped turn', async () => {
    const session = await createSession({ title: 'stopped work', conversationId: CHAT_A });
    await appendEvent(session.id, { source: 'extension', kind: 'turn_start', turnId: 'manual-stop', time: 1 });
    await appendEvent(session.id, { source: 'extension', kind: 'turn_end', turnId: 'manual-stop', outcome: 'stopped', time: 2 });
    expect((await getSession(session.id))?.lastTurnOutcome).toBe('stopped');
    expect(await beginSelfHealingEpisode(session.id, CHAT_A, 'silence')).toBeNull();
  });

  it('does not commit a replacement after the user stops during hard recovery', async () => {
    const session = await createSession({ title: 'stop races recovery ACK', conversationId: CHAT_A });
    const episode = await beginSelfHealingEpisode(session.id, CHAT_A, 'silence');
    expect(episode).not.toBeNull();
    await prepareEmergencyResume(session.id, CHAT_A, episode!.failureEpisodeId);
    expect((await getSession(session.id))?.recovery?.phase).toBe('hard_recovery');
    await proveRecoveryDestination(session.id, episode!.failureEpisodeId, CHAT_B);

    await appendEvent(session.id, { source: 'extension', kind: 'turn_start', turnId: 'stop-before-rebind', time: 10 });
    await appendEvent(session.id, {
      source: 'extension', kind: 'turn_end', turnId: 'stop-before-rebind', outcome: 'stopped', time: 11
    });
    expect((await getSession(session.id))?.lastTurnOutcome).toBe('stopped');

    expect(await commitEmergencyResume(session.id, episode!.failureEpisodeId, CHAT_B)).toEqual({
      status: 'rejected',
      reason: 'session recovery compare-and-swap no longer owns this attachment'
    });
    expect((await getSession(session.id))?.conversationId).toBe(CHAT_A);
    expect((await getSession(session.id))?.recovery).toMatchObject({
      failureEpisodeId: episode!.failureEpisodeId,
      phase: 'hard_recovery',
      replacementConversationId: null
    });
  });

  it('repairs the crash window after the session rebind landed but projections did not', async () => {
    const session = await createSession({ title: 'crash recovery', conversationId: CHAT_A });
    await setGoalObjectiveNow(CHAT_A, 'Survive the crash window');
    await setGoalSwitchNow(CHAT_A, 'loop', true, true);
    const episode = await beginSelfHealingEpisode(session.id, CHAT_A, 'silence');
    await prepareEmergencyResume(session.id, CHAT_A, episode!.failureEpisodeId);
    const generation = (await getSession(session.id))!.recovery!.recoveryGeneration;
    const moved = await commitSelfHealingRebind(session.id, CHAT_A, CHAT_B, episode!.failureEpisodeId, generation);
    expect(moved?.phase).toBe('reconciling');
    expect(goalObjectiveFor(CHAT_A)).toBe('Survive the crash window');

    // Crash point B: session meta already says B, but Goal/Loop durable files still say A.
    const oldObjectives = await readDurable<any>(GOAL_OBJECTIVES_STATE);
    const oldSwitches = await readDurable<any>(GOAL_SWITCHES_STATE);
    expect(oldObjectives?.objectives?.some((row: any) => row.conversationId === CHAT_A)).toBe(true);
    expect(oldSwitches?.switches?.some((row: any) => row.conversationId === CHAT_A)).toBe(true);
    resetGoalStateForTests();
    restoreGoalObjectives(oldObjectives);
    restoreGoalSwitches(oldSwitches);
    resetSessionStoreForTests();
    initSessionStore(dir);
    resetRecoveryFences();
    expect(await reconcileSelfHealingAfterRestart()).toBe(1);
    expect(goalObjectiveFor(CHAT_A)).toBe('');
    expect(goalObjectiveFor(CHAT_B)).toBe('Survive the crash window');
    expect((await getSession(session.id))?.recovery?.phase).toBe('recovered');
    const durableObjectives = await readDurable<any>(GOAL_OBJECTIVES_STATE);
    const durableSwitches = await readDurable<any>(GOAL_SWITCHES_STATE);
    expect(durableObjectives?.objectives?.some((row: any) => row.conversationId === CHAT_A)).toBe(false);
    expect(durableObjectives?.objectives?.some((row: any) => row.conversationId === CHAT_B)).toBe(true);
    expect(durableSwitches?.switches?.some((row: any) => row.conversationId === CHAT_A)).toBe(false);
    expect(durableSwitches?.switches?.some((row: any) => row.conversationId === CHAT_B)).toBe(true);
  });

  it('reconstructs Emergency Resume after crash point A and gates replacement events before admission', async () => {
    const session = await createSession({ title: 'command wal crash', conversationId: CHAT_A });
    const episode = await beginSelfHealingEpisode(session.id, CHAT_A, 'silence');
    await prepareEmergencyResume(session.id, CHAT_A, episode!.failureEpisodeId);
    expect((await getSession(session.id))?.recovery?.phase).toBe('hard_recovery');
    expect(pendingCommands()).toEqual([]);

    // Crash point A: no bridge-command file/row exists. Startup must reconstruct from session WAL.
    resetBridgeForTests();
    resetResumeGate();
    await restoreCommands();
    expect(pendingCommands()).toEqual([
      expect.objectContaining({ what: `recovery:${session.id}` })
    ]);
    expect(recoveryFenceActive(CHAT_A)).toBe(true);
    expect(resumeOpeningChat()).toBe(true);

    // Crash point C: B can report /events before its ACK reaches the app. The restored gate makes
    // that batch wait for the authoritative A→B rebind instead of creating a shadow session.
    const earlyEvents = recordChatObservations(CHAT_B, [{
      kind: 'user_message',
      time: Date.now(),
      turnId: 'replacement-opening',
      messageId: 'replacement-bootstrap',
      text: `[[CLF-EMERGENCY-RESUME:${episode!.failureEpisodeId}]]`,
      authoredNow: true
    }]);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    await proveRecoveryDestination(session.id, episode!.failureEpisodeId, CHAT_B);
    expect((await commitEmergencyResume(session.id, episode!.failureEpisodeId, CHAT_B)).status).toBe('committed');
    endResumeClaim(episode!.failureEpisodeId);
    const recorded = await earlyEvents;
    expect(recorded.sessionId).toBe(session.id);
    expect(await sessionForConversation(CHAT_B)).toBe(session.id);
    expect((await getSession(session.id))?.conversationId).toBe(CHAT_B);
  });

  it('advances generation after genuine progress and rejects stale callbacks from the prior episode', async () => {
    const session = await createSession({ title: 'episode generations', conversationId: CHAT_A });
    const t1 = Date.now();
    await appendEvent(session.id, { source: 'extension', kind: 'turn_start', turnId: 'read-turn', time: t1 });
    await appendEvent(session.id, {
      source: 'mcp', kind: 'tool_call', turnId: 'read-turn', time: t1 + 1,
      call: { ...(callEvent('read') as Extract<SessionEvent, { kind: 'tool_call' }>).call, callId: 'read-one' }
    });
    const first = await beginSelfHealingEpisode(session.id, CHAT_A, 'silence', t1 + 1);
    expect(first?.mutationSafety).toBe('read_only_safe_retry');
    await markSoftRecovery(session.id, CHAT_A, first!.failureEpisodeId, first!.recoveryGeneration);

    const t2 = t1 + 10_000;
    await appendEvent(session.id, { source: 'extension', kind: 'turn_start', turnId: 'mutating-turn', time: t2 });
    await appendEvent(session.id, {
      source: 'mcp', kind: 'tool_call', turnId: 'mutating-turn', time: t2 + 1,
      call: { ...(callEvent('exec_command') as Extract<SessionEvent, { kind: 'tool_call' }>).call, callId: 'write-one', tool: 'exec_command' }
    });
    expect(await noteSelfHealingProgress(session.id, CHAT_A, t2 + 1)).toBe(true);
    expect((await getSession(session.id))?.recovery?.phase).toBe('healthy');

    const second = await beginSelfHealingEpisode(session.id, CHAT_A, 'silence', t2 + 1);
    expect(second?.recoveryGeneration).toBe(first!.recoveryGeneration + 1);
    expect(second?.failureEpisodeId).not.toBe(first!.failureEpisodeId);
    expect(second?.mutationSafety).toBe('mutating_or_ambiguous');
    expect(await markSoftRecovery(
      session.id,
      CHAT_A,
      first!.failureEpisodeId,
      first!.recoveryGeneration
    )).toBeNull();
    expect((await getSession(session.id))?.recovery?.failureEpisodeId).toBe(second?.failureEpisodeId);
  });

  it('rejects same-episode stale soft/failure callbacks after hard recovery owns the phase', async () => {
    const session = await createSession({ title: 'same-episode CAS', conversationId: CHAT_A });
    const episode = await beginSelfHealingEpisode(session.id, CHAT_A, 'silence');
    expect((await markSoftRecovery(
      session.id,
      CHAT_A,
      episode!.failureEpisodeId,
      episode!.recoveryGeneration
    ))?.phase).toBe('soft_recovery');
    expect((await prepareEmergencyResume(session.id, CHAT_A, episode!.failureEpisodeId))?.state.phase).toBe('hard_recovery');

    // A late browser reload receipt captured authority while the episode was soft. It must not
    // reread the newer phase and demote the durable hard-recovery command back to soft.
    expect(await markSoftRecovery(
      session.id,
      CHAT_A,
      episode!.failureEpisodeId,
      episode!.recoveryGeneration
    )).toBeNull();
    // Likewise an older terminal callback only owns its captured source phase.
    expect(await failSelfHealingRecovery(
      session.id,
      CHAT_A,
      episode!.failureEpisodeId,
      episode!.recoveryGeneration,
      'soft_recovery',
      'stale callback'
    )).toBe(false);
    expect((await getSession(session.id))?.recovery).toMatchObject({
      failureEpisodeId: episode!.failureEpisodeId,
      recoveryGeneration: episode!.recoveryGeneration,
      phase: 'hard_recovery'
    });
    expect(recoveryFenceActive(CHAT_A)).toBe(true);
  });

  it('keeps another recovery owner fenced when a stale concurrent owner releases only itself', async () => {
    const winner = 'durable:winner:1';
    const loser = 'prepare:loser';
    armRecoveryFence(CHAT_A, winner);
    armRecoveryFence(CHAT_A, loser);
    disarmRecoveryFence(CHAT_A, loser);
    expect(recoveryFenceOwnerActive(CHAT_A, loser)).toBe(false);
    expect(recoveryFenceOwnerActive(CHAT_A, winner)).toBe(true);
    expect(recoveryFenceActive(CHAT_A)).toBe(true);
  });

  it('does not transiently erase an already-restored recovery fence on a second startup reconciliation pass', async () => {
    const session = await createSession({ title: 'startup fence monotonicity', conversationId: CHAT_A });
    const episode = await beginSelfHealingEpisode(session.id, CHAT_A, 'silence');
    await prepareEmergencyResume(session.id, CHAT_A, episode!.failureEpisodeId);
    const liveOwner = 'startup:mcp-admission-barrier';
    armRecoveryFence(CHAT_A, liveOwner);
    expect(recoveryFenceOwnerActive(CHAT_A, liveOwner)).toBe(true);

    // index.ts performs this once before MCP connect; bridge restore performs it again. The
    // second pass must be monotonic rather than reset/re-arm, otherwise MCP sees a brief hole.
    await reconcileSelfHealingAfterRestart();
    expect(recoveryFenceOwnerActive(CHAT_A, liveOwner)).toBe(true);
    expect(recoveryFenceActive(CHAT_A)).toBe(true);
  });

  it('restores a hard-recovery fence even when its session is beyond the 5,000-session compatibility scan cap', async () => {
    const session = await createSession({ title: 'deep recovery owner', conversationId: CHAT_A });
    const episode = await beginSelfHealingEpisode(session.id, CHAT_A, 'silence');
    await prepareEmergencyResume(session.id, CHAT_A, episode!.failureEpisodeId);
    resetSessionStoreForTests();
    initSessionStore(dir);
    resetRecoveryFences();

    const rootPath = path.join(dir, 'sessions');
    const names = [
      ...Array.from({ length: 5_000 }, (_, index) => `recover-${String(index).padStart(5, '0')}`),
      session.id
    ];
    const realReaddir = fs.readdir.bind(fs);
    const realReadFile = fs.readFile.bind(fs);
    const durableTarget = JSON.parse(
      await realReadFile(path.join(rootPath, session.id, 'meta.json'), 'utf8')
    ) as Record<string, unknown>;
    const readdirSpy = vi.spyOn(fs, 'readdir').mockImplementation(
      (async (target: Parameters<typeof fs.readdir>[0], ...args: unknown[]) => {
        if (String(target) === rootPath) return names;
        return (realReaddir as (...callArgs: unknown[]) => ReturnType<typeof fs.readdir>)(target, ...args);
      }) as typeof fs.readdir
    );
    const readSpy = vi.spyOn(fs, 'readFile').mockImplementation(
      (async (target: Parameters<typeof fs.readFile>[0], ...args: unknown[]) => {
        const file = String(target);
        const id = path.basename(path.dirname(file));
        if (file.endsWith('meta.json') && id.startsWith('recover-')) {
          return JSON.stringify({
            ...durableTarget,
            id,
            title: id,
            conversationId: null,
            chatIds: [],
            recovery: null
          });
        }
        return (realReadFile as (...callArgs: unknown[]) => ReturnType<typeof fs.readFile>)(target, ...args);
      }) as typeof fs.readFile
    );
    try {
      expect(await reconcileSelfHealingAfterRestart()).toBe(0);
      expect(recoveryFenceActive(CHAT_A)).toBe(true);
    } finally {
      readSpy.mockRestore();
      readdirSpy.mockRestore();
    }
  }, 90_000);

  it('recomputes mutation safety after a settled mutation before hard recovery is queued', async () => {
    const session = await createSession({ title: 'lost mutation result', conversationId: CHAT_A });
    const t1 = Date.now();
    await appendEvent(session.id, { source: 'extension', kind: 'turn_start', turnId: 'ambiguous-turn', time: t1 });
    await appendEvent(session.id, {
      source: 'mcp', kind: 'tool_call', turnId: 'ambiguous-turn', time: t1 + 1,
      call: { ...(callEvent('read') as Extract<SessionEvent, { kind: 'tool_call' }>).call, callId: 'earlier-read' }
    });
    const episode = await beginSelfHealingEpisode(session.id, CHAT_A, 'tunnel-interrupted', t1 + 1);
    expect(episode?.mutationSafety).toBe('read_only_safe_retry');

    // The mutation succeeded but its response/record was lost in transit. Model the record
    // landing before Emergency Resume is allowed to cross the hard-recovery boundary.
    await appendEvent(session.id, {
      source: 'mcp', kind: 'tool_call', turnId: 'ambiguous-turn', time: t1 + 2,
      call: { ...(callEvent('exec_command') as Extract<SessionEvent, { kind: 'tool_call' }>).call,
        callId: 'mutation-that-may-have-succeeded', tool: 'exec_command' }
    });
    const prepared = await prepareEmergencyResume(session.id, CHAT_A, episode!.failureEpisodeId);
    expect(prepared).not.toBeNull();
    expect((await getSession(session.id))?.recovery).toMatchObject({
      phase: 'hard_recovery',
      mutationSafety: 'mutating_or_ambiguous'
    });
  });

  it('does not create or classify a recovery episode while a mutating MCP receipt is still settling', async () => {
    const session = await createSession({ title: 'settling mutation admission', conversationId: CHAT_A });
    const context: CallContext = {
      startedAt: Date.now(),
      transportKey: null,
      agent: null,
      caller: { transportKey: null, requestId: 'lost-mutation-response', conversationId: CHAT_A },
      outcome: null,
      evidence: emptyEvidence()
    };
    let release!: () => void;
    const landing = new Promise<void>((resolve) => { release = resolve; });
    holdWhileSettling(context, landing);
    expect(settlingToolCalls(CHAT_A)).toBe(1);

    const blocked = await startEmergencyRecoveryForSpentForTests([CHAT_A], Date.now());
    expect(blocked).toEqual({ recovering: [CHAT_A], fallback: [] });
    expect((await getSession(session.id))?.recovery).toBeNull();
    expect(pendingCommands().some((entry) => entry.what === `recovery:${session.id}`)).toBe(false);

    // The mutation's durable attribution arrives before the next recovery pass is admitted.
    const now = Date.now();
    await appendEvent(session.id, { source: 'extension', kind: 'turn_start', turnId: 'lost-mutation-turn', time: now });
    await appendEvent(session.id, {
      source: 'mcp', kind: 'tool_call', turnId: 'lost-mutation-turn', time: now + 1,
      call: { ...(callEvent('exec_command') as Extract<SessionEvent, { kind: 'tool_call' }>).call,
        callId: 'settled-mutation', tool: 'exec_command', conversationId: CHAT_A }
    });
    release();
    await landing;
    await Promise.resolve();
    expect(settlingToolCalls(CHAT_A)).toBe(0);

    setBrowserOpener(async () => undefined);
    const admitted = await startEmergencyRecoveryForSpentForTests([CHAT_A], now + 2);
    expect(admitted.recovering).toContain(CHAT_A);
    expect((await getSession(session.id))?.recovery).toMatchObject({
      phase: 'hard_recovery',
      mutationSafety: 'mutating_or_ambiguous'
    });
  });

  it('fences a late old-chat observation after B has become the current executor', async () => {
    const session = await createSession({ title: 'stale A', conversationId: CHAT_A });
    const episode = await beginSelfHealingEpisode(session.id, CHAT_A, 'provider-error');
    await prepareEmergencyResume(session.id, CHAT_A, episode!.failureEpisodeId);
    await proveRecoveryDestination(session.id, episode!.failureEpisodeId, CHAT_B);
    expect((await commitEmergencyResume(session.id, episode!.failureEpisodeId, CHAT_B)).status).toBe('committed');

    await recordChatObservations(CHAT_A, [{
      kind: 'assistant_message',
      time: Date.now(),
      turnId: 'late-old-turn',
      messageId: 'late-old-final',
      text: 'This is a stale completion from the superseded executor.',
      state: 'final',
      final: true
    }]);
    expect(await sessionForConversation(CHAT_A)).toBeNull();
    expect((await getSession(session.id))?.conversationId).toBe(CHAT_B);
    expect((await getSession(session.id))?.chatIds).toEqual(expect.arrayContaining([CHAT_A, CHAT_B]));
  });
});

describe('agent identity transfer', () => {
  it('does not let old Prime A reclaim ownership when its late final races B recovery commit', async () => {
    spawn({ workers: [{ task: 'race witness' }], caller: { conversationId: PRIME_A } });
    const runId = currentRunId(PRIME_A)!;
    const session = await createSession({ title: 'prime ACK race', conversationId: PRIME_A });
    const episode = await beginSelfHealingEpisode(session.id, PRIME_A, 'prime-unresponsive');
    await prepareEmergencyResume(session.id, PRIME_A, episode!.failureEpisodeId);
    await proveRecoveryDestination(session.id, episode!.failureEpisodeId, PRIME_B);

    let entered!: () => void;
    const atBarrier = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    onSwarmPersistNow(async () => {
      entered();
      await hold;
    });

    const commit = commitEmergencyResume(session.id, episode!.failureEpisodeId, PRIME_B);
    await atBarrier;
    expect((await getSession(session.id))?.conversationId).toBe(PRIME_B);
    expect((await getSession(session.id))?.recovery?.phase).toBe('reconciling');

    const lateA = recordChatObservations(PRIME_A, [{
      kind: 'assistant_message', time: Date.now(), turnId: 'late-prime-a', messageId: 'late-prime-a-final',
      text: 'old A finally answered while B was committing', state: 'final', final: true
    }]);
    await lateA;
    release();
    expect(await commit).toEqual({ status: 'committed', conversationId: PRIME_B });

    expect(await sessionForConversation(PRIME_A)).toBeNull();
    expect((await getSession(session.id))?.conversationId).toBe(PRIME_B);
    expect((await getSession(session.id))?.recovery).toMatchObject({
      previousConversationId: PRIME_A,
      replacementConversationId: PRIME_B,
      phase: 'recovered'
    });
    expect(agentInfoForOwnedConversation(PRIME_A)).toBeNull();
    expect(agentInfoForOwnedConversation(PRIME_B)).toMatchObject({ id: 'prime', runId });
    expect(primeConversation(runId)).toBe(PRIME_B);
  });

  it('repairs Goal Loop and Prime/worker swarm before marking restart recovery recovered', async () => {
    spawn({ workers: [{ task: 'restart witness' }], caller: { conversationId: PRIME_A } });
    const runId = currentRunId(PRIME_A)!;
    sendMessage({ conversationId: PRIME_A }, 'worker-1', 'durable worker inbox survives Prime recovery');
    const swarmBefore = snapshotSwarm()!;
    const session = await createSession({ title: 'prime restart recovery', conversationId: PRIME_A });
    await setGoalObjectiveNow(PRIME_A, 'Prime restart objective');
    await setGoalSwitchNow(PRIME_A, 'loop', true, true);
    const episode = await beginSelfHealingEpisode(session.id, PRIME_A, 'prime-unresponsive');
    await prepareEmergencyResume(session.id, PRIME_A, episode!.failureEpisodeId);
    const generation = (await getSession(session.id))!.recovery!.recoveryGeneration;
    expect((await commitSelfHealingRebind(
      session.id, PRIME_A, PRIME_B, episode!.failureEpisodeId, generation
    ))?.phase).toBe('reconciling');

    const oldObjectives = await readDurable<any>(GOAL_OBJECTIVES_STATE);
    const oldSwitches = await readDurable<any>(GOAL_SWITCHES_STATE);
    resetAgentsForTests();
    restoreSwarm(swarmBefore);
    resetGoalStateForTests();
    restoreGoalObjectives(oldObjectives);
    restoreGoalSwitches(oldSwitches);
    resetSessionStoreForTests();
    initSessionStore(dir);
    resetRecoveryFences();

    onSwarmPersistNow(async () => { throw new Error('simulated swarm fsync loss'); });
    expect(await reconcileSelfHealingAfterRestart()).toBe(0);
    expect((await getSession(session.id))?.recovery?.phase).toBe('reconciling');
    // The projection may already be B in memory, but both A and B remain recovery-fenced and the
    // WAL remains RECONCILING until this exact broker generation crosses its fsync barrier.
    expect(primeConversation(runId)).toBe(PRIME_B);

    onSwarmPersistNow(async (snapshot) => writeDurableNow('self-healing-prime-swarm', snapshot));
    expect(await reconcileSelfHealingAfterRestart()).toBe(1);
    expect((await getSession(session.id))?.recovery?.phase).toBe('recovered');
    expect(primeConversation(runId)).toBe(PRIME_B);
    expect(goalObjectiveFor(PRIME_B)).toBe('Prime restart objective');
    expect(goalSwitchFor(PRIME_B)).toMatchObject({ enabled: true, mode: 'loop', afterTurn: true });
    const durable = await readDurable<any>('self-healing-prime-swarm');
    const durableRun = durable?.activeRuns?.find((row: any) => row.runId === runId);
    expect(durableRun?.primeConversationId).toBe(PRIME_B);
    expect(durableRun?.agents?.find((row: any) => row.info.id === 'prime')?.info.conversationId).toBe(PRIME_B);
    expect(durableRun?.agents?.find((row: any) => row.info.id === 'worker-1')?.queue
      ?.some((message: any) => message.text === 'durable worker inbox survives Prime recovery')).toBe(true);
  });

  it('keeps agent recovery reconciling when restart cannot recover its swarm owner', async () => {
    spawn({ workers: [{ task: 'owner may disappear on restart' }], caller: { conversationId: PRIME_A } });
    const runId = currentRunId(PRIME_A)!;
    expect(bindConversation('worker-1', WORKER_A, runId)).toBe(true);
    const session = await createSession({ title: 'missing worker owner', conversationId: WORKER_A });
    const episode = await beginSelfHealingEpisode(session.id, WORKER_A, 'worker-unresponsive');
    await prepareEmergencyResume(session.id, WORKER_A, episode!.failureEpisodeId);
    const generation = (await getSession(session.id))!.recovery!.recoveryGeneration;
    expect((await commitSelfHealingRebind(
      session.id, WORKER_A, WORKER_B, episode!.failureEpisodeId, generation
    ))?.phase).toBe('reconciling');

    // The session/WAL survived but the exact swarm owner did not. Recovery must fail closed rather
    // than interpreting the unattached B chat as an ordinary worker or a completed recovery.
    resetAgentsForTests();
    resetSessionStoreForTests();
    initSessionStore(dir);
    resetRecoveryFences();
    expect(await reconcileSelfHealingAfterRestart()).toBe(0);
    expect((await getSession(session.id))?.recovery).toMatchObject({
      phase: 'reconciling',
      agentLineage: { role: 'worker', agentId: 'worker-1', runId }
    });
    expect(recoveryFenceActive(WORKER_A)).toBe(true);
    expect(recoveryFenceActive(WORKER_B)).toBe(true);
    expect(agentInfoForOwnedConversation(WORKER_B)).toBeNull();
  });

  it('does not accept a foreign B agent as recovered owner when A ownership is missing', async () => {
    spawn({ workers: [{ task: 'original lineage' }], caller: { conversationId: PRIME_A } });
    const originalRun = currentRunId(PRIME_A)!;
    const session = await createSession({ title: 'foreign replacement owner', conversationId: PRIME_A });
    const episode = await beginSelfHealingEpisode(session.id, PRIME_A, 'prime-unresponsive');
    await prepareEmergencyResume(session.id, PRIME_A, episode!.failureEpisodeId);
    const generation = (await getSession(session.id))!.recovery!.recoveryGeneration;
    expect((await commitSelfHealingRebind(
      session.id, PRIME_A, PRIME_B, episode!.failureEpisodeId, generation
    ))?.phase).toBe('reconciling');

    resetAgentsForTests();
    const foreign = spawn({ workers: [{ task: 'unrelated family' }], caller: { conversationId: PRIME_B } });
    expect(foreign.runId).not.toBe(originalRun);
    resetSessionStoreForTests();
    initSessionStore(dir);
    resetRecoveryFences();

    expect(await reconcileSelfHealingAfterRestart()).toBe(0);
    expect((await getSession(session.id))?.recovery).toMatchObject({
      phase: 'reconciling',
      agentLineage: { role: 'prime', agentId: 'prime', runId: originalRun, primeConversationId: PRIME_A }
    });
    expect(agentInfoForOwnedConversation(PRIME_B)).toMatchObject({ id: 'prime', runId: foreign.runId });
    expect(recoveryFenceActive(PRIME_A)).toBe(true);
    expect(recoveryFenceActive(PRIME_B)).toBe(true);
  });

  it('leaves recovery reconciling and continues restart when Goal projection persistence fails', async () => {
    const a1 = '11111111-aaaa-4aaa-8aaa-111111111111';
    const b1 = '22222222-bbbb-4bbb-8bbb-222222222222';
    const a2 = '33333333-cccc-4ccc-8ccc-333333333333';
    const b2 = '44444444-dddd-4ddd-8ddd-444444444444';
    const first = await createSession({ title: 'retryable Goal projection', conversationId: a1 });
    const second = await createSession({ title: 'independent restart recovery', conversationId: a2 });
    await setGoalObjectiveNow(a1, 'objective must retry');
    await setGoalSwitchNow(a1, 'loop', true, true);
    const replySnapshot = {
      version: 1 as const,
      savedAt: Date.now(),
      replies: [{
        conversationId: a1, sessionId: first.id, replyId: 'durable-goal-debt', turnId: 'source-turn',
        eventSeq: 17, acceptedAt: Date.now(), state: 'pending' as const
      }]
    };
    restoreGoalReplies(replySnapshot);
    await writeDurableNow(GOAL_REPLIES_STATE, replySnapshot);
    await setGoalObjectiveNow(a2, 'other session still recovers');

    for (const [session, from, to] of [[first, a1, b1], [second, a2, b2]] as const) {
      const episode = await beginSelfHealingEpisode(session.id, from, 'provider-error');
      await prepareEmergencyResume(session.id, from, episode!.failureEpisodeId);
      const generation = (await getSession(session.id))!.recovery!.recoveryGeneration;
      expect((await commitSelfHealingRebind(session.id, from, to, episode!.failureEpisodeId, generation))?.phase)
        .toBe('reconciling');
    }

    resetSessionStoreForTests();
    initSessionStore(dir);
    resetRecoveryFences();
    const realWriteFile = fs.writeFile.bind(fs);
    let failed = false;
    const writeSpy = vi.spyOn(fs, 'writeFile').mockImplementation((async (target: Parameters<typeof fs.writeFile>[0], data: any, ...args: any[]) => {
      if (!failed && String(target).endsWith('goal-objectives.json.tmp') && String(data).includes(b1)) {
        failed = true;
        throw new Error('simulated Goal objective fsync failure');
      }
      return (realWriteFile as any)(target, data, ...args);
    }) as typeof fs.writeFile);
    try {
      expect(await reconcileSelfHealingAfterRestart()).toBe(1);
    } finally {
      writeSpy.mockRestore();
    }
    expect((await getSession(first.id))?.recovery).toMatchObject({ phase: 'reconciling' });
    expect((await getSession(second.id))?.recovery).toMatchObject({ phase: 'recovered' });
    expect(goalObjectiveFor(b2)).toBe('other session still recovers');

    expect(await reconcileSelfHealingAfterRestart()).toBeGreaterThanOrEqual(1);
    expect((await getSession(first.id))?.recovery).toMatchObject({ phase: 'recovered', error: null });
    expect(goalObjectiveFor(b1)).toBe('objective must retry');
    expect(goalSwitchFor(b1)).toMatchObject({ enabled: true, mode: 'loop', afterTurn: true });
    expect(goalPendingReplyFor(a1)).toBeNull();
    expect(goalPendingReplyFor(b1)).toMatchObject({ replyId: 'durable-goal-debt', turnId: 'source-turn', eventSeq: 17 });
    const durableReplies = await readDurable<any>(GOAL_REPLIES_STATE);
    expect(durableReplies?.replies).toEqual(expect.arrayContaining([
      expect.objectContaining({ conversationId: b1, sessionId: first.id, replyId: 'durable-goal-debt', state: 'pending' })
    ]));
  });

  it('keeps a reconciling worker unrecovered until its id/task/inbox projection is durable after restart', async () => {
    spawn({ workers: [{ label: 'Restart worker', task: 'Preserve restart task' }], caller: { conversationId: PRIME_A } });
    const runId = currentRunId(PRIME_A)!;
    expect(bindConversation('worker-1', WORKER_A, runId)).toBe(true);
    sendMessage({ conversationId: PRIME_A }, 'worker-1', 'restart inbox survives');
    const swarmBefore = snapshotSwarm()!;
    const session = await createSession({ title: 'worker restart recovery', conversationId: WORKER_A });
    const episode = await beginSelfHealingEpisode(session.id, WORKER_A, 'worker-unresponsive');
    await prepareEmergencyResume(session.id, WORKER_A, episode!.failureEpisodeId);
    await proveRecoveryDestination(session.id, episode!.failureEpisodeId, WORKER_B);
    const generation = (await getSession(session.id))!.recovery!.recoveryGeneration;
    expect((await commitSelfHealingRebind(
      session.id, WORKER_A, WORKER_B, episode!.failureEpisodeId, generation
    ))?.phase).toBe('reconciling');

    resetAgentsForTests();
    restoreSwarm(swarmBefore);
    resetSessionStoreForTests();
    initSessionStore(dir);
    resetRecoveryFences();
    onSwarmPersistNow(async () => { throw new Error('simulated worker fsync loss'); });
    expect(await reconcileSelfHealingAfterRestart()).toBe(0);
    expect((await getSession(session.id))?.recovery?.phase).toBe('reconciling');
    expect(agentInfoForOwnedConversation(WORKER_B)).toMatchObject({ id: 'worker-1', runId });
    expect(primeConversation(runId)).toBe(PRIME_A);

    onSwarmPersistNow(async (snapshot) => writeDurableNow('self-healing-worker-swarm', snapshot));
    expect(await reconcileSelfHealingAfterRestart()).toBe(1);
    expect((await getSession(session.id))?.recovery?.phase).toBe('recovered');
    const durable = await readDurable<any>('self-healing-worker-swarm');
    const worker = durable?.activeRuns?.find((row: any) => row.runId === runId)?.agents
      ?.find((row: any) => row.info.id === 'worker-1');
    expect(worker?.info).toMatchObject({
      id: 'worker-1', label: 'Restart worker', task: 'Preserve restart task', conversationId: WORKER_B, runId
    });
    expect(worker?.queue.some((message: any) => message.text === 'restart inbox survives')).toBe(true);
  });

  it('lets Prime keep progressing while a worker replacement waits on its durable swarm barrier', async () => {
    spawn({ workers: [{ label: 'Concurrent worker', task: 'Stay advisory' }], caller: { conversationId: PRIME_A } });
    const runId = currentRunId(PRIME_A)!;
    expect(bindConversation('worker-1', WORKER_A, runId)).toBe(true);
    sendMessage({ conversationId: PRIME_A }, 'worker-1', 'before replacement');
    const session = await createSession({ title: 'concurrent worker recovery', conversationId: WORKER_A });
    const episode = await beginSelfHealingEpisode(session.id, WORKER_A, 'worker-unresponsive');
    await prepareEmergencyResume(session.id, WORKER_A, episode!.failureEpisodeId);
    await proveRecoveryDestination(session.id, episode!.failureEpisodeId, WORKER_B);

    let entered!: () => void;
    const atBarrier = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    let first = true;
    onSwarmPersistNow(async (snapshot) => {
      if (first) {
        first = false;
        entered();
        await hold;
      }
      await writeDurableNow('self-healing-concurrent-worker-swarm', snapshot);
    });

    const committing = commitEmergencyResume(session.id, episode!.failureEpisodeId, WORKER_B);
    await atBarrier;
    expect(primeConversation(runId)).toBe(PRIME_A);
    sendMessage({ conversationId: PRIME_A }, 'worker-1', 'prime progressed during worker recovery');
    expect(swarmState(runId).agents.find((agent) => agent.id === 'prime')?.conversationId).toBe(PRIME_A);

    // Old worker A can finish while B's durable ACK is still being persisted. It may add prose
    // to history, but cannot reclaim worker/session ownership or start a worker Goal loop.
    await recordChatObservations(WORKER_A, [{
      kind: 'assistant_message', time: Date.now(), turnId: 'late-worker-a', messageId: 'late-worker-a-final',
      text: 'late worker result', state: 'final', final: true
    }]);
    release();
    expect(await committing).toEqual({ status: 'committed', conversationId: WORKER_B });

    const worker = swarmState(runId).agents.find((agent) => agent.id === 'worker-1')!;
    expect(worker).toMatchObject({
      id: 'worker-1', label: 'Concurrent worker', task: 'Stay advisory', conversationId: WORKER_B,
      primeConversationId: PRIME_A, runId, state: 'active'
    });
    const persistedWorker = snapshotSwarm()!.agents.find((entry) => entry.info.id === 'worker-1')!;
    expect(persistedWorker.queue.some((message) => message.text === 'prime progressed during worker recovery')).toBe(true);
    expect(agentInfoForOwnedConversation(WORKER_A)).toBeNull();
    expect(agentInfoForOwnedConversation(WORKER_B)?.id).toBe('worker-1');
    expect(goalSwitchFor(WORKER_B).enabled).toBe(false);
  });
  it('moves Prime recovery without changing its durable run or Goal', async () => {
    const session = await createSession({ title: 'prime recovery', conversationId: PRIME_A });
    spawn({ workers: [{ task: 'advisory work' }], caller: { conversationId: PRIME_A } });
    const runId = currentRunId(PRIME_A)!;
    await setGoalObjectiveNow(PRIME_A, 'Prime objective remains exact');
    const episode = await beginSelfHealingEpisode(session.id, PRIME_A, 'prime-unresponsive');
    await prepareEmergencyResume(session.id, PRIME_A, episode!.failureEpisodeId);
    await proveRecoveryDestination(session.id, episode!.failureEpisodeId, PRIME_B);

    expect((await commitEmergencyResume(session.id, episode!.failureEpisodeId, PRIME_B)).status).toBe('committed');
    expect(primeConversation(runId)).toBe(PRIME_B);
    expect(currentRunId(PRIME_B)).toBe(runId);
    expect(agentInfoForOwnedConversation(PRIME_A)).toBeNull();
    expect(agentInfoForOwnedConversation(PRIME_B)).toMatchObject({ id: 'prime', role: 'prime', runId });
    expect(goalObjectiveFor(PRIME_B)).toBe('Prime objective remains exact');
  });

  it('moves one worker executor while preserving its id, task, inbox and Prime owner', async () => {
    const primeSession = await createSession({ title: 'prime', conversationId: PRIME_A });
    expect(primeSession.conversationId).toBe(PRIME_A);
    spawn({ workers: [{ label: 'Durable auditor', task: 'Audit the same durable task' }], caller: { conversationId: PRIME_A } });
    const runId = currentRunId(PRIME_A)!;
    expect(bindConversation('worker-1', WORKER_A, runId)).toBe(true);
    sendMessage({ conversationId: PRIME_A }, 'worker-1', 'queued correction survives replacement');
    const workerSession = await createSession({ title: 'worker', conversationId: WORKER_A });
    const before = swarmState(runId).agents.find((agent) => agent.id === 'worker-1')!;
    const episode = await beginSelfHealingEpisode(workerSession.id, WORKER_A, 'worker-unresponsive');
    await prepareEmergencyResume(workerSession.id, WORKER_A, episode!.failureEpisodeId);
    await proveRecoveryDestination(workerSession.id, episode!.failureEpisodeId, WORKER_B);

    expect((await commitEmergencyResume(workerSession.id, episode!.failureEpisodeId, WORKER_B)).status).toBe('committed');
    const after = swarmState(runId).agents.find((agent) => agent.id === 'worker-1')!;
    expect(after).toMatchObject({
      id: before.id,
      label: before.label,
      task: before.task,
      runId,
      primeConversationId: before.primeConversationId,
      conversationId: WORKER_B,
      pending: before.pending,
      state: 'active'
    });
    const persistedWorker = snapshotSwarm()!.agents.find((entry) => entry.info.id === 'worker-1')!;
    expect(persistedWorker.queue.some((message) => message.text === 'queued correction survives replacement')).toBe(true);
    expect(agentInfoForOwnedConversation(WORKER_A)).toBeNull();
    expect(agentInfoForOwnedConversation(WORKER_B)?.id).toBe('worker-1');
    expect(primeConversation(runId)).toBe(PRIME_A);
  });

  it('keeps normal worker binding immutable outside the recovery-only transfer', () => {
    spawn({ workers: [{ task: 'ordinary worker' }], caller: { conversationId: PRIME_A } });
    const runId = currentRunId(PRIME_A)!;
    expect(bindConversation('worker-1', WORKER_A, runId)).toBe(true);
    expect(bindConversation('worker-1', WORKER_B, runId)).toBe(false);
    expect(repairWorkerConversationAfterRecovery('worker-1', runId, WORKER_A, WORKER_B)).toBe(true);
  });

  it('refuses to move a recovering worker onto its own Prime conversation', () => {
    spawn({ workers: [{ task: 'collision worker' }], caller: { conversationId: PRIME_A } });
    const runId = currentRunId(PRIME_A)!;
    expect(bindConversation('worker-1', WORKER_A, runId)).toBe(true);
    expect(repairWorkerConversationAfterRecovery('worker-1', runId, WORKER_A, PRIME_A)).toBe(false);
    expect(agentInfoForOwnedConversation(WORKER_A)?.id).toBe('worker-1');
    expect(agentInfoForOwnedConversation(PRIME_A)?.id).toBe('prime');
  });
});
