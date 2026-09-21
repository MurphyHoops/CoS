/** Explicit desktop sends bring up the existing connection/browser authorities. */
import { connect } from '../connection.js';
import {
  onProviderTransportChange,
  providerTransportReady,
  waitForProviderTransport
} from './connectivity.js';
import { startBridge } from '../bridge.js';
import { wakeBrowserUrl, resetBrowserStartupForTests } from '../browser-startup.js';
import { getConfig } from '../config.js';
import { enqueueInput, cancelInput, listInputs, noteInputStartupError, type InputArgs, type InputEntry } from './input.js';

function wakeBrowser(entry: InputEntry, retry = false): Promise<void> {
  const marker = `cos-input=${encodeURIComponent(entry.id)}`;
  return wakeBrowserUrl(entry.conversationId ? `https://chatgpt.com/c/${encodeURIComponent(entry.conversationId)}` : `https://chatgpt.com/?${marker}#${marker}`, retry, getConfig().ui.backgroundChats === true);
}
async function ready(signal?: AbortSignal): Promise<void> {
  await connect();
  signal?.throwIfAborted();
  // ConnectionStatus is the one transport authority. A confirmed/transient outage is waiting,
  // not browser failure: accepted input remains durable and this background task simply resumes
  // when the provider transport is ready. Explicit setup/auth failures still reject immediately.
  await waitForProviderTransport(signal);
  signal?.throwIfAborted();
  if (!await startBridge()) throw new Error('The browser bridge could not start.');
  signal?.throwIfAborted();
}
async function deliver(entry: InputEntry, retry = false): Promise<InputEntry> {
  try {
    await wakeBrowser(entry, retry);
    return await noteInputStartupError(entry.id, null) ?? entry;
  } catch (error) {
    return await noteInputStartupError(entry.id, `Message queued. Browser startup failed: ${(error as Error).message}`) ?? entry;
  }
}
// Only transient startup work lives here; the outbox owns accepted messages.
const starting = new Map<string, AbortController>();
let stopped = false;
let transportSubscription: (() => void) | null = null;
let reconnectScan: Promise<void> | null = null;

function retryEligible(entry: InputEntry | undefined): entry is InputEntry {
  return !!entry && entry.state === 'queued' && entry.purpose !== 'decision' &&
    !!(entry.error?.startsWith('Message queued. Browser startup failed:') ||
       entry.error?.startsWith('Local chat setup failed:'));
}

async function retryQueuedAfterTransportReady(): Promise<void> {
  if (stopped || !providerTransportReady()) return;
  if (reconnectScan) return reconnectScan;
  reconnectScan = (async () => {
    // One UUID, one durable queue row. Reconnect only re-attempts browser delivery and never
    // re-enqueues authored input. Bound the scan so a corrupted/ancient queue cannot monopolize
    // the reconnect event; the next status transition or explicit Retry can handle the rest.
    const candidates = (await listInputs()).filter(retryEligible).slice(0, 50);
    for (const entry of candidates) {
      if (stopped || !providerTransportReady()) break;
      if (!starting.has(entry.id)) await retryQueuedInputBrowser(entry.id);
    }
  })().finally(() => { reconnectScan = null; });
  return reconnectScan;
}

export function startInputStartupRuntime(): void {
  if (stopped) stopped = false;
  if (!transportSubscription) {
    transportSubscription = onProviderTransportChange(({ after }) => {
      if (after.phase === 'ready') void retryQueuedAfterTransportReady();
    });
  }
  if (providerTransportReady()) void retryQueuedAfterTransportReady();
}
export async function cancelDesktopInput(id: string): Promise<boolean> {
  const start = starting.get(id);
  start?.abort(new Error('Input cancelled'));
  return await cancelInput(id) || !!start;
}
async function startAcceptedInput(entry: InputEntry, controller: AbortController): Promise<void> {
  try {
    await ready(controller.signal);
    controller.signal.throwIfAborted();
    const current = (await listInputs()).find(row => row.id === entry.id);
    controller.signal.throwIfAborted();
    if (current?.state === 'queued') await deliver(current);
  } catch (error) {
    if (!controller.signal.aborted) await noteInputStartupError(entry.id,
      'Message queued. Browser startup failed: ' + (error as Error).message);
  } finally {
    if (starting.get(entry.id) === controller) starting.delete(entry.id);
  }
}
export async function sendDesktopInput(input: InputArgs): Promise<InputEntry> {
  if (stopped) throw new Error('The app is shutting down');
  if (input.mode === 'finish' || starting.has(input.id)) return enqueueInput(input);
  const controller = new AbortController(); starting.set(input.id, controller);
  try {
    const entry = await enqueueInput(input);
    if (controller.signal.aborted) { await cancelInput(input.id); controller.signal.throwIfAborted(); }
    if (entry.state !== 'queued' || entry.transportIntent === 'tool' || entry.attachmentDelivery === 'tool') {
      starting.delete(input.id); return entry;
    }
    // Return after durable admission, not after connection startup or native delivery.
    void startAcceptedInput(entry, controller).catch(() => undefined);
    return entry;
  } catch (error) {
    if (starting.get(input.id) === controller) starting.delete(input.id);
    throw error;
  }
}
export function stopInputStartup(): void {
  stopped = true;
  transportSubscription?.();
  transportSubscription = null;
  reconnectScan = null;
  for (const controller of starting.values()) controller.abort(new Error('The app is shutting down'));
  starting.clear();
}
export async function retryQueuedInputBrowser(id: string): Promise<InputEntry | null> {
  if (stopped || starting.has(id)) return null;
  if (!retryEligible((await listInputs()).find(entry => entry.id === id)) || stopped || starting.has(id)) return null;
  const controller = new AbortController(); starting.set(id, controller);
  try {
    const repaired = await noteInputStartupError(id, null);
    if (repaired?.error?.startsWith('Local chat setup failed:')) return repaired;
    await ready(controller.signal);
    const entry = (await listInputs()).find(row => row.id === id);
    controller.signal.throwIfAborted();
    return entry?.state === 'queued' ? await deliver(entry, true) : null;
  } catch (error) {
    if (controller.signal.aborted) return null;
    return await noteInputStartupError(id, 'Message queued. Browser startup failed: ' + (error as Error).message);
  } finally { if (starting.get(id) === controller) starting.delete(id); }
}
export function resetInputStartupForTests(): void {
  stopInputStartup();
  stopped = false;
  reconnectScan = null;
  resetBrowserStartupForTests();
}
