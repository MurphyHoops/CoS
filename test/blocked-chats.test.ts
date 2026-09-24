/**
 * The block registry on its own: what survives a restart, and what a second press does.
 *
 * The fence itself — that a blocked conversation's tool calls are actually refused over real
 * HTTP, and that nobody else's are — is proved end to end in `mcp.test.ts`. What is left here
 * is the part a rogue turn outlives: the block has to still be there after the app is
 * restarted, because the turn can be.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { flushDurable, initDurableStore, readDurable, resetDurableForTests } from '../src/main/durable.js';
import {
  BLOCKED_CHAT_REFUSAL,
  blockedChatIds,
  isChatBlocked,
  resetBlockedChatsForTests,
  restoreBlockedChats,
  setChatBlocked
} from '../src/main/session/blocked-chats.js';
import { makeTempDir, removeTempDir } from './helpers.js';

const ROGUE = 'conv-rogue-turn-01';
const OTHER = 'conv-other-chat-01';

let dir: string;

beforeEach(async () => {
  resetBlockedChatsForTests();
  resetDurableForTests();
  dir = await makeTempDir('clf-blocked-');
  initDurableStore(dir);
});

afterAll(async () => {
  resetBlockedChatsForTests();
  resetDurableForTests();
  if (dir) await removeTempDir(dir);
});

describe('blocked chats', () => {
  it('blocks and releases exactly the conversation it was told about', async () => {
    await setChatBlocked(ROGUE, true);
    expect(isChatBlocked(ROGUE)).toBe(true);
    expect(isChatBlocked(OTHER)).toBe(false);
    // Unattributed work has no conversation, so it can never be the blocked one.
    expect(isChatBlocked(null)).toBe(false);
    expect(isChatBlocked(undefined)).toBe(false);

    await setChatBlocked(ROGUE, false);
    expect(isChatBlocked(ROGUE)).toBe(false);
    expect(blockedChatIds()).toEqual([]);
  });

  it('is idempotent in both directions, so a double press cannot resurrect a release', async () => {
    await setChatBlocked(ROGUE, true);
    await setChatBlocked(ROGUE, true);
    expect(blockedChatIds()).toEqual([ROGUE]);

    await setChatBlocked(ROGUE, false);
    await setChatBlocked(ROGUE, false);
    expect(blockedChatIds()).toEqual([]);
  });

  it('survives a restart, because the turn it stopped can survive one too', async () => {
    await setChatBlocked(ROGUE, true);
    await flushDurable();

    // A fresh process: same state directory, empty registry.
    resetBlockedChatsForTests();
    expect(isChatBlocked(ROGUE)).toBe(false);
    await restoreBlockedChats();
    expect(isChatBlocked(ROGUE)).toBe(true);
    expect(isChatBlocked(OTHER)).toBe(false);
  });

  it('does not restore a release, and does not restore a junk id', async () => {
    await setChatBlocked(ROGUE, true);
    await setChatBlocked(OTHER, true);
    await setChatBlocked(ROGUE, false);
    await flushDurable();

    resetBlockedChatsForTests();
    await restoreBlockedChats();
    expect(blockedChatIds()).toEqual([OTHER]);

    expect(() => setChatBlocked('nope', true)).toThrow(/conversation id/i);
    expect(() => setChatBlocked('has spaces and !', true)).toThrow(/conversation id/i);
    expect(blockedChatIds()).toEqual([OTHER]);
  });

  it('tells the model to stop rather than merely that it failed', () => {
    // A bare failure is an invitation to retry, and a rogue turn retrying is the problem.
    expect(BLOCKED_CHAT_REFUSAL).toContain('CHAT_BLOCKED');
    expect(BLOCKED_CHAT_REFUSAL).toMatch(/no tool was run/i);
    expect(BLOCKED_CHAT_REFUSAL).toMatch(/no further tool calls/i);
    expect(BLOCKED_CHAT_REFUSAL).toMatch(/final answer/i);
    expect(BLOCKED_CHAT_REFUSAL).toMatch(/the user explicitly asked for this/i);
  });

  it('refuses to grow without bound rather than silently unblocking the oldest chat', async () => {
    for (let index = 0; index < 200; index++) await setChatBlocked(`conv-bulk-${String(index).padStart(4, '0')}`, true);
    expect(blockedChatIds()).toHaveLength(200);
    await expect(setChatBlocked(ROGUE, true)).rejects.toThrow(/too many blocked chats/i);
    // The chat that was already stopped is still stopped.
    expect(isChatBlocked('conv-bulk-0000')).toBe(true);
  });

  it('does not acknowledge Block or Release before their durable rename lands', async () => {
    const target = path.join(dir, 'state', 'blocked-chats.json');
    const realRename = fs.rename.bind(fs);
    let enter!: () => void;
    let release!: () => void;
    let entered = new Promise<void>(resolve => { enter = resolve; });
    let held = new Promise<void>(resolve => { release = resolve; });
    let holdNext = true;
    const rename = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === target && holdNext) {
        holdNext = false;
        enter();
        await held;
      }
      return realRename(from, to);
    });

    try {
      let settled = false;
      const block = setChatBlocked(ROGUE, true).finally(() => { settled = true; });
      await entered;
      expect(isChatBlocked(ROGUE)).toBe(true); // conservative fence is already live
      expect(settled).toBe(false);
      expect(await readDurable('blocked-chats')).toBeNull();
      release();
      await block;

      entered = new Promise<void>(resolve => { enter = resolve; });
      held = new Promise<void>(resolve => { release = resolve; });
      holdNext = true;
      settled = false;
      const releaseBlock = setChatBlocked(ROGUE, false).finally(() => { settled = true; });
      await entered;
      expect(isChatBlocked(ROGUE)).toBe(true); // Release publishes only after durable removal
      expect(settled).toBe(false);
      release();
      await releaseBlock;
      expect(isChatBlocked(ROGUE)).toBe(false);
    } finally {
      release();
      rename.mockRestore();
    }
  });

  it('keeps Block conservative when its durable write fails', async () => {
    const target = path.join(dir, 'state', 'blocked-chats.json');
    const realRename = fs.rename.bind(fs);
    const failure = Object.assign(new Error('injected blocked-chat write failure'), { code: 'EBUSY' });
    const rename = vi.spyOn(fs, 'rename').mockImplementationOnce(async (from, to) => {
      if (String(to) === target) throw failure;
      return realRename(from, to);
    });
    try {
      await expect(setChatBlocked(ROGUE, true)).rejects.toBe(failure);
      expect(isChatBlocked(ROGUE)).toBe(true);
    } finally {
      rename.mockRestore();
    }
    // An explicit retry must cross a fresh durable barrier before it can acknowledge success.
    await setChatBlocked(ROGUE, true);
    resetBlockedChatsForTests();
    await restoreBlockedChats();
    expect(isChatBlocked(ROGUE)).toBe(true);
  });

  it('keeps a chat blocked when durable Release fails and never retries the rejected removal', async () => {
    await setChatBlocked(ROGUE, true);
    const target = path.join(dir, 'state', 'blocked-chats.json');
    const realRename = fs.rename.bind(fs);
    const failure = Object.assign(new Error('injected blocked-chat release failure'), { code: 'EBUSY' });
    const rename = vi.spyOn(fs, 'rename').mockImplementationOnce(async (from, to) => {
      if (String(to) === target) throw failure;
      return realRename(from, to);
    });
    try {
      await expect(setChatBlocked(ROGUE, false)).rejects.toBe(failure);
      expect(isChatBlocked(ROGUE)).toBe(true);
    } finally {
      rename.mockRestore();
    }
    // The rejected release generation is superseded by the authoritative blocked snapshot.
    await flushDurable();
    resetBlockedChatsForTests();
    await restoreBlockedChats();
    expect(isChatBlocked(ROGUE)).toBe(true);
  });
});
