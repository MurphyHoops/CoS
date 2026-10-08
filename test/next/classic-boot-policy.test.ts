import { describe, expect, it } from 'vitest';
import { originalCoSProcessActive } from '../../src/main/next/runtime/classic-boot-policy.js';

describe('CoS Next Classic exclusive original-app guard', () => {
  it('rejects an installed original app running in Applications', () => {
    expect(originalCoSProcessActive(
      '/Applications/Chat On Steroids.app/Contents/MacOS/Chat On Steroids')).toBe(true);
  });
  it('rejects a relocated original app or original tunnel subprocess', () => {
    expect(originalCoSProcessActive(
      '/Users/test/Downloads/Chat On Steroids.app/Contents/Resources/tunnel/tunnel-client')).toBe(true);
  });
  it('does not confuse running Next with the old app', () => {
    expect(originalCoSProcessActive(
      '/Users/test/CoS-Next-WP03/release-next/mac-arm64/Chat On Steroids Next.app/Contents/MacOS/Chat On Steroids Next'
    )).toBe(false);
  });
  it('does not mistake an installed copy as a running process', () => {
    expect(originalCoSProcessActive('/usr/bin/find /Applications/Chat On Steroids.app')).toBe(false);
    expect(originalCoSProcessActive('/usr/bin/python3')).toBe(false);
  });
});
