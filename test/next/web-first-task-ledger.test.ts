import {afterEach,describe,expect,it} from 'vitest';
import {mkdtemp,mkdir,rm,rename,writeFile,symlink,chmod,stat} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {WebFirstTaskLedger} from '../../src/main/next/web-first/task-ledger.js';
const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
async function make(){
  const top=await mkdtemp(path.join(os.tmpdir(),'cos-p3-durable-tasks-'));roots.push(top);
  const project=path.join(await import('node:fs/promises').then(x=>x.realpath(top)),'project');
  await mkdir(project);const profile=path.join(top,'profile');await mkdir(profile);
  return {top,project,profile,store:new WebFirstTaskLedger(profile)};
}
const n=(key:string)=>key.padEnd(12,'_');
describe('P3 task lifecycle: durable, idempotent, no blind automatic continuation',()=>{
  it('persists task and checkpoint; duplicates do not advance revision',async()=>{
    const x=await make();const a=await x.store.begin({projectId:'project-opaque-1',projectRoot:x.project,goal:'Audit the project'});
    expect(a.phase).toBe('active');expect(a.revision).toBe(1);
    const b=await x.store.checkpoint(a.id,1,n('first'),'test submitted');
    expect(b.revision).toBe(2);
    expect((await x.store.checkpoint(a.id,1,n('first'),'test submitted')).revision).toBe(2);
    await expect(x.store.checkpoint(a.id,1,n('other'),'duplicate')).rejects.toThrow('TASK_STALE_REVISION');
    expect((await new WebFirstTaskLedger(x.profile).get(a.id)).revision).toBe(2);
    const mode=(await stat(path.join(x.profile,'web-first-tasks.json'))).mode;
    expect(mode&0o077).toBe(0);
  });
  it('native pause survives restart and requires explicit operator resume',async()=>{
    const x=await make();const a=await x.store.begin({projectId:'project-opaque-1',projectRoot:x.project,goal:'Pause/Resume scenario'});
    const paused=await x.store.nativeDecision(a.id,1,'pause');
    expect(paused.phase).toBe('paused');
    expect((await new WebFirstTaskLedger(x.profile).get(a.id)).phase).toBe('paused');
    await expect(x.store.checkpoint(a.id,2,n('illegal'),'No unapproved work')).rejects.toThrow('TASK_NOT_ACTIVE');
    const resumed=await x.store.nativeDecision(a.id,2,'resume');
    expect(resumed.phase).toBe('active');expect(resumed.revision).toBe(3);
  });
  it('handles wait, restart HOLD, operator resume, review and operator completion',async()=>{
    const x=await make();const task=await x.store.begin({projectId:'project-one',projectRoot:x.project,goal:'Long task'});
    const waited=await x.store.wait(task.id,1,n('wait'),15);
    expect(waited.phase).toBe('waiting');expect(waited.waitUntil).toBeGreaterThan(Date.now());
    expect(await new WebFirstTaskLedger(x.profile).holdInterruptedTasks()).toBe(0);
    const resumed=await x.store.nativeDecision(task.id,2,'resume');
    const marked=await new WebFirstTaskLedger(x.profile).holdInterruptedTasks();
    expect(marked).toBe(1);
    expect((await x.store.get(task.id)).phase).toBe('recovery-hold');
    await expect(x.store.checkpoint(task.id,4,n('nope'),'unsafe')).rejects.toThrow('TASK_NOT_ACTIVE');
    const yes=await x.store.nativeDecision(task.id,4,'resume');
    const review=await x.store.requestReview(task.id,yes.revision,n('finish'),'Build passed; needs operator check');
    expect(review.phase).toBe('review');
    const finished=await x.store.nativeDecision(task.id,review.revision,'complete');
    expect(finished.phase).toBe('completed');
    expect((await x.store.get(task.id)).phase).toBe('completed');
    await expect(x.store.nativeDecision(task.id,finished.revision,'resume')).rejects.toThrow();
    expect(resumed.phase).toBe('active');
  });
  it('rejects project-root replacement, symlinks, corrupt and world-readable ledgers',async()=>{
    const x=await make();const t=await x.store.begin({projectId:'project-one',projectRoot:x.project,goal:'Check'});
    await rename(x.project,x.project+'-old');await mkdir(x.project);
    await expect(x.store.checkpoint(t.id,1,n('mismatch'),'bad')).rejects.toThrow('TASK_PROJECT_CHANGED');
    const f=path.join(x.profile,'web-first-tasks.json');await chmod(f,0o644);
    await expect(x.store.get(t.id)).rejects.toThrow('TASK_LEDGER_UNSAFE');
    await rm(f);await writeFile(f,'INVALID_JSON',{mode:0o600});
    await expect(x.store.list()).rejects.toThrow();
    await rm(f);await symlink(x.project,f);
    await expect(x.store.list()).rejects.toThrow('TASK_LEDGER_UNSAFE');
  });
  it('never auto-completes on a model-written checkpoint, and restricts input sizes',async()=>{
    const x=await make();const t=await x.store.begin({projectId:'project-one',projectRoot:x.project,goal:'Build code'});
    await expect(x.store.nativeDecision(t.id,1,'complete')).rejects.toThrow('TASK_NEEDS_REVIEW');
    await expect(x.store.checkpoint(t.id,1,n('oversize'),'x'.repeat(1001))).rejects.toThrow('TASK_NOTE_INVALID');
    await expect(x.store.wait(t.id,1,n('wait'),20000)).rejects.toThrow('TASK_WAIT_INVALID');
    expect((await x.store.get(t.id)).phase).toBe('active');
  });
});
