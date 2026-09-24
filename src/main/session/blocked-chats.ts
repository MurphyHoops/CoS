/**
 * The user's stop button for a ChatGPT turn that ChatGPT itself will no longer stop.
 *
 * A wedged ChatGPT page can leave a turn running with no working Stop control: the model
 * keeps issuing connector calls, the user can neither see the turn's messages nor cancel it,
 * and every one of those calls arrives here as an ordinary, correctly attributed request. The
 * app cannot end that server-side turn — nothing it can reach owns it. What it does own is
 * whether the turn gets to touch this machine, and refusing every tool it calls is enough:
 * a model with no working tools and an explicit instruction to stop answers and ends the turn.
 *
 * The blocked thing is a **conversation**, not a request id, even though a request id is what
 * the refusal is actually matched on. `correlation.ts` already proves `requestId ->
 * conversationId` exactly, and one ChatGPT turn issues all of its connector calls under one
 * request id, so a conversation is the only key that stays true for the whole rogue turn and
 * for the next one after it. Enumerating request ids would ban the turn the user was looking
 * at and nothing the same chat did a second later.
 *
 * The block is therefore exact-identity only, and deliberately so: it refuses a call whose
 * proven owner is blocked and never a call whose owner is merely unknown. Guessing here would
 * refuse an innocent chat's file read to punish a different chat's turn, which is the trade this
 * whole codebase refuses to make everywhere else.
 *
 * What that costs, and where it was originally got wrong: "the user blocks a chat whose request
 * id is already proven" is true of the turn the user was looking at and of nothing after it. A
 * new turn brings a new request id, and a wedged page — the whole reason this exists — is the
 * page least able to report one promptly. Enforcement that only read already-proven identity
 * therefore let a blocked chat keep running tools that the recorder, which does wait for late
 * evidence, then filed under that same blocked chat. Waiting for the exact request-id mate is
 * not guessing, so the enforcement gate in kernel.ts waits exactly as long as attribution does.
 *
 * Blocks are durable and released only by the user. A restart is not a reason to hand a rogue
 * turn its tools back; the turn can outlive the app.
 */

import { readDurableResult, writeDurableCheckpointNow, writeDurableNow, writeDurableSoon } from '../durable.js';
import {
  durableRecoveryPaused,
  noteDurableRecoveryIncident,
  resolveDurableRecoveryIncident
} from '../durable-recovery.js';

/**
 * A hand-curated list, so the ceiling only exists to keep a corrupt or hostile state file from
 * growing without bound. Reaching it is a real error the user sees, never a silent eviction:
 * evicting the oldest entry would quietly unblock a chat the user stopped on purpose.
 */
const MAX_BLOCKED_CHATS = 200;
const BLOCKED_STATE = 'blocked-chats';
const BLOCKED_STATE_VERSION = 1;
const BLOCKED_RECOVERY_DOMAIN = 'blocked-tools' as const;

/** Conversation id -> when the user blocked it. */
const blocked = new Map<string, number>();
let restored = false;
let mutations: Promise<unknown> = Promise.resolve();

interface PersistedBlocks {
  version: number;
  entries: Array<{ conversationId: string; blockedAt: number }>;
}

/**
 * The one thing a blocked chat's model is told, on every tool it tries.
 *
 * Written as an instruction rather than a diagnosis because the model is the only party that
 * can end the turn: it names the state, forbids the retry loop a bare failure invites, and
 * asks for the one action that finishes — a final answer. `CHAT_BLOCKED:` matches the prefix
 * convention the other kernel refusals use.
 */
export const BLOCKED_CHAT_REFUSAL =
  'CHAT_BLOCKED: the user blocked this conversation from using local tools, and no tool was run. ' +
  'This session went rogue. Stop right now: abandon the task, make no further tool calls of any ' +
  'kind, and reply to the user immediately with your final answer. The user explicitly asked for this.';

export const BLOCKED_CHAT_RECOVERY_REFUSAL =
  'DURABLE_RECOVERY_PAUSED: the blocked-chat safety ledger could not be read safely, so CoS cannot prove ' +
  'which ChatGPT conversations are allowed to use local tools. No local tool was run. Do not retry local ' +
  'mutations until the durable recovery incident is resolved in the app.';

