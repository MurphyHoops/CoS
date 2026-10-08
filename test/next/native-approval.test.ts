import { describe, expect, it } from 'vitest';
import { NextNativeApprovalBroker } from '../../src/main/next/auth/native-approval.js';
describe('WP02 Next OS-native one-shot approval broker', () => {
  it('mints an opaque ticket only after a native local dialog agrees', async () => {
    const broker = new NextNativeApprovalBroker(async (_kind, scope) => scope === 'mission-A');
    expect(await broker.request('grant', 'mission-B')).toBeNull();
    const ticket = await broker.request('grant', 'mission-A');
    expect(ticket).not.toBeNull();
    expect(Object.keys(ticket!)).toEqual([]);
    expect(await broker.consume(ticket, 'grant', 'mission-A')).toBe(true);
    expect(await broker.consume(ticket, 'grant', 'mission-A')).toBe(false);
  });
  it('refuses a tool-defined object, JSON clone, boolean, wrong operation or different mission', async () => {
    const broker = new NextNativeApprovalBroker(async () => true);
    const ticket = await broker.request('grant', 'mission-A');
    for (const forged of [true, { approved: true }, {}, JSON.parse(JSON.stringify(ticket))]) {
      expect(await broker.consume(forged, 'grant', 'mission-A')).toBe(false);
    }
    expect(await broker.consume(ticket, 'revoke', 'mission-A')).toBe(false);
    expect(await broker.consume(ticket, 'grant', 'mission-B')).toBe(false);
    expect(await broker.consume(ticket, 'grant', 'mission-A')).toBe(true);
  });
  it('expires approved tickets and does not renew them implicitly', async () => {
    let now = 5_000;
    const broker = new NextNativeApprovalBroker(async () => true, () => now, 1000);
    const ticket = await broker.request('resume', 'mission-A');
    now = 6_000;
    expect(await broker.consume(ticket, 'resume', 'mission-A')).toBe(false);
  });
  it('fails closed on UI exceptions, forbidden names and absent UI proof', async () => {
    const broker = new NextNativeApprovalBroker(async () => { throw new Error('no native UI'); });
    expect(await broker.request('tunnel', 'core')).toBeNull();
    await expect(broker.request('grant', '__proto__')).rejects.toThrow('INVALID_APPROVAL_SCOPE');
    expect(await broker.consume(null, 'grant', 'mission-A')).toBe(false);
  });
  it('two parallel consumes cannot both win the same approval ticket', async () => {
    const broker = new NextNativeApprovalBroker(async () => true);
    const ticket = await broker.request('grant', 'mission-A');
    const results = await Promise.all(Array.from({ length: 40 },
      () => broker.consume(ticket, 'grant', 'mission-A')));
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});
