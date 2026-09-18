import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initDurableStore, readDurable, resetDurableForTests } from '../src/main/durable.js';
import {
  anyLongRunWaitActive,
  armLongRunWaitNow,
  cancelLongRunNow,
  captureExecutionTicket,
  deferLongRunWaitNow,
  ensureRecoveryWorkNow,
  executionEpochFor,
  executionTicketCurrent,
  leaseLongRunWorkNow,
  longRunStatus,
  longRunWaitBlocksTools,
  markLongRunWorkQueuedNow,
  moveLongRunStateNow,
  noteLongRunProgressNow,
  resetLongRunStateForTests,
  resolveLongRunWaitNow,
  restoreLongRunState,
  snapshotLongRunState
} from '../src/main/session/long-run.js';

let directory: string;
const SESSION = 'session-one';
const CHAT_A = 'conversation-a';
const CHAT_B = 'conversation-b';

beforeEach(async () => {
  resetLongRunStateForTests();
  resetDurableForTests();
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clf-long-run-'));
  initDurableStore(directory);
});

afterEach(async () => {
  resetLongRunStateForTests();
  resetDurableForTests();
  await fs.rm(directory, { recursive: true, force: true });
});

describe('durable long-run authority', () => {
  it('uses an armed wait as exact execution authority until it is cancelled', async () => {
    const wait = await armLongRunWaitNow({
      sessionId: SESSION,
      conversationId: CHAT_A,
      sourceTurnId: 'turn-admission-source',
      kind: 'timer',
      dueAt: Date.now() + 60_000
    });

    expect(wait.state).toBe('waiting');
    expect(anyLongRunWaitActive()).toBe(true);
    expect(longRunWaitBlocksTools(SESSION, CHAT_A)).toBe(true);
    expect(longRunWaitBlocksTools(SESSION, CHAT_B)).toBe(false);

    expect(await cancelLongRunNow(SESSION, CHAT_A, 'test_cancel')).toBe(true);
    expect(anyLongRunWaitActive()).toBe(false);
    expect(longRunWaitBlocksTools(SESSION, CHAT_A)).toBe(false);
  });

  it('uses the exact source request id after resolution even when recorder turn state is already closed', async () => {
    const sourceRequestId = 'wfr-wait-source-request';
    const wait = await armLongRunWaitNow({
      sessionId: SESSION,
      conversationId: CHAT_A,
      sourceTurnId: 'turn-request-source',
      sourceRequestId,
      kind: 'timer',
      dueAt: Date.now() + 1_000
    });
    const ticket = captureExecutionTicket(SESSION, CHAT_A)!;
    expect(await resolveLongRunWaitNow(SESSION, wait.id, ticket, 'timer resolved')).toBe(true);

    // Recorder may already have cleared activeTurnId by the time a delayed old MCP request lands.
    // Exact request identity keeps that old workflow fenced while a new continuation request may run.
    expect(longRunWaitBlocksTools(SESSION, CHAT_A, null, sourceRequestId)).toBe(true);
    expect(longRunWaitBlocksTools(SESSION, CHAT_A, null, null)).toBe(true);
    expect(longRunWaitBlocksTools(SESSION, CHAT_A, null, 'wfr-continuation-request')).toBe(false);
  });

  it('does not let the source provider turn fulfill its own resolved wait debt', async () => {
    const sourceTurnId = 'turn-causal-source';
    const sourceRequestId = 'wfr-causal-source';
    const wait = await armLongRunWaitNow({
      sessionId: SESSION,
      conversationId: CHAT_A,
      sourceTurnId,
      sourceRequestId,
      kind: 'timer',
      dueAt: Date.now() + 1_000
    });
    const ticket = captureExecutionTicket(SESSION, CHAT_A)!;
    expect(await resolveLongRunWaitNow(SESSION, wait.id, ticket, 'timer resolved')).toBe(true);

    // Resolution may beat provider-turn completion. The source executor stays fenced until a
    // distinct continuation turn becomes durable, otherwise an immediately-resolved CI/timer
    // can hand authority back to the same polling turn we deliberately cut.
    expect(anyLongRunWaitActive()).toBe(true);
    expect(longRunWaitBlocksTools(SESSION, CHAT_A, sourceTurnId, sourceRequestId)).toBe(true);
    // Either durable identity still naming the source keeps it fenced.
    expect(longRunWaitBlocksTools(SESSION, CHAT_A, sourceTurnId, 'wfr-continuation')).toBe(true);
    expect(longRunWaitBlocksTools(SESSION, CHAT_A, 'turn-continuation', sourceRequestId)).toBe(true);
    // Only a distinct workflow executing in a distinct provider turn is the continuation.
    expect(longRunWaitBlocksTools(SESSION, CHAT_A, 'turn-continuation', 'wfr-continuation')).toBe(false);

    const leased = await leaseLongRunWorkNow(SESSION, CHAT_A);
    expect(leased?.work.inputId).toEqual(expect.any(String));
    expect(await markLongRunWorkQueuedNow(
      SESSION,
      leased!.work.id,
      leased!.ticket,
      leased!.work.inputId!
    )).toBe(true);
    expect(longRunWaitBlocksTools(SESSION, CHAT_A, sourceTurnId, sourceRequestId)).toBe(true);
    expect(longRunWaitBlocksTools(SESSION, CHAT_A, sourceTurnId, 'wfr-continuation')).toBe(true);
    expect(longRunWaitBlocksTools(SESSION, CHAT_A, 'turn-continuation', sourceRequestId)).toBe(true);
    expect(longRunWaitBlocksTools(SESSION, CHAT_A, 'turn-continuation', 'wfr-continuation')).toBe(false);

    expect(await noteLongRunProgressNow(
      SESSION,
      CHAT_A,
      Date.now() + 1_000,
      sourceTurnId,
      'terminal'
    )).toBe(false);
    expect(await noteLongRunProgressNow(
      SESSION,
      CHAT_A,
      Date.now() + 1_001,
      sourceTurnId,
      'mcp',
      sourceRequestId
    )).toBe(false);
    // A rejected/late source workflow is not continuation progress merely because recorder turn
    // state has already moved on. Unknown request identity also fails closed for MCP evidence.
    expect(await noteLongRunProgressNow(
      SESSION,
      CHAT_A,
      Date.now() + 1_002,
      'turn-continuation',
      'mcp',
      sourceRequestId
    )).toBe(false);
    expect(await noteLongRunProgressNow(
      SESSION,
      CHAT_A,
      Date.now() + 1_003,
      'turn-continuation',
      'mcp',
      null
    )).toBe(false);
    expect(longRunStatus(SESSION).work?.state).toBe('queued');

    expect(await noteLongRunProgressNow(
      SESSION,
      CHAT_A,
      Date.now() + 1_004,
      'turn-continuation',
      'mcp',
      'wfr-continuation'
    )).toBe(true);
    expect(longRunStatus(SESSION).work?.state).toBe('fulfilled');
    // Fulfilment proves the new continuation took over; it does not resurrect the retired source.
    expect(longRunWaitBlocksTools(SESSION, CHAT_A, sourceTurnId, sourceRequestId)).toBe(true);
    expect(longRunWaitBlocksTools(
      SESSION,
      CHAT_A,
      'turn-continuation',
      'wfr-continuation'
    )).toBe(false);
  });

  it('turns a resolved external wait into one stable continuation obligation', async () => {
    const wait = await armLongRunWaitNow({
      sessionId: SESSION,
      conversationId: CHAT_A,
      sourceTurnId: 'turn-wait-source',
      kind: 'github_run',
      repository: 'MurphyHoops/UEOT',
      runId: 35352566122,
      description: 'wait for CI'
    });
    expect(executionEpochFor(SESSION)).toMatchObject({ conversationId: CHAT_A, generation: 1 });
    expect(longRunStatus(SESSION)).toMatchObject({
      wait: { id: wait.id, state: 'waiting' },
      work: { state: 'waiting', reason: 'wait_resolved' }
    });

    const ticket = captureExecutionTicket(SESSION, CHAT_A)!;
    expect(await resolveLongRunWaitNow(SESSION, wait.id, ticket, 'CI completed with success')).toBe(true);
    expect(longRunStatus(SESSION).work).toMatchObject({ state: 'owed', reason: 'wait_resolved' });

    const first = await leaseLongRunWorkNow(SESSION, CHAT_A);
    const second = await leaseLongRunWorkNow(SESSION, CHAT_A);
    expect(first?.work.inputId).toBeTruthy();
    expect(second?.work.inputId).toBe(first?.work.inputId);
    expect(await markLongRunWorkQueuedNow(
      SESSION,
      first!.work.id,
      first!.ticket,
      first!.work.inputId!
    )).toBe(true);
    expect(longRunStatus(SESSION).work?.state).toBe('queued');
  });

  it('treats an ambiguous repeat arm as idempotent and refuses a different concurrent wait', async () => {
    const first = await armLongRunWaitNow({
      sessionId: SESSION,
      conversationId: CHAT_A,
      sourceTurnId: 'turn-source',
      kind: 'github_run',
      repository: 'MurphyHoops/UEOT',
      runId: 35352566122
    });
    const generation = executionEpochFor(SESSION)!.generation;
    const repeat = await armLongRunWaitNow({
      sessionId: SESSION,
      conversationId: CHAT_A,
      sourceTurnId: 'turn-source',
      kind: 'github_run',
      repository: 'MurphyHoops/UEOT',
      runId: 35352566122
    });
    expect(repeat.id).toBe(first.id);
    expect(executionEpochFor(SESSION)?.generation).toBe(generation);
    await expect(armLongRunWaitNow({
      sessionId: SESSION,
      conversationId: CHAT_A,
      sourceTurnId: 'turn-source',
      kind: 'timer',
      dueAt: Date.now() + 5_000
    })).rejects.toThrow('long_run_wait_already_active');
  });

  it('treats a retried timer arm and repeated cancel as the same durable operation', async () => {
    const firstDue = Date.now() + 10_000;
    const first = await armLongRunWaitNow({
      sessionId: SESSION,
      conversationId: CHAT_A,
      sourceTurnId: 'turn-retry',
      kind: 'timer',
      dueAt: firstDue
    });
    const generation = executionEpochFor(SESSION)!.generation;

    // The provider can lose the tool result and retry the same semantic call later. A timer's
    // recomputed dueAt must not extend the original deadline or advance execution authority.
    const retry = await armLongRunWaitNow({
      sessionId: SESSION,
      conversationId: CHAT_A,
      sourceTurnId: 'turn-retry',
      kind: 'timer',
      dueAt: firstDue + 5_000
    });
    expect(retry.id).toBe(first.id);
    expect(retry.dueAt).toBe(firstDue);
    expect(executionEpochFor(SESSION)!.generation).toBe(generation);

    expect(await cancelLongRunNow(SESSION, CHAT_A, 'manual_stop')).toBe(true);
    const cancelledGeneration = executionEpochFor(SESSION)!.generation;
    expect(await cancelLongRunNow(SESSION, CHAT_A, 'manual_stop')).toBe(true);
    expect(executionEpochFor(SESSION)!.generation).toBe(cancelledGeneration);
  });

  it('resets the consecutive monitor failure budget after a healthy pending observation', async () => {
    const wait = await armLongRunWaitNow({
      sessionId: SESSION,
      conversationId: CHAT_A,
      sourceTurnId: 'turn-monitor',
      kind: 'github_run',
      repository: 'MurphyHoops/UEOT',
      runId: 35352566122
    });
    const ticket = captureExecutionTicket(SESSION, CHAT_A)!;

    for (let index = 0; index < 5; index++) {
      expect(await deferLongRunWaitNow(
        SESSION, wait.id, ticket, Date.now() + 1_000, `transient-${index}`
      )).toBe(true);
    }
    expect(longRunStatus(SESSION).wait?.attempts).toBe(5);

    expect(await deferLongRunWaitNow(
      SESSION, wait.id, ticket, Date.now() + 30_000, null
    )).toBe(true);
    expect(longRunStatus(SESSION).wait).toMatchObject({ attempts: 0, lastError: null });
  });

  it('moves work and wait with A to B and fences the stale A epoch', async () => {
    const wait = await armLongRunWaitNow({
      sessionId: SESSION,
      conversationId: CHAT_A,
      sourceTurnId: 'turn-a',
      kind: 'timer',
      dueAt: Date.now() + 10_000
    });
    const stale = captureExecutionTicket(SESSION, CHAT_A)!;

    expect(await moveLongRunStateNow(SESSION, CHAT_A, CHAT_B)).toBe(true);
    expect(executionEpochFor(SESSION)).toMatchObject({ conversationId: CHAT_B, generation: 2 });
    expect(longRunStatus(SESSION).wait).toMatchObject({
      id: wait.id,
      conversationId: CHAT_B,
      epochGeneration: 2
    });
    expect(await resolveLongRunWaitNow(SESSION, wait.id, stale, 'stale A tried to resolve')).toBe(false);

    const current = captureExecutionTicket(SESSION, CHAT_B)!;
    expect(await resolveLongRunWaitNow(SESSION, wait.id, current, 'B resolved it')).toBe(true);
  });

  it('fsyncs an idempotent A to B retry even when memory already names B', async () => {
    await armLongRunWaitNow({
      sessionId: SESSION,
      conversationId: CHAT_A,
      sourceTurnId: 'turn-fsync',
      kind: 'timer',
      dueAt: Date.now() + 10_000
    });
    expect(await moveLongRunStateNow(SESSION, CHAT_A, CHAT_B)).toBe(true);

    // Simulate the crash window this API must close: memory already contains B, while the durable
    // file is absent/stale. Re-initialize a fresh durable root without disturbing the in-memory
    // execution ledger, then retry the same semantic A→B barrier.
    const secondRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'clf-long-run-retry-'));
    try {
      resetDurableForTests();
      initDurableStore(secondRoot);
      expect(executionEpochFor(SESSION)).toMatchObject({ conversationId: CHAT_B, generation: 2 });

      expect(await moveLongRunStateNow(SESSION, CHAT_A, CHAT_B)).toBe(true);
      const persisted = await readDurable<ReturnType<typeof snapshotLongRunState>>('long-run');
      expect(persisted?.epochs).toEqual([
        expect.objectContaining({ sessionId: SESSION, conversationId: CHAT_B, generation: 2 })
      ]);
      expect(persisted?.waits).toEqual([
        expect.objectContaining({ sessionId: SESSION, conversationId: CHAT_B, epochGeneration: 2 })
      ]);
    } finally {
      resetDurableForTests();
      initDurableStore(directory);
      await fs.rm(secondRoot, { recursive: true, force: true });
    }
  });

  it('restores a dispatching obligation with the same input id after restart', async () => {
    const wait = await armLongRunWaitNow({
      sessionId: SESSION,
      conversationId: CHAT_A,
      sourceTurnId: 'turn-source',
      kind: 'timer',
      dueAt: Date.now() + 1_000
    });
    const ticket = captureExecutionTicket(SESSION, CHAT_A)!;
    await resolveLongRunWaitNow(SESSION, wait.id, ticket, 'timer complete');
    const leased = await leaseLongRunWorkNow(SESSION, CHAT_A);
    const inputId = leased!.work.inputId;
    const snapshot = snapshotLongRunState();

    resetLongRunStateForTests();
    restoreLongRunState(snapshot);
    const replay = await leaseLongRunWorkNow(SESSION, CHAT_A);
    expect(replay?.work.inputId).toBe(inputId);
    expect(replay?.ticket).toEqual(leased?.ticket);
  });

  it('does not let recovery debt overwrite a resolved external-wait result', async () => {
    const wait = await armLongRunWaitNow({
      sessionId: SESSION,
      conversationId: CHAT_A,
      sourceTurnId: 'turn-resolved-before-recovery',
      kind: 'github_run',
      repository: 'MurphyHoops/UEOT',
      runId: 35352566122
    });
    const ticket = captureExecutionTicket(SESSION, CHAT_A)!;
    expect(await resolveLongRunWaitNow(
      SESSION,
      wait.id,
      ticket,
      'GitHub Actions run completed with conclusion success'
    )).toBe(true);
    const before = longRunStatus(SESSION).work;
    expect(before).toMatchObject({
      state: 'owed',
      reason: 'wait_resolved',
      result: 'GitHub Actions run completed with conclusion success'
    });

    const kept = await ensureRecoveryWorkNow(
      SESSION,
      CHAT_A,
      'recovery:new-episode:2'
    );
    expect(kept?.id).toBe(before?.id);
    expect(longRunStatus(SESSION).work).toMatchObject({
      id: before?.id,
      state: 'owed',
      reason: 'wait_resolved',
      result: 'GitHub Actions run completed with conclusion success'
    });
  });

  it('keeps a stable dispatched recovery input id across a newer recovery episode', async () => {
    const first = await ensureRecoveryWorkNow(SESSION, CHAT_A, 'recovery:episode:1');
    const leased = await leaseLongRunWorkNow(SESSION, CHAT_A);
    expect(leased?.work.id).toBe(first?.id);
    const inputId = leased?.work.inputId;
    expect(inputId).toBeTruthy();

    const kept = await ensureRecoveryWorkNow(SESSION, CHAT_A, 'recovery:episode:2');
    expect(kept?.id).toBe(first?.id);
    expect(kept?.inputId).toBe(inputId);
    expect(kept?.state).toBe('dispatching');
  });

  it('does not let recovery continuation debt overwrite an active wait', async () => {
    await armLongRunWaitNow({
      sessionId: SESSION,
      conversationId: CHAT_A,
      sourceTurnId: 'turn-source',
      kind: 'github_run',
      repository: 'MurphyHoops/UEOT',
      runId: 35352566122
    });
    const before = longRunStatus(SESSION);
    const work = await ensureRecoveryWorkNow(SESSION, CHAT_A, 'recovery:episode:1');
    const after = longRunStatus(SESSION);
    expect(work?.id).toBe(before.work?.id);
    expect(after.wait?.id).toBe(before.wait?.id);
    expect(after.work?.reason).toBe('wait_resolved');
  });

  it('requires certified MCP progress to satisfy recovery continuation debt', async () => {
    const work = await ensureRecoveryWorkNow(SESSION, CHAT_A, 'recovery:episode:1');
    expect(work?.state).toBe('owed');
    expect(await noteLongRunProgressNow(SESSION, CHAT_A, Date.now() + 1, 'turn-recovered', 'terminal')).toBe(false);
    expect(longRunStatus(SESSION).work?.state).toBe('owed');
    expect(await noteLongRunProgressNow(SESSION, CHAT_A, Date.now() + 2, 'turn-recovered', 'mcp')).toBe(true);
    expect(longRunStatus(SESSION).work?.state).toBe('fulfilled');
  });

  it('survives repeated wait, restart, dispatch, progress and carrier migration generations without duplicate authority', async () => {
    let conversationId = CHAT_A;
    const stableInputs = new Set<string>();
    let lastGeneration = 0;

    for (let cycle = 0; cycle < 24; cycle++) {
      const wait = await armLongRunWaitNow({
        sessionId: SESSION,
        conversationId,
        sourceTurnId: `lifetime-source-${cycle}`,
        kind: 'timer',
        dueAt: Date.now() + 60_000 + cycle
      });
      const ticket = captureExecutionTicket(SESSION, conversationId)!;
      expect(ticket.generation).toBeGreaterThan(lastGeneration);
      lastGeneration = ticket.generation;

      expect(await resolveLongRunWaitNow(
        SESSION,
        wait.id,
        ticket,
        `lifetime wait ${cycle} resolved`
      )).toBe(true);

      const leased = await leaseLongRunWorkNow(SESSION, conversationId);
      const duplicateLease = await leaseLongRunWorkNow(SESSION, conversationId);
      expect(leased?.work.inputId).toEqual(expect.any(String));
      expect(duplicateLease?.work.inputId).toBe(leased?.work.inputId);
      expect(stableInputs.has(leased!.work.inputId!)).toBe(false);
      stableInputs.add(leased!.work.inputId!);

      // Crash/restart between durable lease and publication must recover the same work identity,
      // never mint a sibling continuation.
      const snapshot = snapshotLongRunState();
      resetLongRunStateForTests();
      restoreLongRunState(snapshot);
      const replay = await leaseLongRunWorkNow(SESSION, conversationId);
      expect(replay?.work.inputId).toBe(leased?.work.inputId);
      expect(replay?.ticket).toEqual(leased?.ticket);

      expect(await markLongRunWorkQueuedNow(
        SESSION,
        replay!.work.id,
        replay!.ticket,
        replay!.work.inputId!
      )).toBe(true);
      expect(await noteLongRunProgressNow(
        SESSION,
        conversationId,
        replay!.work.createdAt + 1_000 + cycle,
        `lifetime-resume-${cycle}`,
        'mcp'
      )).toBe(true);
      expect(longRunStatus(SESSION).work?.state).toBe('fulfilled');

      // Periodically replace the disposable conversation carrier. The ticket from the prior
      // executor must lose authority immediately while the single durable session continues.
      if (cycle % 4 === 3) {
        const nextConversation = conversationId === CHAT_A ? CHAT_B : CHAT_A;
        const stale = captureExecutionTicket(SESSION, conversationId)!;
        expect(await moveLongRunStateNow(SESSION, conversationId, nextConversation)).toBe(true);
        expect(executionTicketCurrent(stale)).toBe(false);
        conversationId = nextConversation;
        lastGeneration = executionEpochFor(SESSION)!.generation;
      }

      const state = snapshotLongRunState();
      expect(state.epochs).toHaveLength(1);
      expect(state.obligations).toHaveLength(1);
      expect(state.waits).toHaveLength(1);
    }

    expect(stableInputs).toHaveLength(24);
    expect(executionEpochFor(SESSION)?.conversationId).toBe(conversationId);
  });

  it('Stop revokes wait and continuation authority by advancing the epoch', async () => {
    await armLongRunWaitNow({
      sessionId: SESSION,
      conversationId: CHAT_A,
      sourceTurnId: 'turn-source',
      kind: 'timer',
      dueAt: Date.now() + 10_000
    });
    const before = captureExecutionTicket(SESSION, CHAT_A)!;
    expect(await cancelLongRunNow(SESSION, CHAT_A, 'manual_stop')).toBe(true);
    expect(executionEpochFor(SESSION)?.generation).toBe(before.generation + 1);
    expect(longRunStatus(SESSION).wait?.state).toBe('cancelled');
    expect(longRunStatus(SESSION).work?.state).toBe('cancelled');
  });
});