function snapshot(): PersistedBlocks {
  return {
    version: BLOCKED_STATE_VERSION,
    entries: [...blocked].map(([conversationId, blockedAt]) => ({ conversationId, blockedAt }))
  };
}

function snapshotWithout(conversationId: string): PersistedBlocks {
  return {
    version: BLOCKED_STATE_VERSION,
    entries: [...blocked]
      .filter(([id]) => id !== conversationId)
      .map(([id, blockedAt]) => ({ conversationId: id, blockedAt }))
  };
}

function validConversationId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-z-]{8,64}$/i.test(value);
}

function decodePersistedBlocks(value: unknown): PersistedBlocks | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as { version?: unknown; entries?: unknown };
  if (raw.version !== BLOCKED_STATE_VERSION || !Array.isArray(raw.entries) || raw.entries.length > MAX_BLOCKED_CHATS) {
    return null;
  }
  const seen = new Set<string>();
  const entries: PersistedBlocks['entries'] = [];
  for (const candidate of raw.entries) {
    if (!candidate || typeof candidate !== 'object') return null;
    const entry = candidate as { conversationId?: unknown; blockedAt?: unknown };
    if (!validConversationId(entry.conversationId) ||
        !Number.isSafeInteger(entry.blockedAt) || Number(entry.blockedAt) <= 0 ||
        seen.has(entry.conversationId)) return null;
    seen.add(entry.conversationId);
    entries.push({ conversationId: entry.conversationId, blockedAt: Number(entry.blockedAt) });
  }
  return { version: BLOCKED_STATE_VERSION, entries };
}

function noteRecovery(
  copy: 'primary' | 'backup',
  failure: 'json_corrupt' | 'schema_invalid' | 'io_error' | 'checkpoint_degraded' | 'orphan_backup',
  disposition: 'pause' | 'degraded',
  detail?: string
): void {
  noteDurableRecoveryIncident({
    domain: BLOCKED_RECOVERY_DOMAIN,
    ledger: BLOCKED_STATE,
    copy,
    failure,
    disposition,
    detail
  });
}

async function inspectBackupHealth(): Promise<'missing' | 'valid' | 'invalid'> {
  const result = await readDurableResult<unknown>(BLOCKED_STATE, 'backup');
  if (result.kind === 'missing') {
    resolveDurableRecoveryIncident(BLOCKED_RECOVERY_DOMAIN, BLOCKED_STATE, 'backup');
    return 'missing';
  }
  if (result.kind === 'io_error') {
    noteRecovery('backup', 'io_error', 'degraded', result.error);
    return 'invalid';
  }
  if (result.kind === 'corrupt') {
    noteRecovery('backup', 'json_corrupt', 'degraded', result.error);
    return 'invalid';
  }
  if (!decodePersistedBlocks(result.value)) {
    noteRecovery('backup', 'schema_invalid', 'degraded', 'backup snapshot failed blocked-chat schema validation');
    return 'invalid';
  }
  resolveDurableRecoveryIncident(BLOCKED_RECOVERY_DOMAIN, BLOCKED_STATE, 'backup');
  return 'valid';
}

async function checkpointAccepted(value: PersistedBlocks): Promise<void> {
  try {
    await writeDurableCheckpointNow(BLOCKED_STATE, value);
    resolveDurableRecoveryIncident(BLOCKED_RECOVERY_DOMAIN, BLOCKED_STATE, 'backup');
  } catch (error) {
    noteRecovery(
      'backup',
      'checkpoint_degraded',
      'degraded',
      error instanceof Error ? error.message : String(error)
    );
  }
}

/**
 * Loads the blocked set before the MCP endpoint can accept a call.
 *
 * A block that arrives one call late is a block the rogue turn got one more tool out of, so
 * this runs alongside the correlation restore rather than lazily on first use.
 */
