// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { NextUiBridge } from '../../src/shared/next-ui.js';

const repo = process.cwd();
const html = readFileSync(path.join(repo, 'src/next-renderer/index.html'), 'utf8');
const body = /<body>([\s\S]*?)<\/body>/.exec(html)?.[1] ?? '';
const records = {
  projects: [{ projectId: 'project-one', canonicalRoot: '/tmp/unsafe-<img src=x onerror=alert(1)>' }],
  missions: [{ missionId: 'mission-one', projectId: 'project-one', state: 'READY', epoch: 1,
    revision: 1, completionChecks: ['ci', 'review'] }],
  workers: [{ agentId: 'agent-one', missionId: 'mission-one', state: 'QUEUED', epoch: 1 }],
  obligations: [{ obligationId: 'wait-1', missionId: 'mission-one', kind: 'ci',
    state: 'ARMED', outcome: 'PENDING', continuation: 'NONE' }]
};

describe('Next independently bundled renderer with trusted preload API', () => {
  it('loads a real dashboard, requests native catalog only on click and escapes project content', async () => {
    document.body.innerHTML = body;
    const catalog = vi.fn(async () => structuredClone(records));
    const createMission = vi.fn(async () => ({ ok: true }));
    const api: NextUiBridge = {
      status: async () => ({ runtime: 'READY', leases: 'ready', journal: 'READY',
        tunnel: 'DISCONNECTED', keychain: 'AVAILABLE', model: 'DISABLED',
        remoteAuthority: 'DISABLED', plugin: 'NOT_REQUIRED' }),
      catalog,
      chooseProject: async () => ({ ok: false }),
      createMission,
      connectCore: async () => ({ ok: false }),
      disconnectCore: async () => ({ ok: false })
    };
    Object.defineProperty(window, 'cosNext', { value: api, configurable: true });
    await import('../../src/next-renderer/main.js');
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(document.body.textContent).toContain('工作台总览');
    expect(document.body.textContent).toContain('Runtime READY');
    expect(catalog).not.toHaveBeenCalled();
    document.querySelector<HTMLButtonElement>('[data-action="catalog"]')!.click();
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(catalog).toHaveBeenCalledTimes(1);
    // Text must not create an image with an executable event handler.
    expect(document.querySelector('img[onerror]')).toBeNull();
    const projects = document.querySelector<HTMLButtonElement>('[data-view="projects"]')!;
    projects.click();
    expect(document.body.textContent).toContain('unsafe-<img src=x onerror=alert(1)>');
    const missionTab = document.querySelector<HTMLButtonElement>('[data-view="missions"]')!;
    missionTab.click();
    expect(document.body.textContent).toContain('mission-one');
    document.querySelector<HTMLButtonElement>('[data-action="create-mission"]')!.click();
    await new Promise(resolve => setTimeout(resolve, 35));
    expect(createMission).toHaveBeenCalledWith('project-one', ['build','tests','review']);
    expect(document.body.textContent).toContain('Mission 已保存到本地账本');
  });
});
