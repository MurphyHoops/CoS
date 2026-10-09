import {afterEach,describe,it,expect} from 'vitest';
import {mkdtemp,rm,mkdir,chmod,symlink,realpath} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {WebFirstTaskLedger} from '../../src/main/next/web-first/task-ledger.js';
import {WebFirstPlanLedger} from '../../src/main/next/web-first/plan-ledger.js';
const roots:string[]=[];
afterEach(async()=>{for(const x of roots.splice(0))await rm(x,{recursive:true,force:true});});
async function create(){const tmp=await mkdtemp(path.join(os.tmpdir(),'cos-plan-'));roots.push(tmp);
  const project=path.join(await realpath(tmp),'project');await mkdir(project);
  const profile=path.join(tmp,'profile');await mkdir(profile);
  const tasks=new WebFirstTaskLedger(profile);
  const task=await tasks.begin({projectId:'project-test-00001',projectRoot:project,goal:'Offline Goal UI acceptance'});
  return {tmp,profile,tasks,task,plan:new WebFirstPlanLedger(profile,tasks)};
}
const steps=[{step:'Inspect source',status:'completed' as const},
  {step:'Run local validation',status:'in_progress' as const,details:'No network inference'}];
describe('Classic-compatible task plan persistence',()=>{
  it('creates and reloads an exact task-scoped plan with conflict and replay fencing',async()=>{
    const {plan,profile,tasks,task}=await create();
    const a={taskId:task.id,expectedRevision:0,nonce:'p3-plan-nonce-0001',explanation:'Test',steps};
    expect((await plan.update(a)).revision).toBe(1);
    expect((await plan.update(a)).revision).toBe(1);
    await expect(plan.update({...a,steps:[{step:'Changed',status:'pending'}]})).rejects.toThrow('PLAN_NONCE_CONFLICT');
    await expect(plan.update({...a,nonce:'new-nonce-000000'})).rejects.toThrow('PLAN_STALE_REVISION');
    expect((await new WebFirstPlanLedger(profile,tasks).status(task.id))?.steps).toEqual(steps);
  });
  it('does not allow concurrent in-progress steps or terminal-task plan editing',async()=>{
    const {plan,task,tasks}=await create();
    await expect(plan.update({taskId:task.id,expectedRevision:0,nonce:'invalid-000001',
      explanation:'',steps:[{step:'A',status:'in_progress'},{step:'B',status:'in_progress'}]})).rejects.toThrow('PLAN_CONFLICT_OR_TOO_LONG');
    const review=await tasks.requestReview(task.id,1,'ready-review-01','ready');
    await tasks.nativeDecision(task.id,review.revision,'complete');
    await expect(plan.update({taskId:task.id,expectedRevision:0,nonce:'terminal-000001',explanation:'',steps}))
      .rejects.toThrow('PLAN_TASK_TERMINAL');
  });
  it('refuses altered file permissions and symlink injection',async()=>{
    const {plan,profile,task}=await create();
    await plan.update({taskId:task.id,expectedRevision:0,nonce:'secure-plan-0001',explanation:'',steps});
    const f=path.join(profile,'web-first-plans.json');
    await chmod(f,0o644);await expect(plan.list()).rejects.toThrow('PLAN_LEDGER_UNSAFE');
    await rm(f);await symlink(profile,f);
    await expect(plan.list()).rejects.toThrow('PLAN_LEDGER_UNSAFE');
  });
});