export async function restoreBlockedChats(): Promise<void> {
  if (restored) return;
  blocked.clear();
  const primary = await readDurableResult<unknown>(BLOCKED_STATE);
  if (primary.kind === 'missing') {
    const backup = await inspectBackupHealth();
    if (backup === 'missing') {
      resolveDurableRecoveryIncident(BLOCKED_RECOVERY_DOMAIN, BLOCKED_STATE, 'primary');
      restored = true;
      return;
    }
    noteRecovery(
      'primary',
      'orphan_backup',
      'pause',
      'primary blocked-chat ledger is missing while recovery evidence still exists'
    );
    return;
  }
  if (primary.kind === 'io_error') {
    noteRecovery('primary', 'io_error', 'pause', primary.error);
    await inspectBackupHealth();
    return;
  }
  if (primary.kind === 'corrupt') {
    noteRecovery('primary', 'json_corrupt', 'pause', primary.error);
    await inspectBackupHealth();
    return;
  }
  const saved = decodePersistedBlocks(primary.value);
  if (!saved) {
    noteRecovery('primary', 'schema_invalid', 'pause', 'primary snapshot failed blocked-chat schema validation');
    await inspectBackupHealth();
    return;
  }

  for (const entry of saved.entries) blocked.set(entry.conversationId, entry.blockedAt);
  resolveDurableRecoveryIncident(BLOCKED_RECOVERY_DOMAIN, BLOCKED_STATE, 'primary');
  restored = true;
  await checkpointAccepted(saved);
}

/** Whether blocked-chat authority is paused because its durable ledger is not trustworthy. */
export function blockedChatRecoveryPaused(): boolean {
  return durableRecoveryPaused(BLOCKED_RECOVERY_DOMAIN);
}

/**
 * Whether any block exists at all.
 *
 * The kernel's cheap way to ask whether it is worth resolving a call's identity before deciding
 * — see the block gate in kernel.ts. An install with no blocked chat pays one map read per call
 * and never waits on the browser for this.
 */
export function anyChatBlocked(): boolean {
  return blocked.size > 0;
}

/** Exact lookup. An unproven caller has no conversation and is therefore never blocked. */
export function isChatBlocked(conversationId: string | null | undefined): boolean {
  return conversationId !== null && conversationId !== undefined && blocked.has(conversationId);
}

/** Every blocked conversation, so one renderer paint can mark all of its rows at once. */
export function blockedChatIds(): string[] {
  return [...blocked.keys()];
}

/** The user's existing durable block time, for retiring its browser page after a quiet grace. */
export function chatBlockedAt(conversationId: string): number | null {
  return blocked.get(conversationId) ?? null;
}

/**
 * Blocks or releases one conversation. The returned promise is the acknowledgement boundary:
 * callers may report success only after this exact state is durable.
 *
 * Blocking is deliberately conservative. The live fence is installed before its durable write;
 * if that write fails, the caller sees failure but the conversation stays blocked and the
 * durable writer keeps retrying that same safe state. Releasing is the inverse: the durable
 * removal lands before the live fence is removed, so a failed release can never briefly hand a
 * rogue turn its tools back. Mutations serialize here because this map is the authoritative
 * owner; an older failed generation must not race a newer accepted user action.
 */
export function setChatBlocked(conversationId: string, next: boolean): Promise<void> {
  if (!validConversationId(conversationId)) throw new Error('Not a ChatGPT conversation id');
  const operation = mutations.then(async () => {
    if (blockedChatRecoveryPaused()) {
      throw new Error('Blocked-chat durable recovery must be resolved before changing tool access');
    }
    const alreadyBlocked = blocked.has(conversationId);
    if (next) {
      if (!alreadyBlocked) {
        if (blocked.size >= MAX_BLOCKED_CHATS) {
          throw new Error(`Too many blocked chats (${MAX_BLOCKED_CHATS}). Release one before blocking another.`);
        }
        blocked.set(conversationId, Date.now());
      }
      // Even an idempotent retry crosses the barrier again: the previous Block attempt may have
      // left the safe live fence installed after its durable write rejected.
      const accepted = snapshot();
      await writeDurableNow(BLOCKED_STATE, accepted);
      await checkpointAccepted(accepted);
      return;
    }

    if (!alreadyBlocked) return;
    const accepted = snapshotWithout(conversationId);
    try {
      await writeDurableNow(BLOCKED_STATE, accepted);
    } catch (error) {
      // writeDurableNow retains a failed generation for retry. Supersede a rejected Release with
      // the still-authoritative blocked snapshot so a background retry cannot later unblock it.
      writeDurableSoon(BLOCKED_STATE, snapshot());
      throw error;
    }
    blocked.delete(conversationId);
    await checkpointAccepted(accepted);
  });
  mutations = operation.catch(() => undefined);
  return operation;
}

export function resetBlockedChatsForTests(): void {
  blocked.clear();
  restored = false;
  mutations = Promise.resolve();
}
