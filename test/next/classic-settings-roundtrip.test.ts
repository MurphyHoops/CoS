import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { defaultConfig, initConfigPath, loadConfig, saveConfig } from '../../src/main/config.js';
import { defaultNextUserData } from '../../src/main/next/runtime/writer.js';

/**
 * Offline parity gate for Next Classic's real persisted config implementation.
 * Uses an entirely synthetic home. Never reads the user's old or Next profile.
 */
describe('Next Classic settings round-trip and old-CoS isolation', () => {
  let home: string;
  let original: string;
  let next: string;
  let originalHash: string;
  beforeAll(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-next-classic-settings-'));
    original = path.join(home, 'Library', 'Application Support', 'chat-on-steroids');
    next = defaultNextUserData('darwin', home);
    await fs.mkdir(original, { recursive: true, mode: 0o700 });
    await fs.mkdir(next, { recursive: true, mode: 0o700 });
    const untouched = Buffer.from(JSON.stringify({
      marker: 'legacy-user-config-must-not-change',
      ui: { theme: 'dark' }
    }));
    await fs.writeFile(path.join(original, 'config.json'), untouched, { mode: 0o600 });
    originalHash = createHash('sha256').update(untouched).digest('hex');
    initConfigPath(next);
  });
  afterAll(async () => { await fs.rm(home, { recursive: true, force: true }); });

  it('derives a different canonical userData directory for Next', () => {
    expect(next).not.toBe(original);
    expect(path.basename(next)).toBe('chat-on-steroids-next');
  });

  it('saves, reloads, and edits reversible UI and Goal settings in Next only', async () => {
    const starting = defaultConfig();
    await saveConfig({ ...starting, ui: {
      ...starting.ui, theme: 'dark', tabsToKeepOpen: 5
    } });
    const afterSave = await loadConfig();
    expect(afterSave.ui.theme).toBe('dark');
    expect(afterSave.ui.tabsToKeepOpen).toBe(5);

    // The next load re-parses the physically persisted JSON, just as restart
    // does. Keep all autonomous/model toggles disabled during this test.
    await saveConfig({ ...afterSave,
      ui: { ...afterSave.ui, theme: 'light', tabsToKeepOpen: 2 },
      multiAgent: { ...afterSave.multiAgent, enabled: false, maxWorkers: 2 },
      goal: { ...afterSave.goal, enabled: false, backend: 'chatgpt' }
    });
    const reloaded = await loadConfig();
    expect(reloaded.ui.theme).toBe('light');
    expect(reloaded.ui.tabsToKeepOpen).toBe(2);
    expect(reloaded.multiAgent).toMatchObject({ enabled: false, maxWorkers: 2 });
    expect(reloaded.goal).toMatchObject({ enabled: false, backend: 'chatgpt' });
    const bytes = await fs.readFile(path.join(next, 'config.json'), 'utf8');
    expect(JSON.parse(bytes).ui.tabsToKeepOpen).toBe(2);
    const currentOriginal = await fs.readFile(path.join(original, 'config.json'));
    expect(createHash('sha256').update(currentOriginal).digest('hex')).toBe(originalHash);
  });

  it('does not persist a synthetic key or legacy profile in the settings writer', async () => {
    const saved = await fs.readFile(path.join(next, 'config.json'), 'utf8');
    expect(saved).not.toContain('legacy-user-config-must-not-change');
    expect(saved).not.toContain('openaiApiKey');
    expect(saved).not.toContain('sk-TEST-DO-NOT-STORE');
  });
});
