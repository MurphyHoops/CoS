/**
 * Temporary-profile, real packaged Electron UI roundtrip.
 * Runs only against an explicitly supplied local Next .app.
 * Does not connect a Tunnel, read real profile secrets or touch old CoS.
 *
 * Uses local Chromium DevTools ONLY for test automation. 127.0.0.1, random
 * port, isolated temporary HOME, listener terminated on exit.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import WebSocket from 'ws';

const app = process.argv[2];
if (!app?.startsWith('/') || !app.endsWith('Chat On Steroids Next.app')) {
  throw new Error('SPECIFY_BUILT_NEXT_APP_ABSOLUTE_PATH');
}
const binary = path.join(app, 'Contents/MacOS/Chat On Steroids Next');
const home = await mkdtemp(path.join(os.tmpdir(), 'cos-next-e2e-home-'));
const oldRoot = path.join(home, 'Library/Application Support/chat-on-steroids');
const nextRoot = path.join(home, 'Library/Application Support/chat-on-steroids-next');
await mkdir(oldRoot, { recursive: true, mode: 0o700 });
await mkdir(nextRoot, { recursive: true, mode: 0o700 });
const oldPayload = '{"sentinel":"old CoS untouched by Next UI test"}\n';
await writeFile(path.join(oldRoot, 'config.json'), oldPayload, { mode: 0o600 });
const originalHash = createHash('sha256').update(oldPayload).digest('hex');
let child = null;
let connection = null;
let sequence = 0;
let pending = new Map();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function randomPort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', error => error ? reject(error) : resolve()));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function waitEndpoint(port, timeout = 10000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (child?.exitCode !== null) throw new Error('CLASSIC_PACKAGED_PROCESS_EXITED_BEFORE_WINDOW');
    try {
      const response = await fetch('http://127.0.0.1:' + port + '/json/list');
      if (response.ok) {
        const targets = await response.json();
        const target = targets.find(x => x.type === 'page' && x.url?.startsWith('file://') && x.webSocketDebuggerUrl);
        if (target) return target.webSocketDebuggerUrl;
      }
    } catch { /* local renderer still starting */ }
    await delay(100);
  }
  throw new Error('CLASSIC_RENDERER_DEVTOOLS_NOT_READY');
}
async function connect(wsUrl) {
  connection = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    connection.once('open', resolve);
    connection.once('error', reject);
  });
  connection.on('message', data => {
    let result;
    try { result = JSON.parse(String(data)); } catch { return; }
    const next = pending.get(result.id);
    if (!next) return;
    pending.delete(result.id);
    if (result.error) next.reject(new Error('CHROMIUM_DEVTOOLS_ERROR:' + result.error.code));
    else next.resolve(result.result);
  });
}
async function rpc(method, params={}) {
  const id = ++sequence;
  return await new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    connection.send(JSON.stringify({ id, method, params }), error => {
      if (error) { pending.delete(id); reject(error); }
    });
  });
}
async function evaluate(expression) {
  const r = await rpc('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('RENDERER_EXPRESSION_FAILED');
  return r.result?.value;
}
async function boot() {
  const port = await randomPort();
  child = spawn(binary, ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port='+port], {
    env: { ...process.env, HOME: home, COS_NEXT_E2E_TEMP_PROFILE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'], detached: false
  });
  child.stdout?.resume(); child.stderr?.resume();
  const url = await waitEndpoint(port);
  await connect(url);
  await rpc('Runtime.enable');
  const until = Date.now()+9000;
  while (Date.now() < until) {
    const ready = await evaluate("Boolean(document.getElementById('themeBtn') && document.getElementById('workspaceSettings') && document.getElementById('createPlan'))");
    if (ready) {
      // The static HTML appears before the first typed IPC state hydration.
      // Wait for the actual renderer to finish reading its initial state.
      for (let attempt=0; attempt<80; attempt++) {
        const stateReady = await evaluate("(async()=>{const r=await window.api.getState(); return r.ok && !!r.data?.config?.ui?.theme})()");
        if (stateReady) { await delay(600); return; }
        await delay(100);
      }
    }
    await delay(100);
  }
  throw new Error('CLASSIC_CHAT_UI_NOT_READY');
}
async function stop() {
  connection?.close(); connection=null;
  if (!child) return;
  const target = child; child=null;
  if (target.exitCode === null && target.signalCode === null) target.kill('SIGTERM');
  for (let i=0;i<35;i++) {
    if (target.exitCode !== null || target.signalCode !== null) break;
    await delay(100);
  }
  // The test profile explicitly forbids a Tunnel. Only terminate OUR child.
  if (target.exitCode === null && target.signalCode === null) target.kill('SIGKILL');
  await delay(150);
  pending=new Map();
}
try {
  await boot();
  const initial = await evaluate("document.documentElement.dataset.theme");
  const appName = await evaluate("document.title");
  if (!/Chat On Steroids/.test(appName)) throw new Error('NOT_CLASSIC_UI');
  const required = await evaluate("['newChat','createPlan','workspaceSettings','connectBtn','chatSettingsBtn','sidebar'].every(x=>!!document.getElementById(x))");
  if (!required) throw new Error('MISSING_LEGACY_CHAT_GOAL_OR_SETUP_UI');
  await evaluate("document.getElementById('workspaceSettings').click()");
  const tabs = await evaluate("[...document.querySelectorAll('#tabs button[data-tab]')].map(x=>x.dataset.tab)");
  if (!tabs.includes('settings') || !tabs.includes('home') || !tabs.includes('setup'))
    throw new Error('MISSING_PROJECT_SETTINGS_TABS');
  await evaluate("document.querySelector('#tabs button[data-tab=settings]').click()");
  await evaluate("document.getElementById('themeBtn').click()");
  const selected = await evaluate("document.documentElement.dataset.theme");
  console.log('NEXT_GUI_THEME_INTERACTION=' + (selected !== initial ? 'CHANGED' : 'UNHANDLED'));
  const until=Date.now()+5000;
  let savedTheme;
  while (Date.now()<until) {
    try {
      const cfg=JSON.parse(await readFile(path.join(nextRoot,'config.json'),'utf8'));
      if (cfg.ui?.theme && cfg.ui.theme !== initial) { savedTheme=cfg.ui.theme; break; }
    } catch {}
    await delay(100);
  }
  if (!savedTheme) {
    const presence = await readFile(path.join(nextRoot,'config.json'),'utf8').then(()=> 'YES',()=> 'NO');
    console.log('NEXT_GUI_ISOLATED_CONFIG_PRESENT=' + presence);
    throw new Error('REAL_UI_THEME_SETTING_WAS_NOT_SAVED');
  }
  console.log('NEXT_CLASSIC_GUI_NAVIGATION=PASS');
  console.log('NEXT_CLASSIC_GUI_GOAL_CHAT_SETTINGS_PRESENT=PASS');
  console.log('NEXT_CLASSIC_GUI_SETTING_IPC_WRITE=PASS');
  await stop();

  await boot();
  const reloaded=await evaluate("document.documentElement.dataset.theme");
  if (reloaded!==savedTheme) throw new Error('REAL_UI_THEME_SETTING_DID_NOT_SURVIVE_RESTART');
  console.log('NEXT_CLASSIC_GUI_RESTART_ROUNDTRIP=PASS');
  await stop();
  const afterHash=createHash('sha256').update(await readFile(path.join(oldRoot,'config.json'))).digest('hex');
  if (afterHash!==originalHash) throw new Error('ORIGINAL_PROFILE_MODIFIED');
  console.log('NEXT_CLASSIC_GUI_OLD_PROFILE_UNMODIFIED=PASS');
  console.log('NEXT_CLASSIC_GUI_TEMP_PROFILE=PASS');
} finally {
  await stop();
  await rm(home,{ recursive:true, force:true });
}
