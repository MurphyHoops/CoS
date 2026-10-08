/**
 * Opt-in, synthetic-profile-only Classic UI test controller.
 * Not a generic IPC bridge: no arbitrary JS, file I/O, credentials, or tunnel actions.
 * The local UNIX socket is reachable only inside a private temporary HOME.
 */
import { createServer, type Server } from 'node:net';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BrowserWindow, App } from 'electron';

export interface ClassicControlOptions {
  isNext: boolean;
  packaged: boolean;
  home: string;
  userData: string;
  socket: string;
  temporaryRoot?: string;
}

export function classicControlPermitted(options: ClassicControlOptions): boolean {
  if (!options.isNext || !options.packaged || !path.isAbsolute(options.home) || !path.isAbsolute(options.socket)) return false;
  const temp = path.resolve(options.temporaryRoot ?? os.tmpdir());
  const home = path.resolve(options.home);
  if (path.dirname(home) !== temp || !path.basename(home).startsWith('cos-next-ctl-')) return false;
  if (path.resolve(options.socket) !== path.join(home, 'control.sock')) return false;
  return path.resolve(options.userData) === path.join(home, 'Library', 'Application Support', 'chat-on-steroids-next');
}

/** Keep synthetic QA from starting the browser, Tunnel or provider wake path. */
export function classicTestTransportDisabled(): boolean {
  const home = process.env.HOME ?? '';
  return process.env.COS_NEXT_E2E_TEMP_PROFILE === '1' &&
    process.env.COS_NEXT_CLASSIC_WORKFLOW === '1' &&
    classicControlPermitted({
      isNext: true, packaged: true, home,
      userData: path.join(home, 'Library', 'Application Support', 'chat-on-steroids-next'),
      socket: process.env.COS_NEXT_TEST_CONTROL_SOCKET ?? ''
    });
}

export async function startClassicTestControl(args: ClassicControlOptions & {
  app: App;
  window: () => BrowserWindow | null;
}): Promise<() => Promise<void>> {
  if (!classicControlPermitted(args) || process.env.COS_NEXT_E2E_TEMP_PROFILE !== '1')
    throw new Error('NEXT_TEST_CONTROL_REQUIRES_ISOLATED_PACKAGED_PROFILE');
  const dir = await fs.lstat(args.home);
  if (!dir.isDirectory() || dir.isSymbolicLink() || (dir.mode & 0o077) || (typeof process.getuid === 'function' && dir.uid !== process.getuid()))
    throw new Error('NEXT_TEST_CONTROL_HOME_NOT_PRIVATE');
  const socket = args.socket;
  const frameLimit = 4096;
  let server: Server;
  let stopped = false;
  let active = Promise.resolve();
  const ui = async (expression: string): Promise<unknown> => {
    const win = args.window();
    if (!win || win.isDestroyed() || win.webContents.isLoading()) throw new Error('NEXT_TEST_WINDOW_NOT_READY');
    return Promise.race([
      win.webContents.executeJavaScript(expression, true),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('NEXT_TEST_RENDERER_TIMEOUT')), 4500))
    ]);
  };
  async function dispatch(value: unknown): Promise<unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('NEXT_TEST_INVALID_REQUEST');
    const request = value as Record<string, unknown>;
    if (typeof request.op !== 'string') throw new Error('NEXT_TEST_MISSING_OPERATION');
    if (request.op === 'ping') return {pong:true};
    if (request.op === 'ping') return {pong:true};
    if (request.op === 'status') {
      const win=args.window();
      return {ready:!!win && !win.isDestroyed() && !win.webContents.isLoading(),
        title:win?.getTitle() ?? '', hasWindow:!!win && !win.isDestroyed(),
        transport:'disabled:isolated-test'};
    }
    if (request.op === 'ui-status') return await ui(`(async () => {
      const state=await window.api.getState();
      return {ready:document.readyState==='complete' && state.ok,
        theme:document.documentElement.dataset.theme,
        hasChat:!!document.getElementById('chatInput'),
        hasGoal:!!document.getElementById('createPlan'),
        hasSettings:!!document.getElementById('workspaceSettings')};
    })()`);
    if (request.op === 'theme') {
      if (request.value !== 'dark' && request.value !== 'light') throw new Error('NEXT_TEST_INVALID_THEME');
      return await ui(`(() => {
        const wanted=${JSON.stringify(request.value)};
        if(document.documentElement.dataset.theme!==wanted)document.getElementById('themeBtn').click();
        return {theme:document.documentElement.dataset.theme};
      })()`);
    }
    if (request.op === 'outbox') return await ui(`(async()=>{
      const r=await window.api.listInputs();
      if(!r.ok)throw new Error('NEXT_TEST_INPUT_LIST_FAILED');
      return r.data.map(x=>({id:x.id,text:x.text,state:x.state,deliveredAt:x.deliveredAt??null}));
    })()`);
    if (request.op === 'send-fixture') {
      if (typeof request.text !== 'string' || request.text.length < 1 || request.text.length > 240 || !request.text.startsWith('Next CLI fixture: '))
        throw new Error('NEXT_TEST_MESSAGE_MUST_BE_MARKED_FIXTURE');
      const payload = JSON.stringify(request.text);
      return await ui(`(() => {
        if(document.getElementById('composerModel')?.value !== 'synthetic-offline-model')
          throw new Error('NEXT_TEST_REQUIRES_SYNTHETIC_MODEL');
        document.querySelector('#tabs button[data-tab="home"]').click();
        document.getElementById('newChat').click();
        const input=document.getElementById('chatInput'); input.value=${payload};
        input.dispatchEvent(new Event('input',{bubbles:true}));
        document.getElementById('composer').requestSubmit();
        return {acceptedForProcessing:true};
      })()`);
    }
    if (request.op === 'quit') {
      setImmediate(() => args.app.quit());
      return {quitting: true};
    }
    throw new Error('NEXT_TEST_UNKNOWN_OPERATION');
  }
  // Decline any pre-existing socket instead of unlinking a possible other owner.
  try { await fs.lstat(socket); throw new Error('NEXT_TEST_SOCKET_ALREADY_EXISTS'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  server = createServer(client => {
    client.setTimeout(9000, () => client.destroy());
    let incoming = '';
    client.on('data', part => {
      incoming += part.toString('utf8');
      if (incoming.length > frameLimit) { client.destroy(); return; }
      if (!incoming.includes('\n')) return;
      const raw = incoming.slice(0, incoming.indexOf('\n'));
      client.pause();
      const job = active.catch(() => undefined).then(async () => {
        let result: object;
        try { result = {ok:true, data:await dispatch(JSON.parse(raw))}; }
        catch (error) { result = {ok:false, error:error instanceof Error ? error.message.slice(0,150) : 'NEXT_TEST_FAILURE'}; }
        if (!client.destroyed) client.end(JSON.stringify(result)+'\n');
      });
      active = job;
    });
    client.on('error', () => undefined);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socket, () => { server.off('error', reject); resolve(); });
  });
  await fs.chmod(socket, 0o600);
  const shutdown = async () => {
    if (stopped) return;
    stopped=true;
    server.close();
    await fs.rm(socket, {force:true});
  };
  args.app.on('before-quit', () => { void shutdown(); });
  return shutdown;
}
