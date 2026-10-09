import {afterEach,describe,expect,it} from 'vitest';
import {mkdtemp,mkdir,rm,realpath,chmod,symlink,readFile} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {WebFirstTaskLedger} from '../../src/main/next/web-first/task-ledger.js';
import {WebFirstPlanLedger} from '../../src/main/next/web-first/plan-ledger.js';
import {WebFirstAgentRoster} from '../../src/main/next/web-first/agent-roster.js';
const homes:string[]=[];
afterEach(async()=>{for(const home of homes.splice(0))await rm(home,{recursive:true,force:true});});
async function setup(){
  const home=await mkdtemp(path.join(os.tmpdir(),'cos-ai-roster-'));homes.push(home);
  const root=path.join(await realpath(home),'project');await mkdir(root);
  const profile=path.join(home,'profile');await mkdir(profile);
  const tasks=new WebFirstTaskLedger(profile);
  const task=await tasks.begin({projectId:'project-fixture-001',projectRoot:root,goal:'Synthetic AI roster plan'});
  const plans=new WebFirstPlanLedger(profile,tasks);
  return {profile,task,tasks,plans,roster:new WebFirstAgentRoster(profile,tasks,plans)};
}
describe('P3.4-B durable AI Worker allocations without model execution',()=>{
  it('registers 1–4 unique native-only role assignments, survives restart, refuses fifth',async()=>{
    const x=await setup();
    const one=await x.roster.add(x.task.id,1,0,1);
    expect(one).toMatchObject([{role:'planner',state:'waiting-auth',reason:'AUTH_REQUIRED'}]);
    const others=await x.roster.add(x.task.id,1,0,3);
    expect(others.map(w=>w.role)).toEqual(['builder','tester','auditor']);
    await expect(x.roster.add(x.task.id,1,0,1)).rejects.toThrow('AI_WORKER_GOAL_CAPACITY_4');
    const back=new WebFirstAgentRoster(x.profile,x.tasks,x.plans);
    expect((await back.list()).filter(w=>w.state==='waiting-auth')).toHaveLength(4);
    expect(await back.reconcile()).toBe(0);
    const stored=await readFile(path.join(x.profile,'web-first-ai-worker-roster.json'),'utf8');
    expect(stored).not.toContain('Synthetic AI roster plan');
  });
  it('holds stale plan-bound workers for review, allows new role allocation',async()=>{
    const x=await setup();await x.roster.add(x.task.id,1,0,2);
    await x.plans.update({taskId:x.task.id,expectedRevision:0,nonce:'ai-plan-step-update',
      explanation:'Revised manually',steps:[{step:'New focus',status:'in_progress'}]});
    expect(await x.roster.reconcile()).toBe(2);
    expect((await x.roster.list()).every(w=>w.state==='review')).toBe(true);
    expect((await x.roster.add(x.task.id,1,1,2)).map(w=>w.role)).toEqual(['planner','builder']);
    expect((await x.roster.list()).filter(w=>w.state==='waiting-auth')).toHaveLength(2);
  });
  it('refuses stale revisions, terminal task and out-of-range counts',async()=>{
    const x=await setup();
    await expect(x.roster.add(x.task.id,1,0,5 as 4)).rejects.toThrow('AI_WORKER_REQUEST_INVALID');
    await expect(x.roster.add(x.task.id,2,0,1)).rejects.toThrow('AI_WORKER_TASK_STALE_OR_INACTIVE');
    await x.tasks.nativeDecision(x.task.id,1,'pause');
    await expect(x.roster.add(x.task.id,2,0,1)).rejects.toThrow('AI_WORKER_TASK_STALE_OR_INACTIVE');
    expect(await x.roster.list()).toHaveLength(0);
  });
  it('removes a specific Worker only by its exact task and revision, then reuses the role',async()=>{
    const x=await setup();const first=(await x.roster.add(x.task.id,1,0,2))[0]!;
    await expect(x.roster.removeOne(first.id,x.task.id,2)).rejects.toThrow('AI_WORKER_TASK_STALE_OR_INACTIVE');
    const removed=await x.roster.removeOne(first.id,x.task.id,1);
    expect(removed).toMatchObject({role:'planner',state:'cancelled',reason:'OPERATOR_STOPPED'});
    await expect(x.roster.removeOne(first.id,x.task.id,1)).rejects.toThrow('AI_WORKER_NOT_REMOVABLE');
    expect((await x.roster.add(x.task.id,1,0,1))[0]?.role).toBe('planner');
  });
  it('cancels unclaimed workers without ever dispatching a model request',async()=>{
    const x=await setup();await x.roster.add(x.task.id,1,0,3);
    expect(await x.roster.cancelForTask(x.task.id)).toBe(3);
    expect(await x.roster.cancelForTask(x.task.id)).toBe(0);
    expect((await x.roster.list()).every(w=>w.state==='cancelled'&&w.reason==='OPERATOR_STOPPED')).toBe(true);
  });
  it('fails closed on world-readable or symlinked roster without erasing Goal',async()=>{
    const x=await setup();await x.roster.add(x.task.id,1,0,1);
    const file=path.join(x.profile,'web-first-ai-worker-roster.json');
    await chmod(file,0o644);
    await expect(x.roster.list()).rejects.toThrow('AI_WORKER_LEDGER_UNSAFE');
    await rm(file);await symlink(x.profile,file);
    await expect(x.roster.list()).rejects.toThrow('AI_WORKER_LEDGER_UNSAFE');
    expect((await x.tasks.get(x.task.id)).phase).toBe('active');
  });
});
