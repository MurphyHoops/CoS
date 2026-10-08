import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireNextWriter, defaultNextUserData } from '../../src/main/next/runtime/writer.js';
let base: string;
let home: string;
let parent: string;
let nextDir: string;
beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-next-writer-'));
  home = path.join(base, 'user');
  parent = path.join(home, 'Library', 'Application Support');
  await fs.mkdir(parent, { recursive: true });
  nextDir = path.join(parent, 'chat-on-steroids-next');
});
afterEach(async () => { await fs.rm(base, { recursive: true, force: true }); });
const options = () => ({ platform: 'darwin' as const, home });

describe('CoS Next independent userData and atomic writer lock', () => {
  it('chooses a distinct data root without reusing installed CoS v3 userData', () => {
    expect(defaultNextUserData('darwin', home)).toBe(nextDir);
    expect(defaultNextUserData('linux', home)).toContain('chat-on-steroids-next');
  });
  it('exclusively acquires and releases a real Next data-root writer reservation', async () => {
    const first = await acquireNextWriter(nextDir, options());
    await first.verify();
    await expect(acquireNextWriter(nextDir, options())).rejects.toThrow('NEXT_WRITER_ALREADY_OWNED');
    await Promise.all([first.release(), first.release()]);
    const second = await acquireNextWriter(nextDir, options());
    await second.verify();
    await first.release();
    await second.verify();
    await second.release();
  });
  it('never uses old app userData root or a descendant of it', async () => {
    const old = path.join(parent, 'chat-on-steroids');
    await expect(acquireNextWriter(old, options())).rejects.toThrow('LEGACY_DATA_ROOT_FORBIDDEN');
    await fs.mkdir(old);
    await expect(acquireNextWriter(path.join(old, 'state'), options()))
      .rejects.toThrow('LEGACY_DATA_ROOT_FORBIDDEN');
  });
  it('denies a stale/ambiguous previous writer after a crash instead of stealing its lock', async () => {
    await fs.mkdir(nextDir);
    await fs.mkdir(path.join(nextDir, '.next-writer'));
    await fs.writeFile(path.join(nextDir, '.next-writer', 'owner.json'), 'broken');
    await expect(acquireNextWriter(nextDir, options())).rejects.toThrow('NEXT_WRITER_ALREADY_OWNED');
    expect(await fs.readFile(path.join(nextDir, '.next-writer', 'owner.json'), 'utf8')).toBe('broken');
  });
  it('detects ownership tampering and refuses to remove an unidentified lock', async () => {
    const first = await acquireNextWriter(nextDir, options());
    const ownerFile = path.join(nextDir, '.next-writer', 'owner.json');
    await fs.writeFile(ownerFile, JSON.stringify({ version: 1, nonce: '0'.repeat(48), pid: process.pid }));
    await expect(first.verify()).rejects.toThrow('NEXT_WRITER_AMBIGUOUS');
    await expect(first.release()).rejects.toThrow('NEXT_WRITER_AMBIGUOUS');
    expect(await fs.stat(ownerFile)).toBeDefined();
  });
  it('refuses symlinked and world-writable data directories', async () => {
    const target = path.join(parent, 'target');
    await fs.mkdir(target);
    await fs.symlink(target, nextDir);
    await expect(acquireNextWriter(nextDir, options())).rejects.toThrow('NEXT_DATA_NOT_OWNED_DIRECTORY');
    await fs.rm(nextDir);
    await fs.mkdir(nextDir, { mode: 0o777 });
    await fs.chmod(nextDir, 0o777);
    await expect(acquireNextWriter(nextDir, options())).rejects.toThrow('NEXT_DATA_WRITABLE_BY_OTHERS');
  });
  it('does not use data paths outside the user home', async () => {
    await expect(acquireNextWriter(base, options())).rejects.toThrow('NEXT_DATA_OUTSIDE_USER_HOME');
  });
  it('serializes a 30-contender startup race with exactly one winner', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 30 }, () => acquireNextWriter(nextDir, options()))
    );
    const success = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof acquireNextWriter>>> =>
      r.status === 'fulfilled');
    expect(success).toHaveLength(1);
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(29);
    await success[0]!.value.release();
  });
});
