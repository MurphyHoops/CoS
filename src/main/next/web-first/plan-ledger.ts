/**
 * P3 native goal plan. Classic update_plan v1 shape, but task-scoped and
 * exact-revision fenced. Plan metadata is NOT an authorization to execute.
 */
import {randomUUID} from 'node:crypto';
import {promises as fs,constants} from 'node:fs';
import path from 'node:path';
import type {WebFirstTaskLedger} from './task-ledger.js';
export type PlanStepStatus='pending'|'in_progress'|'completed';
export interface PlanStep {step:string;status:PlanStepStatus;details?:string;}
export interface TaskPlan {taskId:string;projectId:string;revision:number;
  updatedAt:number;explanation:string;steps:PlanStep[];nonce:string;}
const FILE='web-first-plans.json';
const LIMIT=64,MAX_BYTES=360*1024,ID=/^[0-9a-f-]{36}$/i;
const MAX_DESCRIPTION=12000;
export function validatePlanSteps(steps:unknown):asserts steps is PlanStep[]{
  if(!Array.isArray(steps)||steps.length>12)throw Error('PLAN_STEPS_INVALID');
  let active=0,bytes=0;
  for(const st of steps){
    if(!st||typeof st!=='object'||Array.isArray(st))throw Error('PLAN_STEP_INVALID');
    const row=st as Partial<PlanStep>;
    if(typeof row.step!=='string'||!row.step.trim()||row.step.length>160||
      !['pending','in_progress','completed'].includes(row.status??'')||
      (row.details!==undefined&&(typeof row.details!=='string'||row.details.length>2000))||
      Object.keys(row).some(key=>!['step','status','details'].includes(key)))
      throw Error('PLAN_STEP_INVALID');
    if(row.status==='in_progress')active++;
    bytes+=row.step.length+(row.details?.length??0);
  }
  if(active>1||bytes>MAX_DESCRIPTION)throw Error('PLAN_CONFLICT_OR_TOO_LONG');
}
function verify(value:unknown):asserts value is TaskPlan{
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('PLAN_RECORD_INVALID');
  const r=value as Partial<TaskPlan>;
  if(typeof r.taskId!=='string'||!ID.test(r.taskId)||
    typeof r.projectId!=='string'||r.projectId.length<10||r.projectId.length>90||
    !Number.isSafeInteger(r.revision)||typeof r.revision!=='number'||r.revision<1||
    !Number.isSafeInteger(r.updatedAt)||typeof r.updatedAt!=='number'||
    typeof r.explanation!=='string'||r.explanation.length>1000||
    typeof r.nonce!=='string'||r.nonce.length<8||r.nonce.length>100||
    Object.keys(r).sort().join('|')!==
      ['explanation','nonce','projectId','revision','steps','taskId','updatedAt'].join('|'))
    throw Error('PLAN_RECORD_INVALID');
  validatePlanSteps(r.steps);
}
export class WebFirstPlanLedger {
  private chain:Promise<unknown>=Promise.resolve();
  constructor(private readonly profile:string,private readonly tasks:WebFirstTaskLedger){
    if(!path.isAbsolute(profile))throw Error('PLAN_PROFILE_INVALID');
  }
  private filename(){return path.join(this.profile,FILE);}
  private serialize<T>(f:()=>Promise<T>):Promise<T>{const r=this.chain.then(f);
    this.chain=r.catch(()=>undefined);return r;}
  private async read():Promise<TaskPlan[]>{
    let st;
    try{st=await fs.lstat(this.filename());}
    catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return [];throw e;}
    if(!st.isFile()||st.isSymbolicLink()||(st.mode&0o077)!==0||
      (process.getuid&&st.uid!==process.getuid())||st.size>MAX_BYTES)
      throw Error('PLAN_LEDGER_UNSAFE');
    const fd=await fs.open(this.filename(),constants.O_RDONLY|constants.O_NOFOLLOW);
    let raw:string;
    try{raw=await fd.readFile({encoding:'utf8'});}finally{await fd.close();}
    const decoded:unknown=JSON.parse(raw);
    if(!decoded||typeof decoded!=='object'||Array.isArray(decoded))throw Error('PLAN_LEDGER_INVALID');
    const data=decoded as {version?:unknown;plans?:unknown};
    if(data.version!==1||!Array.isArray(data.plans)||data.plans.length>LIMIT)
      throw Error('PLAN_LEDGER_INVALID');
    const seen=new Set<string>();
    for(const item of data.plans){verify(item);
      if(seen.has(item.taskId))throw Error('PLAN_DUPLICATE_TASK');seen.add(item.taskId);}
    return data.plans;
  }
  private async persist(data:TaskPlan[]){
    const json=JSON.stringify({version:1,plans:data})+'\n';
    if(Buffer.byteLength(json)>MAX_BYTES)throw Error('PLAN_LEDGER_FULL');
    await fs.mkdir(this.profile,{recursive:true,mode:0o700});
    const tmp=path.join(this.profile,'.web-first-plan-'+randomUUID()+'.tmp');
    try{
      const fd=await fs.open(tmp,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY,0o600);
      try{await fd.writeFile(json);await fd.sync();}finally{await fd.close();}
      await fs.rename(tmp,this.filename());
    }finally{await fs.rm(tmp,{force:true});}
  }
  async list():Promise<ReadonlyArray<TaskPlan>>{return this.read();}
  async status(taskId:string):Promise<TaskPlan|null>{
    await this.tasks.get(taskId);return (await this.read()).find(p=>p.taskId===taskId)??null;
  }
  /** Only active/waiting/recovery-held tasks can own a plan. Terminal plan is immutable. */
  async update(data:{taskId:string;expectedRevision:number;nonce:string;
    explanation:string;steps:PlanStep[]}):Promise<TaskPlan>{
    validatePlanSteps(data.steps);
    if(typeof data.nonce!=='string'||data.nonce.length<8||data.nonce.length>100||
      typeof data.explanation!=='string'||data.explanation.length>1000||
      !Number.isInteger(data.expectedRevision)||data.expectedRevision<0)
      throw Error('PLAN_UPDATE_INVALID');
    return this.serialize(async()=>{
      const task=await this.tasks.get(data.taskId);
      if(task.phase==='cancelled'||task.phase==='completed')throw Error('PLAN_TASK_TERMINAL');
      const plans=await this.read(),prior=plans.find(x=>x.taskId===data.taskId);
      if(prior?.nonce===data.nonce){
        if(prior.explanation!==data.explanation||JSON.stringify(prior.steps)!==JSON.stringify(data.steps))
          throw Error('PLAN_NONCE_CONFLICT');
        return prior;
      }
      if((prior?.revision??0)!==data.expectedRevision)throw Error('PLAN_STALE_REVISION');
      if(!prior&&plans.length>=LIMIT)throw Error('PLAN_LIMIT');
      const updated:TaskPlan={taskId:data.taskId,projectId:task.projectId,
        revision:data.expectedRevision+1,updatedAt:Date.now(),
        explanation:data.explanation,steps:data.steps,nonce:data.nonce};
      if(prior)plans[plans.indexOf(prior)]=updated;else plans.push(updated);
      await this.persist(plans);return updated;
    });
  }
}
