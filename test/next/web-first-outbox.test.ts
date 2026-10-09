import {describe,it,expect,afterEach} from 'vitest';
import {mkdtemp,rm,chmod,symlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import os from 'node:os';import path from 'node:path';
import {WebFirstWebOutbox} from '../../src/main/next/web-first/web-outbox.js';
const roots:string[]=[];
afterEach(async()=>{for(const d of roots.splice(0))await rm(d,{recursive:true,force:true});});
async function setup(){const d=await mkdtemp(path.join(os.tmpdir(),'cos-outbox-'));roots.push(d);
  return {dir:d,box:new WebFirstWebOutbox(d)};}
function input(){return {taskId:randomUUID(),conversationId:randomUUID(),text:'Continue scoped task',nonce:randomUUID()};}
describe('Web-First native delivery outbox fail-closed crash boundary',()=>{
  it('fsyncs queued->dispatching->delivered with exact durable receipt and duplicate nonce fencing',async()=>{
    const {dir,box}=await setup(),a=input(),send=await box.enqueue(a);
    expect(send.state).toBe('queued');
    expect((await new WebFirstWebOutbox(dir).enqueue(a)).id).toBe(send.id);
    await expect(box.enqueue({...a,text:'different'})).rejects.toThrow('OUTBOX_NONCE_CONFLICT');
    const claimed=await box.transition(send.id,'queued','dispatching');
    expect(claimed.state).toBe('dispatching');
    expect((await box.transition(send.id,'dispatching','delivered','dom:receipt')).state).toBe('delivered');
    expect(await new WebFirstWebOutbox(dir).holdUncertain()).toBe(0);
    await expect(box.transition(send.id,'queued','dispatching')).rejects.toThrow('OUTBOX_STALE_STATE');
  });
  it('restarting from either queued or dispatching yields uncertain, NEVER auto-resend',async()=>{
    const {dir,box}=await setup(),a=await box.enqueue(input()),b=await box.enqueue(input());
    await box.transition(b.id,'queued','dispatching');
    const fresh=new WebFirstWebOutbox(dir);
    expect(await fresh.holdUncertain()).toBe(2);
    expect((await fresh.list()).map(x=>x.state)).toEqual(['uncertain','uncertain']);
    await expect(fresh.transition(a.id,'queued','dispatching')).rejects.toThrow('OUTBOX_STALE_STATE');
  });
  it('refuses corrupt or linked ledgers and rejects malformed identifiers',async()=>{
    const {dir,box}=await setup();
    await expect(box.enqueue({...input(),nonce:'bad'})).rejects.toThrow('OUTBOX_RECORD_INVALID');
    await box.enqueue(input());
    const file=path.join(dir,'web-first-outbox.json');await chmod(file,0o644);
    await expect(box.list()).rejects.toThrow('OUTBOX_UNSAFE');
    await rm(file);await symlink(dir,file);
    await expect(box.list()).rejects.toThrow('OUTBOX_UNSAFE');
  });
});
