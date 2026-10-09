import {afterEach,describe,it,expect} from 'vitest';
import {mkdtemp,rm,symlink,chmod,readFile} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {WebFirstHealthLedger} from '../../src/main/next/web-first/health-ledger.js';
const roots:string[]=[];
afterEach(async()=>{for(const dir of roots.splice(0))await rm(dir,{recursive:true,force:true});});
async function make(){const dir=await mkdtemp(path.join(os.tmpdir(),'cos-health-events-'));roots.push(dir);
  return {dir,log:new WebFirstHealthLedger(dir)};}
describe('Web-First crash-safe metadata-only health audit',()=>{
  it('persists only enumerated non-sensitive categories and survives another instance',async()=>{
    const {dir,log}=await make();
    await Promise.all([
      log.record({kind:'app-started',route:'not-applicable',status:null,code:null}),
      log.record({kind:'api-rate-limited',route:'conversation-list',status:429,code:null}),
      log.record({kind:'main-frame-network-error',route:'chatgpt-main',status:null,code:-105})
    ]);
    const other=new WebFirstHealthLedger(dir);
    const events=await other.last();
    expect(events.map(e=>e.kind)).toEqual(['app-started','api-rate-limited','main-frame-network-error']);
    const serialized=await readFile(path.join(dir,'web-first-health.jsonl'),'utf8');
    expect(serialized).not.toContain('conversation_id');
    expect(serialized).not.toContain('cookie');
    expect(serialized).not.toContain('authorization');
  });
  it('rejects unapproved route values, foreign fields and malformed status codes',async()=>{
    const {log}=await make();
    await expect(log.record({kind:'api-rate-limited',route:'conversation-list',status:999,code:null})).rejects.toThrow('WEB_HEALTH_RECEIPT_INVALID');
    await expect(log.record({kind:'app-started',route:'not-applicable',status:null,code:200000})).rejects.toThrow('WEB_HEALTH_RECEIPT_INVALID');
  });
  it('fails closed on world-readable or symlinked diagnostic ledger',async()=>{
    const {dir,log}=await make();
    await log.record({kind:'app-started',route:'not-applicable',status:null,code:null});
    const filename=path.join(dir,'web-first-health.jsonl');
    await chmod(filename,0o644);
    await expect(log.last()).rejects.toThrow('WEB_HEALTH_LEDGER_UNSAFE');
    await rm(filename);await symlink(dir,filename);
    await expect(log.record({kind:'page-empty',route:'chatgpt-main',status:null,code:null})).rejects.toThrow('WEB_HEALTH_LEDGER_UNSAFE');
  });
});
