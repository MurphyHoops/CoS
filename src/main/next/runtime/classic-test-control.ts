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
import {session} from 'electron';
import {browserControl} from '../../browser-control.js';

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
    if (request.op === 'native-profile-fixture') {
      // ONLY private temporary Classic CLI HOME, never real account cookies.
      // Tests Chromium persistent Session without any request to chatgpt.com.
      const web=session.fromPath(path.join(args.userData,'browser-runtime','profile'));
      const name='cos_native_offline_fixture';
      if(request.action==='write'){
        await web.cookies.set({url:'https://chatgpt.com',name,value:'persisted-v1',
          expirationDate:Math.floor(Date.now()/1000)+86400});
        await web.cookies.flushStore();
        return {written:true};
      }
      if(request.action==='read'){
        const cookies=await web.cookies.get({url:'https://chatgpt.com',name});
        return {persistent:cookies.length===1&&cookies[0]?.value==='persisted-v1'};
      }
      throw Error('NEXT_NATIVE_PROFILE_FIXTURE_INVALID_OPERATION');
    }
    if (request.op === 'native-browser-smoke') {
      // Strict packaged TEMP HOME only. Real Classic broker and Electron
      // Chromium page, fake local HTML; no Plus login/account/model use.
      const owner='session:classic-native-fixture';
      const browsers=browserControl.browsers();
      if(browsers.length!==1||!browsers[0]?.name.includes('Native ChatGPT'))
        throw Error('NEXT_NATIVE_BROWSER_NOT_READY');
      const html='<!doctype html><html><body><h1>Classic Native Browser</h1>'+
        '<button id="click" style="position:absolute;left:60px;top:55px;width:250px;height:50px">'+
        'Verify native click</button><output id="state">idle</output>'+
        '<script>document.querySelector("#click").onclick=()=>'+
        '{document.querySelector("#state").textContent="clicked";};</script></body></html>';
      const created=await browserControl.execute('browser_tabs',
        {action:'new',browserId:browsers[0].id,url:'data:text/html,'+encodeURIComponent(html)},
        owner,null,async()=>true);
      const tabId=(created.value as {tabId?:string}|undefined)?.tabId;
      if(!tabId)throw Error('NEXT_NATIVE_BROWSER_CREATE_FAILED');
      const snap=await browserControl.execute('browser_snapshot',
        {tabId,maxNodes:120,maxChars:8000},owner,null,async()=>true);
      const result=snap.value as {text?:string;pageId?:string}|undefined;
      const ref=result?.text?.match(/\[([^\]]+)\] button "Verify native click"/)?.[1];
      if(!ref||!result?.pageId)throw Error('NEXT_NATIVE_BROWSER_SNAPSHOT_FAILED:'+JSON.stringify({error:snap.error,pageId:result?.pageId,preview:result?.text?.slice(0,250)}));
      const clicked=await browserControl.execute('browser_action',
        {tabId,pageId:result.pageId,action:'click',ref},
        owner,null,async()=>true);
      if(clicked.error)throw Error('NEXT_NATIVE_BROWSER_CLICK_'+clicked.error);
      const read=await browserControl.execute('browser_evaluate',
        {tabId,pageId:result.pageId,expression:'document.querySelector("#state").textContent'},
        owner,null,async()=>true);
      if((read.value as {value?:unknown}|undefined)?.value!=='clicked')
        throw Error('NEXT_NATIVE_BROWSER_RESULT_MISSING');
      const cross=await browserControl.execute('browser_action',
        {tabId,pageId:result.pageId,action:'click',ref},'session:other-worker',null,
        async()=>true);
      if(!cross.error?.includes('TAB_NOT_OWNED'))throw Error('NEXT_NATIVE_BROWSER_CROSS_OWNER');
      // A SECOND real Chromium Page Target shares the SAME browser Profile,
      // but has a different Worker owner and independent DOM state.
      const second=await browserControl.execute('browser_tabs',
        {action:'new',browserId:browsers[0].id,url:'data:text/html,'+encodeURIComponent(html)},
        'session:other-worker',null,async()=>true);
      const secondTab=(second.value as {tabId?:string}|undefined)?.tabId;
      if(!secondTab||secondTab===tabId)throw Error('NEXT_NATIVE_SECOND_WORKER_TAB_MISSING');
      const listed=await browserControl.execute('browser_tabs',
        {action:'list',browserId:browsers[0].id},owner,null,async()=>true);
      const tabs=(listed.value as {tabs?:Array<{tabId:string}>}|undefined)?.tabs;
      if(tabs?.length!==2||!tabs.some(t=>t.tabId===tabId)||
        !tabs.some(t=>t.tabId===secondTab))
        throw Error('NEXT_NATIVE_MULTI_TAB_LIST_INCOMPLETE');
      const snapOther=await browserControl.execute('browser_snapshot',
        {tabId:secondTab,maxNodes:120,maxChars:8000},
        'session:other-worker',null,async()=>true);
      const secondValue=snapOther.value as {text?:string;pageId?:string}|undefined;
      const otherRef=secondValue?.text?.match(/\[([^\]]+)\] button "Verify native click"/)?.[1];
      if(!otherRef||!secondValue?.pageId||secondValue.pageId===result.pageId)
        throw Error('NEXT_NATIVE_WORKER_PAGE_ID_COLLISION');
      const otherClick=await browserControl.execute('browser_action',
        {tabId:secondTab,pageId:secondValue.pageId,action:'click',ref:otherRef},
        'session:other-worker',null,async()=>true);
      if(otherClick.error)throw Error('NEXT_NATIVE_OTHER_WORKER_CLICK_FAILED');
      const noEscape=await browserControl.execute('browser_action',
        {tabId:secondTab,pageId:secondValue.pageId,action:'click',ref:otherRef},
        owner,null,async()=>true);
      if(!noEscape.error?.includes('TAB_NOT_OWNED'))
        throw Error('NEXT_NATIVE_REVERSE_WORKER_ESCAPE');
      return {classicBrowserBroker:true,webPageClick:true,
        workerIsolation:true,twoIndependentWorkerPages:true,chromeExtension:false};
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
