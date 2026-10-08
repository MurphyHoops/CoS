// No network and no inference. Simulates official Codex app-server JSONL messages.
import readline from 'node:readline';
const reader = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
let started = false;
let thread = null;
let turnIndex = 0;
const pendingApproval = new Map();
reader.on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    started = true;
    send({ id: msg.id, result: { userAgent: 'fake-codex-app-server' } });
    return;
  }
  if (msg.method === 'initialized') return;
  if (msg.method === 'thread/start') {
    if (msg.params?.approvalPolicy !== 'never' || msg.params?.sandbox !== 'readOnly') {
      send({ id: msg.id, error: { message: 'unsafe policy' } }); return;
    }
    if (!started) { send({ id: msg.id, error: { message: 'not initialized' } }); return; }
    thread = 'fake-thread-1';
    send({ id: msg.id, result: { thread: { id: thread } } });
    return;
  }
  if (msg.method === 'turn/start') {
    if (msg.params?.approvalPolicy !== 'never' || msg.params?.sandboxPolicy?.type !== 'readOnly') {
      send({ id: msg.id, error: { message: 'unsafe turn sandbox' } }); return;
    }
    const turnId = 'turn-' + ++turnIndex;
    const raw = String(msg.params?.input?.[0]?.text ?? '');
    const status = raw.includes('[failed]') ? 'failed' :
      raw.includes('[interrupted]') ? 'interrupted' : 'completed';
    const done = () => send({ method: 'turn/completed',
      params: { threadId: thread, turn: { id: turnId, status } } });
    if (raw.includes('[early]')) done();
    send({ id: msg.id, result: { turn: { id: turnId } } });
    send({ method: 'item/agentMessage/delta',
      params: { delta: 'Fake output, no model was contacted' } });
    if (raw.includes('[approval]')) {
      pendingApproval.set(80, done);
      send({ method: 'item/commandExecution/requestApproval', id: 80,
        params: { command: 'unsafe should be declined' } });
    } else if (!raw.includes('[hang]') && !raw.includes('[early]')) setTimeout(done, 2);
    return;
  }
  if (msg.id === 80 && msg.result?.decision === 'decline') {
    const done = pendingApproval.get(80);
    pendingApproval.delete(80);
    done?.();
  }
});
