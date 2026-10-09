import {afterEach,describe,it,expect,vi} from 'vitest';
import {mkdtemp,mkdir,rm,chmod,symlink,readFile,writeFile,rename,realpath} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {WebFirstTaskLedger} from '../../src/main/next/web-first/task-ledger.js';
import {WebFirstPlanLedger} from '../../src/main/next/web-first/plan-ledger.js';
import {WebFirstLocalJobQueue} from '../../src/main/next/web-first/local-job-queue.js';
import {WebFirstRateLimitSupervisor} from '../../src/main/next/web-first/rate-limit-supervisor.js';
const dirs:string[]=[];
afterEach(async()=>{for(const dir of dirs.splice(0))await rm(dir,{recursive:true,force:true});});
async function make(approved=true){
  const dir=await mkdtemp(path.join(os.tmpdir(),'cos-p34-jobs-'));dirs.push(dir);
  const root=path.join(await realpath(dir),'project');await mkdir(root);
  const profile=path.join(dir,'profile');await mkdir(profile);
  const tasks=new WebFirstTaskLedger(profile);
  const task=await tasks.begin({projectId:'project-native-00001',projectRoot:root,goal:'Approved offline audit'});
  const plans=new WebFirstPlanLedger(profile,tasks);
  const approve=vi.fn(async()=>approved);
  const jobs=new WebFirstLocalJobQueue(profile,tasks,plans,approve);
  const args={taskId:task.id,taskRevision:task.revision,planRevision:0,kind:'root-check' as const,nonce:randomUUID()};
  return {dir,root,profile,tasks,task,plans,jobs,approve,args};
}
describe('P3.4-A native-approved durable local diagnostic queue',()=>{
  it('persists exact native approval, root receipt and no model inference during a limit',async()=>{
    const x=await make();
    await new WebFirstRateLimitSupervisor(x.profile).pauseForModelLimit(15);
    expect((await new WebFirstRateLimitSupervisor(x.profile).status()).model).toBe('cooldown');
    const j=await x.jobs.enqueue(x.args);
    expect(j.state).toBe('queued');expect(x.approve).toHaveBeenCalledTimes(1);
    expect((await x.jobs.enqueue(x.args)).id).toBe(j.id);
    expect(x.approve).toHaveBeenCalledTimes(1);
    const receipt=await x.jobs.run(j.id);
    expect(receipt).toMatchObject({state:'succeeded',exitCode:0,reason:null});
    expect(receipt.outputDigest).toMatch(/^[a-f0-9]{64}$/);
    expect((await new WebFirstLocalJobQueue(x.profile,x.tasks,x.plans,x.approve).get(j.id)).state)
      .toBe('succeeded');
    const ledger=await readFile(path.join(x.profile,'web-first-local-jobs.json'),'utf8');
    expect(ledger).not.toContain('Approved offline audit');
    expect(await x.jobs.holdInterrupted()).toBe(0);
    expect((await x.tasks.get(x.task.id)).phase).toBe('active');
  });
  it('rejects unapproved requests, stale revisions and conflicting nonces',async()=>{
    const x=await make(false);
    await expect(x.jobs.enqueue(x.args)).rejects.toThrow('LOCAL_JOB_APPROVAL_DENIED');
    expect(await x.jobs.list()).toHaveLength(0);
    const y=await make();await y.jobs.enqueue(y.args);
    await expect(y.jobs.enqueue({...y.args,kind:'git-status'})).rejects.toThrow('LOCAL_JOB_NONCE_CONFLICT');
    await expect(y.jobs.enqueue({...y.args,nonce:randomUUID()})).rejects.toThrow('LOCAL_JOB_TASK_BUSY');
    const paused=await y.tasks.nativeDecision(y.task.id,1,'pause');
    await expect(y.jobs.run((await y.jobs.list())[0]!.id)).resolves.toMatchObject({state:'review',reason:'LOCAL_JOB_CONTEXT_CHANGED'});
    await expect(y.jobs.enqueue({...y.args,taskRevision:paused.revision,nonce:randomUUID()}))
      .rejects.toThrow('LOCAL_JOB_TASK_STALE_OR_INACTIVE');
  });
  it('rejects enqueued work if plan revision changes before dispatch',async()=>{
    const x=await make();const j=await x.jobs.enqueue(x.args);
    await x.plans.update({taskId:x.task.id,expectedRevision:0,nonce:'local-plan-change-01',
      explanation:'Changed by operator',steps:[{step:'New plan',status:'in_progress'}]});
    expect(await x.jobs.run(j.id)).toMatchObject({state:'review',reason:'LOCAL_JOB_CONTEXT_CHANGED'});
  });
  it('holds queued but undispatched entries at restart, freeing subsequent native approval',async()=>{
    const x=await make();const waiting=await x.jobs.enqueue(x.args);
    const rebuilt=new WebFirstLocalJobQueue(x.profile,x.tasks,x.plans,x.approve);
    expect(await rebuilt.holdInterrupted()).toBe(1);
    expect(await rebuilt.run(waiting.id)).toMatchObject({state:'review',
      reason:'LOCAL_JOB_NOT_DISPATCHED_REVIEW',exitCode:null});
    const next=await rebuilt.enqueue({...x.args,nonce:randomUUID()});
    expect((await rebuilt.run(next.id)).state).toBe('succeeded');
  });
  it('reconciles interrupted running job once without replaying or claiming exit',async()=>{
    const x=await make();const job=await x.jobs.enqueue(x.args);
    const name=path.join(x.profile,'web-first-local-jobs.json');
    const value=JSON.parse(await readFile(name,'utf8'));
    value.jobs[0].state='running';value.jobs[0].startedAt=Date.now();
    await writeFile(name,JSON.stringify(value)+'\n',{mode:0o600});
    const another=new WebFirstLocalJobQueue(x.profile,x.tasks,x.plans,x.approve);
    expect(await another.holdInterrupted()).toBe(1);
    expect(await another.holdInterrupted()).toBe(0);
    expect(await another.run(job.id)).toMatchObject({state:'review',reason:'LOCAL_JOB_INTERRUPTED_UNCERTAIN',exitCode:null});
  });
  it('runs bounded real Git status with no arbitrary argv or stored file contents',async()=>{
    const x=await make();
    execFileSync('/usr/bin/git',['init','-q'],{cwd:x.root});
    await writeFile(path.join(x.root,'README.md'),'private project content');
    execFileSync('/usr/bin/git',['add','README.md'],{cwd:x.root});
    const job=await x.jobs.enqueue({...x.args,kind:'git-status'});
    const output=await x.jobs.run(job.id);
    expect(output.state).toBe('succeeded');expect(output.changedCount).toBe(1);
    expect(output.outputDigest).toMatch(/^[a-f0-9]{64}$/);
    const storage=await readFile(path.join(x.profile,'web-first-local-jobs.json'),'utf8');
    expect(storage).not.toContain('README.md');expect(storage).not.toContain('private project content');
  });
  it('runs four separate persisted native Worker slots without changing Goal phase',async()=>{
    const x=await make();
    execFileSync('/usr/bin/git',['init','-q'],{cwd:x.root});
    await writeFile(path.join(x.root,'README.md'),'synthetic fixture');
    execFileSync('/usr/bin/git',['add','README.md'],{cwd:x.root});
    execFileSync('/usr/bin/git',['-c','user.name=Fixture','-c','user.email=fixture@example.invalid',
      'commit','-qm','fixture'],{cwd:x.root});
    const workers=await x.jobs.enqueueTeam({...x.args,size:4});
    expect(workers.map(w=>w.kind)).toEqual(['root-check','git-status','git-head','git-tracked']);
    expect(new Set(workers.map(w=>w.id)).size).toBe(4);
    expect(workers.every(w=>w.state==='queued')).toBe(true);
    expect(x.approve).toHaveBeenCalledWith(expect.objectContaining({kind:'worker-team',size:4}));
    const completed=await x.jobs.runTeam(workers.map(w=>w.id));
    expect(completed.every(w=>w.state==='succeeded'&&w.outputDigest?.length===64)).toBe(true);
    expect(completed.find(w=>w.kind==='git-tracked')?.changedCount).toBe(1);
    expect(completed.find(w=>w.kind==='git-status')?.changedCount).toBe(0);
    expect((await x.tasks.get(x.task.id)).phase).toBe('active');
    const restored=await new WebFirstLocalJobQueue(x.profile,x.tasks,x.plans,x.approve).list();
    expect(restored).toHaveLength(4);expect(restored.every(w=>w.state==='succeeded')).toBe(true);
    const disk=await readFile(path.join(x.profile,'web-first-local-jobs.json'),'utf8');
    expect(disk).not.toContain('README.md');expect(disk).not.toContain('synthetic fixture');
  });
  it('denies team without native authorization, rejects invalid team sizes and duplicate dispatch',async()=>{
    const denied=await make(false);
    await expect(denied.jobs.enqueueTeam({...denied.args,size:2})).rejects.toThrow('LOCAL_JOB_APPROVAL_DENIED');
    expect(await denied.jobs.list()).toHaveLength(0);
    const x=await make();
    await expect(x.jobs.enqueueTeam({...x.args,size:5 as 4})).rejects.toThrow('LOCAL_WORKER_TEAM_INVALID');
    const team=await x.jobs.enqueueTeam({...x.args,size:2});
    await expect(x.jobs.enqueueTeam({...x.args,size:2})).rejects.toThrow('LOCAL_WORKER_TEAM_NONCE_REUSED');
    await expect(x.jobs.enqueueTeam({...x.args,nonce:randomUUID(),size:2})).rejects.toThrow('LOCAL_JOB_TASK_BUSY');
    const first=await x.jobs.runTeam(team.map(w=>w.id));
    expect(first[0]?.state).toBe('succeeded');
    expect(first[1]?.state).toBe('failed'); // synthetic directory is not a Git repository
    await expect(x.jobs.runTeam(team.map(w=>w.id))).rejects.toThrow('LOCAL_WORKER_TEAM_MISMATCH');
  });
  it('holds a multi-Worker team after crash rather than replaying either slot',async()=>{
    const x=await make();const workers=await x.jobs.enqueueTeam({...x.args,size:3});
    const revived=new WebFirstLocalJobQueue(x.profile,x.tasks,x.plans,x.approve);
    expect(await revived.holdInterrupted()).toBe(3);
    expect(await revived.holdInterrupted()).toBe(0);
    expect((await revived.list()).map(w=>w.reason)).toEqual(Array(3).fill('LOCAL_JOB_NOT_DISPATCHED_REVIEW'));
    await expect(revived.runTeam(workers.map(w=>w.id))).rejects.toThrow('LOCAL_WORKER_TEAM_MISMATCH');
  });
  it('fails closed if project root changed, ledger is world-readable or symlinked',async()=>{
    const x=await make();await x.jobs.enqueue(x.args);
    await rename(x.root,x.root+'-saved');await mkdir(x.root);
    expect(await x.jobs.run((await x.jobs.list())[0]!.id)).toMatchObject({state:'review',reason:'LOCAL_JOB_PROJECT_CHANGED'});
    const file=path.join(x.profile,'web-first-local-jobs.json');
    await chmod(file,0o644);
    await expect(x.jobs.list()).rejects.toThrow('LOCAL_JOB_LEDGER_UNSAFE');
    await rm(file);await symlink(x.root,file);
    await expect(x.jobs.list()).rejects.toThrow('LOCAL_JOB_LEDGER_UNSAFE');
  });
});
