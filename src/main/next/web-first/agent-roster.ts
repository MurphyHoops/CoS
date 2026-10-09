/**
 * P3.4-B native-only AI Worker assignment ledger. This does NOT start an LLM.
 * A waiting-auth record cannot be claimed by a web turn without a future
 * separately attested, bounded transport and model identity capability.
 */
import {randomUUID} from 'node:crypto';
import {constants,promises as fs} from 'node:fs';
import path from 'node:path';
import type {WebFirstTaskLedger} from './task-ledger.js';
import type {WebFirstPlanLedger} from './plan-ledger.js';
export const AI_ROLES=['planner','builder','tester','auditor'] as const;
export type AiRole=typeof AI_ROLES[number];
export type AiWorkerState='waiting-auth'|'review'|'cancelled';
export interface AiWorkerAssignment {
  id:string;groupId:string;taskId:string;projectId:string;role:AiRole;
  taskRevision:number;planRevision:number;state:AiWorkerState;
  createdAt:number;updatedAt:number;reason:'AUTH_REQUIRED'|'TASK_CHANGED'|'OPERATOR_STOPPED';
}
const FILE='web-first-ai-worker-roster.json',MAX=96*1024,MAX_RECORDS=64;
const UUID=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
function validate(raw:unknown):asserts raw is AiWorkerAssignment {
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('AI_WORKER_RECORD_INVALID');
  const v=raw as Partial<AiWorkerAssignment>;
  const keys=['id','groupId','taskId','projectId','role','taskRevision','planRevision',
    'state','createdAt','updatedAt','reason'];
  if(Object.keys(v).sort().join('|')!==keys.sort().join('|')||
    !UUID.test(String(v.id))||!UUID.test(String(v.groupId))||!UUID.test(String(v.taskId))||
    typeof v.projectId!=='string'||v.projectId.length<10||v.projectId.length>90||
    !AI_ROLES.includes(v.role as AiRole)||
    !Number.isSafeInteger(v.taskRevision)||Number(v.taskRevision)<1||
    !Number.isSafeInteger(v.planRevision)||Number(v.planRevision)<0||
    !Number.isSafeInteger(v.createdAt)||Number(v.createdAt)<1||
    !Number.isSafeInteger(v.updatedAt)||Number(v.updatedAt)<1||
    !['waiting-auth','review','cancelled'].includes(String(v.state))||
    !['AUTH_REQUIRED','TASK_CHANGED','OPERATOR_STOPPED'].includes(String(v.reason)))
    throw Error('AI_WORKER_RECORD_INVALID');
}
export class WebFirstAgentRoster {
  private chain:Promise<unknown>=Promise.resolve();
  constructor(private readonly profile:string,private readonly tasks:WebFirstTaskLedger,
    private readonly plans:WebFirstPlanLedger){
    if(!path.isAbsolute(profile))throw Error('AI_WORKER_PROFILE_INVALID');
  }
  private filename(){return path.join(this.profile,FILE);}
  private locked<T>(f:()=>Promise<T>):Promise<T>{
    const p=this.chain.then(f);this.chain=p.catch(()=>undefined);return p;
  }
  async list():Promise<ReadonlyArray<AiWorkerAssignment>>{
    let stat;
    try{stat=await fs.lstat(this.filename());}
    catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return [];throw e;}
    if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||
      stat.size>MAX||(process.getuid&&stat.uid!==process.getuid()))
      throw Error('AI_WORKER_LEDGER_UNSAFE');
    const fd=await fs.open(this.filename(),constants.O_RDONLY|constants.O_NOFOLLOW);
    let content;
    try{
      const actual=await fd.stat();
      if(actual.ino!==stat.ino||actual.dev!==stat.dev)throw Error('AI_WORKER_LEDGER_CHANGED');
      content=await fd.readFile({encoding:'utf8'});
    }finally{await fd.close();}
    const parsed:unknown=JSON.parse(content);
    if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw Error('AI_WORKER_LEDGER_INVALID');
    const value=parsed as {version?:unknown;workers?:unknown};
    if(Object.keys(value).sort().join('|')!=='version|workers'||
      value.version!==1||!Array.isArray(value.workers)||value.workers.length>MAX_RECORDS)
      throw Error('AI_WORKER_LEDGER_INVALID');
    const ids=new Set<string>();
    for(const w of value.workers){validate(w);
      if(ids.has(w.id))throw Error('AI_WORKER_DUPLICATE');ids.add(w.id);
    }
    return value.workers;
  }
  private async save(workers:ReadonlyArray<AiWorkerAssignment>):Promise<void>{
    const data=JSON.stringify({version:1,workers})+'\n';
    if(workers.length>MAX_RECORDS||Buffer.byteLength(data)>MAX)throw Error('AI_WORKER_LEDGER_FULL');
    await fs.mkdir(this.profile,{recursive:true,mode:0o700});
    const temp=path.join(this.profile,'.ai-worker-'+randomUUID()+'.tmp');
    try{
      const fd=await fs.open(temp,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY,0o600);
      try{await fd.writeFile(data,'utf8');await fd.sync();}finally{await fd.close();}
      await fs.rename(temp,this.filename());
      if(process.platform!=='win32'){
        const dir=await fs.open(this.profile,constants.O_RDONLY);
        try{await dir.sync();}finally{await dir.close();}
      }
    }finally{await fs.rm(temp,{force:true});}
  }
  /** Operator assignment only. Authorization and dispatch are deliberately absent. */
  async add(taskId:string,taskRevision:number,planRevision:number,count:1|2|3|4):Promise<ReadonlyArray<AiWorkerAssignment>>{
    if(!UUID.test(taskId)||![1,2,3,4].includes(count)||
      !Number.isSafeInteger(taskRevision)||taskRevision<1||
      !Number.isSafeInteger(planRevision)||planRevision<0)throw Error('AI_WORKER_REQUEST_INVALID');
    return this.locked(async()=>{
      const task=await this.tasks.get(taskId),plan=await this.plans.status(taskId);
      if(task.phase!=='active'||task.revision!==taskRevision||
        (plan?.revision??0)!==planRevision)throw Error('AI_WORKER_TASK_STALE_OR_INACTIVE');
      const workers=[...await this.list()];
      if(workers.length+count>MAX_RECORDS)throw Error('AI_WORKER_LEDGER_FULL');
      // A changed plan invalidates prior unclaimed assignments. They become
      // historical REVIEW receipts rather than blocking all future roles.
      for(const worker of workers)if(worker.taskId===taskId&&worker.state==='waiting-auth'&&
        (worker.taskRevision!==taskRevision||worker.planRevision!==planRevision)){
        worker.state='review';worker.reason='TASK_CHANGED';worker.updatedAt=Date.now();
      }
      const assigned=new Set(workers.filter(w=>w.taskId===taskId&&w.state==='waiting-auth')
        .map(w=>w.role));
      const free=AI_ROLES.filter(role=>!assigned.has(role));
      if(free.length<count)throw Error('AI_WORKER_GOAL_CAPACITY_4');
      const now=Date.now(),groupId=randomUUID();
      const added=free.slice(0,count).map((role):AiWorkerAssignment=>({
        id:randomUUID(),groupId,taskId,projectId:task.projectId,role,
        taskRevision,planRevision,state:'waiting-auth',createdAt:now,updatedAt:now,
        reason:'AUTH_REQUIRED'
      }));
      workers.push(...added);await this.save(workers);
      return added;
    });
  }
  /** Never resurrect a stale assignment or send an unknown model turn. */
  async reconcile():Promise<number>{return this.locked(async()=>{
    const workers=[...await this.list()];let changed=0;
    for(const w of workers){
      if(w.state!=='waiting-auth')continue;
      let valid=false;
      try{
        const task=await this.tasks.get(w.taskId),plan=await this.plans.status(w.taskId);
        valid=task.phase==='active'&&task.revision===w.taskRevision&&
          (plan?.revision??0)===w.planRevision&&task.projectId===w.projectId;
      }catch{/* preserve record; hold it */}
      if(!valid){w.state='review';w.reason='TASK_CHANGED';w.updatedAt=Date.now();changed++;}
    }
    if(changed)await this.save(workers);return changed;
  });}
  async removeOne(workerId:string,taskId:string,taskRevision:number):Promise<AiWorkerAssignment>{
    if(!UUID.test(workerId)||!UUID.test(taskId)||
      !Number.isSafeInteger(taskRevision)||taskRevision<1)
      throw Error('AI_WORKER_REQUEST_INVALID');
    return this.locked(async()=>{
      const task=await this.tasks.get(taskId);
      if(task.revision!==taskRevision)throw Error('AI_WORKER_TASK_STALE_OR_INACTIVE');
      const workers=[...await this.list()];
      const record=workers.find(w=>w.id===workerId&&w.taskId===taskId);
      if(!record||record.state==='cancelled')throw Error('AI_WORKER_NOT_REMOVABLE');
      record.state='cancelled';record.reason='OPERATOR_STOPPED';record.updatedAt=Date.now();
      await this.save(workers);return record;
    });
  }
  async cancelForTask(taskId:string):Promise<number>{return this.locked(async()=>{
    const workers=[...await this.list()];let changed=0;
    for(const w of workers)if(w.taskId===taskId&&w.state==='waiting-auth'){
      w.state='cancelled';w.reason='OPERATOR_STOPPED';w.updatedAt=Date.now();changed++;
    }
    if(changed)await this.save(workers);return changed;
  });}
}
