/**
 * CoS Next: optional local Codex app-server STDIO JSONL transport.
 *
 * There is NO web scraping, browser automation, API key auto-migration,
 * implicit chargeable API fallback or automatic ChatGPT web turn continuation.
 * An approved official ChatGPT OAuth access token must be provisioned in the
 * native process and the Codex binary installed separately before use.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import readline from 'node:readline';
import path from 'node:path';

interface Pending { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
const MAX_LINE = 1024 * 1024;
const MAX_PENDING = 32;
const TIMEOUT = 30_000;
function record(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === 'object' && !Array.isArray(x);
}
function textId(x: unknown): string | null { return typeof x === 'string' && x.length >= 1 && x.length <= 128 ? x : null; }
export type TurnStatus = 'completed' | 'interrupted' | 'failed';
export type TurnReceipt = { threadId: string; turnId: string; status: TurnStatus };

export class CodexAppServerClient {
  private child: ChildProcess | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly turnDone = new Map<string, { resolve: (result: TurnReceipt) => void; reject: (error: Error) => void }>();
  private readonly recentCompleted = new Map<string, TurnReceipt>();
  private exitError: Error | null = null;
  private closing = false;

  constructor(
    private readonly binary: string,
    private readonly cwd: string,
    private readonly oauthToken: string,
    private readonly onNotification?: (method: string) => void,
    private readonly testArgs?: readonly string[]
  ) {
    if (!path.isAbsolute(binary) || !path.isAbsolute(cwd) ||
        !oauthToken || oauthToken.length > 16_384 ||
        (testArgs !== undefined && process.env.NODE_ENV !== 'test'))
      throw new Error('CODEX_STARTUP_NOT_AUTHORIZED');
  }

  private send(value: unknown): void {
    if (!this.child?.stdin?.writable || this.exitError) throw new Error('CODEX_TRANSPORT_CLOSED');
    const encoded = JSON.stringify(value);
    if (encoded.length > MAX_LINE) throw new Error('CODEX_REQUEST_TOO_LARGE');
    this.child.stdin.write(encoded + '\n');
  }

  private receive(line: string): void {
    if (line.length > MAX_LINE) { this.failAll('CODEX_MESSAGE_TOO_LARGE'); return; }
    let msg: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!record(parsed)) throw new Error('not object');
      msg = parsed;
    } catch { this.failAll('CODEX_BAD_JSON'); return; }
    if (typeof msg.id === 'number' && typeof msg.method !== 'string') {
      const queued = this.pending.get(msg.id);
      if (!queued) return;
      clearTimeout(queued.timer);
      this.pending.delete(msg.id);
      if (record(msg.error)) queued.reject(new Error('CODEX_REQUEST_REJECTED'));
      else queued.resolve(msg.result);
      return;
    }
    if (typeof msg.method !== 'string') return;
    // Server-initiated approval requests require OS decisions. This adapter
    // has not implemented that trusted UI, so it declines all such requests.
    if (typeof msg.id === 'number') {
      try {
        this.send({ id: msg.id, result: { decision: 'decline' } });
      } catch { this.failAll('CODEX_APPROVAL_CHANNEL_FAILED'); }
      return;
    }
    this.onNotification?.(msg.method);
    if (msg.method === 'turn/completed' && record(msg.params)) {
      const turn = record(msg.params.turn) ? msg.params.turn : null;
      const threadId = textId(msg.params.threadId);
      const turnId = textId(turn?.id);
      const status = turn?.status;
      if (!threadId || !turnId ||
          !['completed', 'interrupted', 'failed'].includes(String(status))) return;
      const receipt: TurnReceipt = { threadId, turnId, status: status as TurnStatus };
      const key = threadId + '\0' + turnId;
      const waiter = this.turnDone.get(key);
      if (waiter) { this.turnDone.delete(key); waiter.resolve(receipt); }
      else {
        this.recentCompleted.set(key, receipt);
        if (this.recentCompleted.size > 64) {
          this.recentCompleted.delete(this.recentCompleted.keys().next().value!);
        }
      }
    }
  }

  private failAll(code: string): void {
    if (this.exitError) return;
    this.exitError = new Error(code);
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer); p.reject(this.exitError);
      this.pending.delete(id);
    }
    for (const waiter of this.turnDone.values()) waiter.reject(this.exitError);
    this.turnDone.clear();
  }

  private request(method: string, params: Record<string, unknown>, timeoutMs = TIMEOUT): Promise<unknown> {
    if (this.pending.size >= MAX_PENDING || this.exitError) return Promise.reject(new Error('CODEX_NOT_READY'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('CODEX_REQUEST_TIMEOUT'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ method, id, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  async start(): Promise<void> {
    if (this.child) throw new Error('CODEX_ALREADY_STARTED');
    this.child = spawn(this.binary, this.testArgs ? [...this.testArgs] : [
      'app-server', '--listen', 'stdio://',
      '-c', 'model_provider="openai_chatgpt_plan"',
      '-c', 'model_providers.openai_chatgpt_plan.name="ChatGPT plan"',
      '-c', 'model_providers.openai_chatgpt_plan.base_url="https://api.openai.com/v1"',
      '-c', 'model_providers.openai_chatgpt_plan.env_key="ACCESS_TOKEN"',
      '-c', 'model_providers.openai_chatgpt_plan.wire_api="responses"',
      '-c', 'model_providers.openai_chatgpt_plan.requires_openai_auth=false',
      '-c', 'model_providers.openai_chatgpt_plan.supports_websockets=false'
    ], {
      cwd: this.cwd,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
      env: { PATH: process.env.PATH ?? '', ACCESS_TOKEN: this.oauthToken }
    });
    this.child.on('error', () => this.failAll('CODEX_PROCESS_ERROR'));
    this.child.on('close', () => this.failAll('CODEX_PROCESS_EXITED'));
    const lines = readline.createInterface({ input: this.child.stdout!, crlfDelay: Infinity });
    lines.on('line', line => this.receive(line));
    const result = await this.request('initialize', {
      clientInfo: { name: 'cos-next', title: 'CoS Next', version: '4.0.0-alpha.0' }
    });
    if (!record(result)) throw new Error('CODEX_HANDSHAKE_INVALID');
    this.send({ method: 'initialized' });
  }

  async startThread(): Promise<string> {
    const response = await this.request('thread/start', {
      cwd: this.cwd, approvalPolicy: 'never', sandbox: 'readOnly'
    });
    if (!record(response) || !record(response.thread)) throw new Error('CODEX_THREAD_INVALID');
    const id = textId(response.thread.id);
    if (!id) throw new Error('CODEX_THREAD_INVALID');
    return id;
  }

  async runTurn(threadId: string, text: string, timeoutMs = 120_000): Promise<TurnReceipt> {
    if (!textId(threadId) || typeof text !== 'string' || !text.length ||
        text.length > 128 * 1024 || timeoutMs < 1_000 || timeoutMs > 600_000) {
      throw new Error('CODEX_TURN_INVALID');
    }
    const response = await this.request('turn/start', {
      threadId, input: [{ type: 'text', text }],
      cwd: this.cwd, approvalPolicy: 'never',
      sandboxPolicy: { type: 'readOnly', access: {
        type: 'restricted', includePlatformDefaults: true, readableRoots: [this.cwd]
      } }
    });
    if (!record(response) || !record(response.turn)) throw new Error('CODEX_TURN_START_AMBIGUOUS');
    const turnId = textId(response.turn.id);
    if (!turnId) throw new Error('CODEX_TURN_START_AMBIGUOUS');
    const key = threadId + '\0' + turnId;
    const earlier = this.recentCompleted.get(key);
    if (earlier) { this.recentCompleted.delete(key); return earlier; }
    return await new Promise<TurnReceipt>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.turnDone.delete(key);
        reject(new Error('CODEX_TURN_OUTCOME_UNKNOWN'));
      }, timeoutMs);
      timer.unref?.();
      this.turnDone.set(key, {
        resolve: receipt => { clearTimeout(timer); resolve(receipt); },
        reject: error => { clearTimeout(timer); reject(error); }
      });
    });
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.failAll('CODEX_STOPPED');
    this.child?.kill('SIGTERM');
  }
}
