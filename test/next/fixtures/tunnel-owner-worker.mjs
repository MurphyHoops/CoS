import { reserveTunnelOwnership } from '../../../src/main/next/tunnel/exclusive-owner.mjs';
const tunnelId = process.env.COS_NEXT_TEST_TUNNEL_ID;
const root = process.env.COS_NEXT_TEST_LOCK_ROOT;
const label = process.env.COS_NEXT_TEST_LABEL ?? 'core';
try {
  const holder = await reserveTunnelOwnership(tunnelId, { root, label });
  process.stdout.write('ACQUIRED\n');
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', async chunk => {
    if (!chunk.includes('release')) return;
    try {
      await holder.release();
      process.stdout.write('RELEASED\n', () => process.exit(0));
    } catch (error) {
      process.stdout.write('REFUSED:' + error.code + '\n', () => process.exit(4));
    }
  });
} catch (error) {
  process.stdout.write('REFUSED:' + (error.code ?? 'UNKNOWN') + '\n', () => process.exit(2));
}
