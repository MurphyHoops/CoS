/**
 * Standalone CoS Next *local-only* Electron entrypoint.
 *
 * This app intentionally does not import the old app's index.ts, browser
 * companion, bridge, old Goal/Agent authority, old config or auto-connect.
 * G1b/G2b not proven => no remote MCP/tunnel/model controls are published.
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { app, dialog, Menu } from 'electron';
import { NextLocalRuntime } from './local-runtime.js';
import { serveNextMcpLoopback } from './mcp-loopback.js';
import { connectImportedCoreTunnel, type ImportedCoreTunnel } from './imported-core-tunnel.js';
import { defaultNextUserData } from './writer.js';
import { NextNativeApprovalBroker } from '../auth/native-approval.js';
import { initSecretsPath, secureStorageStatus, hasSecret } from '../../secrets.js';
import type { MissionLeaseAuthority } from '../auth/mission-leases.js';
import type { LocalAdministrator, LocalVerifier } from '../mission/kernel.js';

const dataDir = defaultNextUserData();
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
app.setName('Chat On Steroids Next');
app.setPath('userData', dataDir);
const isPrimary = app.requestSingleInstanceLock();
if (!isPrimary) app.quit();

let runtime: NextLocalRuntime | null = null;
let mcp: Awaited<ReturnType<typeof serveNextMcpLoopback>> | null = null;
let importedCoreTunnel: ImportedCoreTunnel | null = null;
let connectingImportedCore = false;
let shuttingDown = false;
let fullyClosed = false;
const descriptions = new Map<string, string>();
const approvals = new NextNativeApprovalBroker(async (operation, scope) => {
  const what = descriptions.get(scope) || scope;
  const result = await dialog.showMessageBox({
    type: 'warning',
    title: 'CoS Next — local operator approval',
    message: 'Approve ' + operation + ' for this local object?',
    detail: what + '\n\nThis does not authorize any ChatGPT conversation or AI model.',
    buttons: ['Deny', 'Approve once'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  });
  return result.response === 1;
});
const authority: MissionLeaseAuthority = {
  // Host OAuth and verified ChatGPT session have NOT passed the G1b/G2b
  // production gate. Do not treat arbitrary MCP _meta as authenticated.
  authenticate: async () => null,
  confirmApproval: async (ticket, operation, missionId) =>
    approvals.consume(ticket, operation, missionId)
};
const admin: LocalAdministrator = {
  approve: async (ticket, operation, scope) => approvals.consume(ticket, operation, scope)
};
const verifier: LocalVerifier = {
  // The local machine-verifier and Codex executor are not yet installed.
  verifyEffect: async () => false,
  verifyWait: async () => false,
  verifyContinuation: async () => false,
  verifyCompletion: async () => false,
  verifyWorkerClaim: async () => false,
  verifyWorkerReport: async () => false,
  verifyWorkerReconciliation: async () => false
};

async function showStatus(): Promise<void> {
  const h = runtime?.health;
  const storage = await secureStorageStatus();
  await dialog.showMessageBox({
    type: h?.state === 'READY' ? 'info' : 'warning',
    title: 'CoS Next — status',
    message: 'CoS Next local runtime: ' + (h?.state ?? 'NOT_STARTED'),
    detail: [
      'Mission journal: ' + (h?.mission ?? 'NEW'),
      'Lease state: ' + (h?.leases ?? 'new'),
      'Encrypted OS storage: ' + (storage.available ? 'available' : 'unavailable'),
      'ChatGPT MCP: ' + (importedCoreTunnel?.state === 'CONNECTED'
        ? 'IMPORTED CORE TUNNEL CONNECTED (READ-ONLY)'
        : 'local-only; imported Tunnel disconnected'),
      'Remote Mission authority: DISABLED (G2b pending)',
      'Model inference: DISABLED — no extra API billing',
      'Chrome companion: NOT REQUIRED for this local runtime',
      'Original CoS data: UNCHANGED'
    ].join('\n'),
    buttons: ['Close']
  });
}

async function chooseProject(): Promise<void> {
  if (!runtime || runtime.health.state !== 'READY') {
    await showStatus();
    return;
  }
  const selected = await dialog.showOpenDialog({
    title: 'Choose a project directory for CoS Next only',
    properties: ['openDirectory']
  });
  const folder = selected.filePaths[0];
  if (selected.canceled || !folder) return;
  const canonical = await fs.realpath(folder);
  const projectId = 'project-' + randomUUID();
  descriptions.set(projectId, 'Project directory: ' + canonical);
  try {
    const ticket = await approvals.request('project', projectId);
    if (!ticket) return;
    const project = await runtime.mission.provisionProject(projectId, canonical, ticket);
    await dialog.showMessageBox({
      type: 'info',
      message: 'Project registered locally',
      detail: project.projectId + '\n' + project.canonicalRoot +
        '\n\nNo ChatGPT, agent, command or Tunnel access was granted.',
      buttons: ['Close']
    });
  } catch {
    await dialog.showMessageBox({
      type: 'error', message: 'Project registration was denied or could not be saved.',
      buttons: ['Close']
    });
  } finally {
    descriptions.delete(projectId);
  }
}
async function localCatalog(): Promise<Awaited<ReturnType<NextLocalRuntime['mission']['adminCatalog']>> | null> {
  if (!runtime || !['READY', 'REAPPROVAL_REQUIRED'].includes(runtime.health.state)) return null;
  const ticket = await approvals.request('browse', 'local-registry');
  if (!ticket) return null;
  return await runtime.mission.adminCatalog(ticket);
}
async function showProjects(): Promise<void> {
  const catalog = await localCatalog();
  if (!catalog) return;
  const projects = catalog.projects.slice(0, 30).map(p =>
    path.basename(p.canonicalRoot) + ' / ' + p.projectId + '\n' + p.canonicalRoot);
  const missions = catalog.missions.slice(0, 30).map(m =>
    m.missionId + ': ' + m.state + ' (epoch ' + m.epoch + ', rev ' + m.revision + ')');
  await dialog.showMessageBox({
    type: 'info', title: 'CoS Next local projects',
    message: catalog.projects.length + ' projects / ' + catalog.missions.length + ' Missions',
    detail: ['Projects:', ...projects, '', 'Missions:', ...missions,
      '\nLocal catalog only. No ChatGPT session has been authorized.'].join('\n').slice(0, 8_000),
    buttons: ['Close']
  });
}
async function createLocalMission(): Promise<void> {
  const catalog = await localCatalog();
  if (!catalog || !runtime) return;
  if (catalog.projects.length === 0) {
    await dialog.showMessageBox({ message: 'Register a project directory first.', buttons: ['Close'] });
    return;
  }
  const projectOptions = catalog.projects.slice(0, 8);
  const select = await dialog.showMessageBox({
    title: 'CoS Next — choose project', message: 'Choose the locally registered Project for this Mission',
    buttons: [...projectOptions.map(p => path.basename(p.canonicalRoot)), 'Cancel'],
    cancelId: projectOptions.length,
    defaultId: projectOptions.length
  });
  const project = projectOptions[select.response];
  if (!project) return;
  const templates = [
    { label: 'Local build + tests + review', checks: ['build', 'tests', 'review'] },
    { label: 'GitHub CI + evidence ledger + review', checks: ['ci', 'ledger', 'review'] },
    { label: 'Artifact + review', checks: ['artifact', 'review'] }
  ];
  const contract = await dialog.showMessageBox({
    title: 'CoS Next — completion contract',
    message: 'Required evidence for this Mission',
    detail: 'The app will not mark any check as passed without an independently authorized verifier.',
    buttons: [...templates.map(t => t.label), 'Cancel'],
    cancelId: templates.length,
    defaultId: templates.length
  });
  const selected = templates[contract.response];
  if (!selected) return;
  const missionId = 'mission-' + randomUUID();
  descriptions.set(missionId, 'Project: ' + project.canonicalRoot +
    '\nCompletion checks: ' + selected.checks.join(', '));
  try {
    const ticket = await approvals.request('create', missionId);
    if (!ticket) return;
    const mission = await runtime.mission.provisionMission(project.projectId, missionId,
      selected.checks, ticket);
    await dialog.showMessageBox({
      type: 'info', title: 'CoS Next — Mission created',
      message: 'Local Mission stored. No inference or remote execution was started.',
      detail: mission.missionId + '\nProject: ' + project.canonicalRoot +
        '\nRequired checks: ' + mission.completionChecks.join(', '),
      buttons: ['Close']
    });
  } catch {
    await dialog.showMessageBox({ type: 'error', message: 'Mission creation was refused or could not be committed.',
      buttons: ['Close'] });
  } finally { descriptions.delete(missionId); }
}

async function connectImportedCoreFromMenu(): Promise<void> {
  if (connectingImportedCore || importedCoreTunnel) {
    await showStatus(); return;
  }
  if (!runtime || !mcp || runtime.health.state !== 'READY') {
    await showStatus(); return;
  }
  const ticket = await approvals.request('tunnel', 'core');
  if (!ticket || !(await approvals.consume(ticket, 'tunnel', 'core'))) return;
  connectingImportedCore = true;
  try {
    const tunnel = await connectImportedCoreTunnel(runtime, mcp.endpointUrl,
      path.join(dataDir, 'config.json'));
    importedCoreTunnel = tunnel;
    const ready = await tunnel.connected;
    if (!ready) {
      const stopped = await tunnel.stopWithProof();
      if (!stopped) throw new Error('IMPORT_TUNNEL_SHUTDOWN_UNVERIFIED');
      importedCoreTunnel = null;
      await dialog.showMessageBox({
        type: 'warning', title: 'CoS Next — Tunnel not connected',
        message: 'The original Core Tunnel could not be verified as connected.',
        detail: 'The original CoS configuration has not been changed. Check the network and account status.',
        buttons: ['Close']
      });
      return;
    }
    await dialog.showMessageBox({
      type: 'info', title: 'CoS Next — Core Tunnel connected',
      message: 'Next now owns the imported Core Tunnel.',
      detail: 'Only read-only health and identity diagnostics are exposed. ' +
        'Mission, Agent, command and autonomous ChatGPT continuation remain disabled.',
      buttons: ['Close']
    });
  } catch {
    await dialog.showMessageBox({
      type: 'error', title: 'CoS Next — connection blocked',
      message: 'Core Tunnel connection was denied or could not establish exclusive ownership.',
      detail: 'Close the old CoS and verify no legacy tunnel process is running before retrying.',
      buttons: ['Close']
    });
  } finally { connectingImportedCore = false; }
}
async function disconnectImportedCoreFromMenu(): Promise<void> {
  if (!importedCoreTunnel) return;
  const stopped = await importedCoreTunnel.stopWithProof();
  if (!stopped) {
    await dialog.showMessageBox({ type: 'error',
      message: 'Unable to verify Tunnel shutdown. The Next connection remains blocked.',
      buttons: ['Close'] });
    return;
  }
  importedCoreTunnel = null;
  await showStatus();
}

function installMenu(): void {
  const items: Electron.MenuItemConstructorOptions[] = [
    { label: 'Show local runtime status', click: () => { void showStatus(); } },
    { label: 'Register project directory…', click: () => { void chooseProject(); } },
    { label: 'Show local projects and Missions…', click: () => { void showProjects(); } },
    { label: 'Create local Mission…', click: () => { void createLocalMission(); } },
    { type: 'separator' },
    { label: 'Connect imported Core Tunnel…', click: () => { void connectImportedCoreFromMenu(); } },
    { label: 'Disconnect imported Core Tunnel', click: () => { void disconnectImportedCoreFromMenu(); } },
    { type: 'separator' },
    { label: 'Quit CoS Next', click: () => app.quit() }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate([{
    label: 'CoS Next', submenu: items
  }]));
}

app.on('before-quit', (event) => {
  if (!isPrimary || fullyClosed) return;
  event.preventDefault();
  if (shuttingDown) return;
  shuttingDown = true;
  void (async () => {
    try {
      if (importedCoreTunnel) {
        const disconnected = await importedCoreTunnel.stopWithProof();
        if (!disconnected) throw new Error('TUNNEL_SHUTDOWN_UNVERIFIED');
        importedCoreTunnel = null;
      }
      await mcp?.close(); // Drain local MCP before releasing any durable writer.
      mcp = null;
      await runtime?.stop();
    } catch {
      // Do not exit and abandon a possibly detached tunnel-client. Retain the
      // Next writer lock and request operator intervention.
      shuttingDown = false;
      await dialog.showMessageBox({
        type: 'error', title: 'CoS Next — shutdown held',
        message: 'The Tunnel or local writer could not be proven stopped.',
        detail: 'App remains running to preserve ownership. Resolve the process before quitting.',
        buttons: ['Close']
      });
      return;
    }
    fullyClosed = true;
    app.quit();
  })();
});

void app.whenReady().then(async () => {
  if (!isPrimary) return;
  installMenu();
  runtime = new NextLocalRuntime({ userData: dataDir, authority, admin, verifier });
  try {
    await runtime.start();
    initSecretsPath(dataDir); // This app's encrypted store path; never old CoS.
    if (runtime.health.state === 'READY' || runtime.health.state === 'REAPPROVAL_REQUIRED') {
      // Public route remains loopback-only and advertises only two read-only tools.
      // No remote ChatGPT Tunnel or browser Companion is opened.
      mcp = await serveNextMcpLoopback({ runtime });
    }
  } catch {
    await dialog.showMessageBox({
      type: 'error', title: 'CoS Next — startup blocked',
      message: 'A local writer already owns this runtime, or its recovery state is unsafe.',
      detail: 'Old CoS was not modified. Inspect the Next-only lock and storage before retrying.',
      buttons: ['Close']
    });
  }
  // Explicit operator-only imported Tunnel integration probe, always scoped to
  // the read-only Next MCP endpoint. Never starts automatically in normal use.
  if (process.env.COS_NEXT_TUNNEL_VERIFY === '1') {
    let success = false;
    try {
      if (!mcp || !runtime || runtime.health.state !== 'READY')
        throw new Error('NEXT_RUNTIME_NOT_READY');
      const tunnel = await connectImportedCoreTunnel(runtime, mcp.endpointUrl,
        path.join(dataDir, 'config.json'));
      importedCoreTunnel = tunnel;
      success = await tunnel.connected;
      console.log('NEXT_IMPORTED_TUNNEL_CONNECTED=' + (success ? 'YES' : 'NO'));
      console.log('NEXT_IMPORTED_TUNNEL_FINAL_STATE=' + tunnel.state.toLowerCase());
      const stopped = await tunnel.stopWithProof();
      console.log('NEXT_IMPORTED_TUNNEL_STOP_VERIFIED=' + (stopped ? 'YES' : 'NO'));
      if (!stopped) success = false;
      else importedCoreTunnel = null;
    } catch {
      console.log('NEXT_IMPORTED_TUNNEL_TEST=BLOCKED');
    }
    try { await mcp?.close(); await runtime?.stop(); }
    catch { success = false; console.log('NEXT_IMPORTED_TUNNEL_CLEANUP=UNVERIFIED'); }
    fullyClosed = true;
    console.log('NEXT_IMPORTED_TUNNEL_TEST=' + (success ? 'PASS' : 'HOLD'));
    app.exit(success && runtime?.health.state === 'STOPPED' ? 0 : 1);
    return;
  }
  // Operator requested encrypted legacy credential import verification.
  // No secret value is exported, printed, transmitted, or persisted in plaintext.
  if (process.env.COS_NEXT_IMPORT_VERIFY === '1') {
    const storage = await secureStorageStatus();
    const available = storage.available;
    const usable = available && await hasSecret('openaiApiKey');
    console.log('NEXT_IMPORTED_OS_STORAGE=' + (available ? 'AVAILABLE' : 'UNAVAILABLE'));
    console.log('NEXT_IMPORTED_CONTROL_PLANE_CREDENTIAL=' + (usable ? 'READABLE' : 'UNAVAILABLE'));
    try { await mcp?.close(); await runtime?.stop(); } catch { /* fail closed */ }
    fullyClosed = true;
    app.exit(usable && runtime?.health.state === 'STOPPED' ? 0 : 1);
    return;
  }
  // Explicit local-only packaged smoke. No remote call or interactive dialog.
  if (process.env.COS_NEXT_LOCAL_SMOKE === '1') {
    const h = runtime.health;
    let ok = h.state === 'READY' || h.state === 'REAPPROVAL_REQUIRED';
    if (ok && mcp) {
      // End-to-end MCP HTTP smoke through the actual packaged app listener.
      const reply = await fetch(mcp.endpointUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/list' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list',
          params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': {} } } })
      });
      const raw = await reply.text();
      ok = reply.ok && raw.includes('identity_diagnostics') &&
        raw.includes('runtime_health') && !raw.includes('\"name\":\"mission\"');
    } else ok = false;
    console.log('COS_NEXT_SMOKE=' + (ok ? 'PASS' : 'HOLD') +
      ';state=' + h.state + ';mcp=' + (mcp ? 'LOOPBACK_READ_ONLY' : 'OFF') +
      ';connector=' + h.connector + ';model=' + h.model);
    try { await mcp?.close(); await runtime.stop(); }
    catch { ok = false; console.log('COS_NEXT_SMOKE_SHUTDOWN_BLOCKED'); }
    fullyClosed = true;
    app.exit(ok && runtime.health.state === 'STOPPED' ? 0 : 1);
    return;
  }
  await showStatus();
});
