import {describe,it,expect,afterEach} from 'vitest';
import {mkdtemp,rm,chmod,symlink} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {WebFirstRateLimitSupervisor} from '../../src/main/next/web-first/rate-limit-supervisor.js';
const roots:string[]=[];
afterEach(async()=>{for(const d of roots.splice(0))await rm(d,{recursive:true,force:true});});
async function create(){const dir=await mkdtemp(path.join(os.tmpdir(),'cos-rate-limit-'));
  roots.push(dir);return {dir,s:new WebFirstRateLimitSupervisor(dir)};}
const now=1_800_000_000_000;
describe('Provider-respecting rate limit and durable work pause',()=>{
  it('history list 429 never masquerades as model exhaustion',async()=>{
    const {dir,s}=await create();
    expect((await s.history429(now)).history).toBe('degraded');
    expect((await new WebFirstRateLimitSupervisor(dir).status(now)).model).toBe('clear');
    expect((await s.history429(now+150)).history429Count).toBe(1);
    expect((await s.status(now+61000)).history).toBe('normal');
  });
  it('unknown API 429 enters a bounded cooldown then requires operator verification',async()=>{
    const {dir,s}=await create();
    expect((await s.backend429(now)).model).toBe('cooldown');
    expect((await s.status(now+120001)).model).toBe('review');
    await expect(s.confirmRecovery(now+30000)).rejects.toThrow('RATE_LIMIT_COOLDOWN_NOT_DUE');
    const restarted=new WebFirstRateLimitSupervisor(dir);
    expect((await restarted.status(now+121000)).model).toBe('review');
    expect((await restarted.confirmRecovery(now+121000)).model).toBe('clear');
  });
  it('manual model limit cannot be bypassed by a page-history 429 or a restart',async()=>{
    const {dir,s}=await create();
    await s.pauseForModelLimit(30,now);
    await s.history429(now+100);
    expect((await new WebFirstRateLimitSupervisor(dir).status(now+1000)).model).toBe('cooldown');
    await expect(s.confirmRecovery(now+20*60000)).rejects.toThrow('RATE_LIMIT_COOLDOWN_NOT_DUE');
    expect((await s.confirmRecovery(now+31*60000)).model).toBe('clear');
  });
  it('fails closed on tampered mode or linked ledger',async()=>{
    const {dir,s}=await create();await s.pauseForModelLimit(15,now);
    const file=path.join(dir,'web-first-rate-limit.json');await chmod(file,0o644);
    await expect(s.status()).rejects.toThrow('RATE_LIMIT_LEDGER_UNSAFE');
    await rm(file);await symlink(dir,file);
    await expect(s.status()).rejects.toThrow('RATE_LIMIT_LEDGER_UNSAFE');
  });
});
