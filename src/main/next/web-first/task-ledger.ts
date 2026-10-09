/**
 * Web-First P3 durable task contract. No model API, browser-side privilege or
 * implicit replay. The assistant may REPORT progress; only native user consent
 * can start or finish the task, and only a proved future conversation owner may
 * eventually resume unattended work.
 */
import {randomUUID} from 'node:crypto';
import {constants,promises as fs} from 'node:fs';
import path from 'node:path';

export type TaskPhase='active'|'waiting'|'paused'|'recovery-hold'|'review'|'completed'|'cancelled';
export type TaskEventKind='created'|'checkpoint'|'waiting'|'paused'|'resume-approved'|'review-requested'|'finished'|'cancelled'|'recovery-held';
export interface TaskEvent {revision:number;at:number;kind:TaskEventKind;nonce:string|null;note:string|null;}
export interface DurableTask {
  id:string;projectId:string;projectRoot:string;rootDev:number;rootIno:number;
  goal:string;phase:TaskPhase;revision:number;createdAt:number;updatedAt:number;
  waitUntil:number|null;events:TaskEvent[];
}
interface TaskSnapshot {version:1;tasks:DurableTask[];}
const FILE='web-first-tasks.json';
const LIMIT=64,EVENT_LIMIT=100,MAX_BYTES=512*1024;
const IDENT=/^[a-f0-9-]{36}$/i;
const NOTE_MAX=1000;
function validString(s:unknown,min=1,max=2000):s is string {
  return typeof s==='string'&&s.length>=min&&s.length<=max&&!s.includes('\0');
}
function event(task:DurableTask,kind:TaskEventKind,note:string|null=null,nonce:string|null=null){
  task.revision++;task.updatedAt=Date.now();
  task.events.push({revision:task.revision,at:task.updatedAt,kind,nonce,note});
  if(task.events.length>EVENT_LIMIT)task.events=task.events.slice(-EVENT_LIMIT);
}
export class WebFirstTaskLedger {
  private chain:Promise<unknown>=Promise.resolve();
  constructor(private readonly profile:string){if(!path.isAbsolute(profile))throw Error('TASK_PROFILE_INVALID');}
  private filename(){return path.join(this.profile,FILE);}
  private serialized<T>(action:()=>Promise<T>):Promise<T>{
    const result=this.chain.then(action);this.chain=result.catch(()=>undefined);return result;
  }
  private validateTask(t:unknown):asserts t is DurableTask {
    if(!t||typeof t!=='object'||Array.isArray(t))throw Error('TASK_RECORD_INVALID');
    const row=t as Partial<DurableTask>;
    const phases:TaskPhase[]=['active','waiting','paused','recovery-hold','review','completed','cancelled'];
    if(!validString(row.id,36,36)||!IDENT.test(row.id)||!validString(row.projectId,10,90)||
      !validString(row.projectRoot,1,4096)||!path.isAbsolute(row.projectRoot)||
      row.projectRoot!==path.resolve(row.projectRoot)||!Number.isSafeInteger(row.rootDev)||
      !Number.isSafeInteger(row.rootIno)||!validString(row.goal,1,2000)||
      !row.phase||!phases.includes(row.phase)||!Number.isSafeInteger(row.revision)||
      !Number.isSafeInteger(row.createdAt)||!Number.isSafeInteger(row.updatedAt)||
      (row.waitUntil!==null&&!Number.isSafeInteger(row.waitUntil))||
      !Array.isArray(row.events)||row.events.length>EVENT_LIMIT)
      throw Error('TASK_RECORD_INVALID');
    let last=0;
    const events:TaskEventKind[]=['created','checkpoint','waiting','paused','resume-approved','review-requested','finished','cancelled','recovery-held'];
    for(const ev of row.events){
      if(!ev||typeof ev!=='object'||!events.includes(ev.kind)||!Number.isSafeInteger(ev.revision)||
        ev.revision<=last||!Number.isSafeInteger(ev.at)||
        (ev.note!==null&&!validString(ev.note,1,NOTE_MAX))||
        (ev.nonce!==null&&!validString(ev.nonce,8,100)))throw Error('TASK_EVENT_INVALID');
      last=ev.revision;
    }
    if(last!==row.revision)throw Error('TASK_REVISION_INVALID');
  }
  private async read():Promise<TaskSnapshot>{
    let stat;
    try{stat=await fs.lstat(this.filename());}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {version:1,tasks:[]};throw error;}
    if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||
      (process.getuid&&stat.uid!==process.getuid())||stat.size>MAX_BYTES)
      throw Error('TASK_LEDGER_UNSAFE');
    const handle=await fs.open(this.filename(),constants.O_RDONLY|constants.O_NOFOLLOW);
    let data:string;
    try{data=await handle.readFile({encoding:'utf8'});}finally{await handle.close();}
    const decoded:unknown=JSON.parse(data);
    if(!decoded||typeof decoded!=='object'||Array.isArray(decoded))throw Error('TASK_LEDGER_INVALID');
    const ledger=decoded as Partial<TaskSnapshot>;
    if(ledger.version!==1||!Array.isArray(ledger.tasks)||ledger.tasks.length>LIMIT)
      throw Error('TASK_LEDGER_INVALID');
    const ids=new Set<string>();
    for(const task of ledger.tasks){this.validateTask(task);
      if(ids.has(task.id))throw Error('TASK_DUPLICATE_ID');ids.add(task.id);
    }
    return ledger as TaskSnapshot;
  }
  private async write(snapshot:TaskSnapshot){
    await fs.mkdir(this.profile,{recursive:true,mode:0o700});
    const data=JSON.stringify(snapshot)+'\n';
    if(Buffer.byteLength(data)>MAX_BYTES)throw Error('TASK_LEDGER_CAP_EXCEEDED');
    const temp=path.join(this.profile,'.web-first-task-'+randomUUID()+'.tmp');
    try{
      const fd=await fs.open(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL,0o600);
      try{await fd.writeFile(data,'utf8');await fd.sync();}finally{await fd.close();}
      await fs.rename(temp,this.filename());
    }finally{await fs.rm(temp,{force:true});}
  }
  async list():Promise<ReadonlyArray<DurableTask>>{return (await this.read()).tasks;}
  async get(id:string):Promise<DurableTask>{
    const task=(await this.read()).tasks.find(x=>x.id===id);
    if(!task)throw Error('TASK_NOT_FOUND');return task;
  }
  async begin(args:{projectId:string;projectRoot:string;goal:string}):Promise<DurableTask>{
    if(!validString(args.goal)||!validString(args.projectId,10,90))throw Error('TASK_INPUT_INVALID');
    const real=await fs.realpath(args.projectRoot),st=await fs.lstat(args.projectRoot);
    if(real!==args.projectRoot||!st.isDirectory()||st.isSymbolicLink())throw Error('TASK_PROJECT_UNSAFE');
    return this.serialized(async()=>{
      const ledger=await this.read();if(ledger.tasks.length>=LIMIT)throw Error('TASK_LIMIT');
      const now=Date.now();const task:DurableTask={id:randomUUID(),projectId:args.projectId,
        projectRoot:real,rootDev:st.dev,rootIno:st.ino,goal:args.goal,phase:'active',
        revision:1,createdAt:now,updatedAt:now,waitUntil:null,
        events:[{revision:1,at:now,kind:'created',nonce:null,note:null}]};
      ledger.tasks.push(task);await this.write(ledger);return task;
    });
  }
  private async mutate(id:string,expectedRevision:number,nonce:string|null,
    apply:(task:DurableTask)=>void):Promise<DurableTask>{
    return this.serialized(async()=>{
      const ledger=await this.read(),task=ledger.tasks.find(x=>x.id===id);
      if(!task)throw Error('TASK_NOT_FOUND');
      if(nonce!==null){
        if(!validString(nonce,8,100))throw Error('TASK_NONCE_INVALID');
        if(task.events.some(e=>e.nonce===nonce))return task; // idempotent after retry
      }
      if(task.revision!==expectedRevision)throw Error('TASK_STALE_REVISION');
      const real=await fs.realpath(task.projectRoot),st=await fs.lstat(task.projectRoot);
      if(real!==task.projectRoot||st.dev!==task.rootDev||st.ino!==task.rootIno||
        !st.isDirectory()||st.isSymbolicLink())throw Error('TASK_PROJECT_CHANGED');
      apply(task);await this.write(ledger);return task;
    });
  }
  async checkpoint(id:string,revision:number,nonce:string,note:string):Promise<DurableTask>{
    if(!validString(note,1,NOTE_MAX))throw Error('TASK_NOTE_INVALID');
    return this.mutate(id,revision,nonce,task=>{
      if(task.phase!=='active')throw Error('TASK_NOT_ACTIVE');
      event(task,'checkpoint',note,nonce);
    });
  }
  async wait(id:string,revision:number,nonce:string,minutes:number|null):Promise<DurableTask>{
    if(minutes!==null&&(!Number.isInteger(minutes)||minutes<1||minutes>7*24*60))
      throw Error('TASK_WAIT_INVALID');
    return this.mutate(id,revision,nonce,task=>{
      if(task.phase!=='active')throw Error('TASK_NOT_ACTIVE');
      task.phase='waiting';task.waitUntil=minutes===null?null:Date.now()+minutes*60_000;
      event(task,'waiting',minutes===null?'manual':`timer:${minutes}`,nonce);
    });
  }
  async requestReview(id:string,revision:number,nonce:string,note:string):Promise<DurableTask>{
    if(!validString(note,1,NOTE_MAX))throw Error('TASK_NOTE_INVALID');
    return this.mutate(id,revision,nonce,task=>{
      if(task.phase!=='active')throw Error('TASK_NOT_ACTIVE');
      task.phase='review';event(task,'review-requested',note,nonce);
    });
  }
  async nativeDecision(id:string,revision:number,choice:'resume'|'complete'|'cancel'):Promise<DurableTask>{
    return this.mutate(id,revision,null,task=>{
      if(choice==='resume'){
        if(!['paused','waiting','recovery-hold','review'].includes(task.phase))throw Error('TASK_CANNOT_RESUME');
        task.phase='active';task.waitUntil=null;event(task,'resume-approved');return;
      }
      if(choice==='complete'){
        if(task.phase!=='review')throw Error('TASK_NEEDS_REVIEW');
        task.phase='completed';task.waitUntil=null;event(task,'finished');return;
      }
      if(task.phase==='completed'||task.phase==='cancelled')throw Error('TASK_ALREADY_TERMINAL');
      task.phase='cancelled';task.waitUntil=null;event(task,'cancelled');
    });
  }
  async holdInterruptedTasks():Promise<number>{
    return this.serialized(async()=>{
      const ledger=await this.read();let modified=0;
      for(const task of ledger.tasks){
        if(task.phase==='active'){
          task.phase='recovery-hold';event(task,'recovery-held');modified++;
        }
      }
      if(modified)await this.write(ledger);return modified;
    });
  }
}
