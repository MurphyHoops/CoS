/**
 * P3.4-A native-only, persist-first diagnostic queue. No MCP / ChatGPT caller
 * can enqueue an action. One exact native approval precedes each job.
 * Read-only operations are explicitly catalogued; no shell or arbitrary argv.
 */
import {randomUUID,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {promises as fs,constants} from 'node:fs';
import path from 'node:path';
import type {WebFirstTaskLedger} from './task-ledger.js';
import type {WebFirstPlanLedger} from './plan-ledger.js';
export type LocalCheckKind='root-check'|'git-status'|'git-head'|'git-tracked';
export type LocalJobState='queued'|'running'|'succeeded'|'failed'|'review';
export interface LocalCheckJob {
  id:string;taskId:string;projectId:string;kind:LocalCheckKind;
  taskRevision:number;planRevision:number;nonce:string;
  projectDev:number;projectIno:number;approvedAt:number;
  state:LocalJobState;createdAt:number;startedAt:number|null;finishedAt:number|null;
  exitCode:number|null;changedCount:number|null;outputDigest:string|null;reason:string|null;
}
const FILE='web-first-local-jobs.json',MAX=160*1024,COUNT=64;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX=/^[a-f0-9]{64}$/i;
const KINDS:LocalCheckKind[]=['root-check','git-status','git-head','git-tracked'];
const LANES:readonly LocalCheckKind[]=['root-check','git-status','git-head','git-tracked'];
const STATES:LocalJobState[]=['queued','running','succeeded','failed','review'];
function validJob(value:unknown):asserts value is LocalCheckJob{
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('LOCAL_JOB_RECORD_INVALID');
  const j=value as Partial<LocalCheckJob>;
  const required=['id','taskId','projectId','kind','taskRevision','planRevision','nonce',
    'projectDev','projectIno','approvedAt','state','createdAt','startedAt','finishedAt',
    'exitCode','changedCount','outputDigest','reason'];
  const whole=(n:unknown)=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0;
  const time=(n:unknown)=>n===null||whole(n);
  if(Object.keys(j).sort().join('|')!==required.sort().join('|')||
    !UUID.test(String(j.id))||!UUID.test(String(j.taskId))||!UUID.test(String(j.nonce))||
    typeof j.projectId!=='string'||j.projectId.length<10||j.projectId.length>90||
    !KINDS.includes(j.kind as LocalCheckKind)||!STATES.includes(j.state as LocalJobState)||
    !whole(j.taskRevision)||Number(j.taskRevision)<1||!whole(j.planRevision)||
    !whole(j.projectDev)||!whole(j.projectIno)||!whole(j.approvedAt)||!whole(j.createdAt)||
    !time(j.startedAt)||!time(j.finishedAt)||
    (j.exitCode!==null&&(!Number.isSafeInteger(j.exitCode)||typeof j.exitCode!=='number'||j.exitCode<0||j.exitCode>255))||
    (j.changedCount!==null&&(!whole(j.changedCount)||Number(j.changedCount)>100000))||
    (j.outputDigest!==null&&(typeof j.outputDigest!=='string'||!HEX.test(j.outputDigest)))||
    (j.reason!==null&&(typeof j.reason!=='string'||!/^LOCAL_[A-Z_]{1,72}$/.test(j.reason)))||
    (j.state==='queued'&&(j.startedAt!==null||j.finishedAt!==null))||
    (j.state==='running'&&(j.startedAt===null||j.finishedAt!==null))||
    (['succeeded','failed','review'].includes(String(j.state))&&j.finishedAt===null))
    throw Error('LOCAL_JOB_RECORD_INVALID');
}
interface Snapshot {version:1;jobs:LocalCheckJob[];}
export class WebFirstLocalJobQueue {
  private chain:Promise<unknown>=Promise.resolve();
  private readonly cancelling=new Map<string,{taskId:string;cancel:()=>void}>();
  constructor(private readonly profile:string,private readonly tasks:WebFirstTaskLedger,
    private readonly plans:WebFirstPlanLedger,
    private readonly approve:(request:{kind:LocalCheckKind|'worker-team';goal:string;projectId:string;size?:number})=>Promise<boolean>){
    if(!path.isAbsolute(profile))throw Error('LOCAL_JOB_PROFILE_INVALID');
  }
  private file(){return path.join(this.profile,FILE);}
  private locked<T>(f:()=>Promise<T>):Promise<T>{
    const p=this.chain.then(f);this.chain=p.catch(()=>undefined);return p;
  }
  private async read():Promise<Snapshot>{
    let st;
    try{st=await fs.lstat(this.file());}
    catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return {version:1,jobs:[]};throw e;}
    if(!st.isFile()||st.isSymbolicLink()||(st.mode&0o077)!==0||
      (process.getuid&&st.uid!==process.getuid())||st.size>MAX)
      throw Error('LOCAL_JOB_LEDGER_UNSAFE');
    const fd=await fs.open(this.file(),constants.O_RDONLY|constants.O_NOFOLLOW);
    let data:string;
    try{
      const actual=await fd.stat();
      if(actual.ino!==st.ino||actual.dev!==st.dev)throw Error('LOCAL_JOB_LEDGER_CHANGED');
      data=await fd.readFile({encoding:'utf8'});
    }finally{await fd.close();}
    const parsed:unknown=JSON.parse(data);
    if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw Error('LOCAL_JOB_LEDGER_INVALID');
    const v=parsed as Partial<Snapshot>;
    if(Object.keys(v).sort().join('|')!=='jobs|version'||v.version!==1||
      !Array.isArray(v.jobs)||v.jobs.length>COUNT)throw Error('LOCAL_JOB_LEDGER_INVALID');
    const ids=new Set<string>(),nonces=new Set<string>();
    for(const j of v.jobs){validJob(j);
      if(ids.has(j.id)||nonces.has(j.nonce))throw Error('LOCAL_JOB_DUPLICATE');
      ids.add(j.id);nonces.add(j.nonce);
    }
    return v as Snapshot;
  }
  private async write(snapshot:Snapshot):Promise<void>{
    await fs.mkdir(this.profile,{recursive:true,mode:0o700});
    const data=JSON.stringify(snapshot)+'\n';
    if(Buffer.byteLength(data)>MAX)throw Error('LOCAL_JOB_LEDGER_FULL');
    const temp=path.join(this.profile,'.web-first-local-job-'+randomUUID()+'.tmp');
    try{
      const fd=await fs.open(temp,constants.O_EXCL|constants.O_CREAT|constants.O_WRONLY,0o600);
      try{await fd.writeFile(data,'utf8');await fd.sync();}finally{await fd.close();}
      await fs.rename(temp,this.file());
      // A crash must not falsely indicate a durable start/exit record.
      if(process.platform!=='win32'){
        const dir=await fs.open(this.profile,constants.O_RDONLY);
        try{await dir.sync();}finally{await dir.close();}
      }
    }finally{await fs.rm(temp,{force:true});}
  }
  async list():Promise<ReadonlyArray<LocalCheckJob>>{return (await this.read()).jobs;}
  async get(id:string):Promise<LocalCheckJob>{
    const job=(await this.read()).jobs.find(j=>j.id===id);
    if(!job)throw Error('LOCAL_JOB_NOT_FOUND');return job;
  }
  /** At boot, ambiguous children are HELD. A queued job is not auto-launched. */
  async holdInterrupted():Promise<number>{return this.locked(async()=>{
    const data=await this.read(),now=Date.now();let held=0;
    for(const job of data.jobs){
      if(job.state==='running'||job.state==='queued'){
        const running=job.state==='running';
        job.state='review';job.finishedAt=now;
        job.reason=running?'LOCAL_JOB_INTERRUPTED_UNCERTAIN':'LOCAL_JOB_NOT_DISPATCHED_REVIEW';held++;
      }
    }
    if(held)await this.write(data);return held;
  });}
  async enqueue(args:{taskId:string;taskRevision:number;planRevision:number;
    kind:LocalCheckKind;nonce:string}):Promise<LocalCheckJob>{
    if(!UUID.test(args.nonce)||!KINDS.includes(args.kind)||
      !Number.isSafeInteger(args.taskRevision)||args.taskRevision<1||
      !Number.isSafeInteger(args.planRevision)||args.planRevision<0)
      throw Error('LOCAL_JOB_REQUEST_INVALID');
    return this.locked(async()=>{
      const snap=await this.read(),old=snap.jobs.find(x=>x.nonce===args.nonce);
      if(old){
        if(old.taskId!==args.taskId||old.kind!==args.kind||
          old.taskRevision!==args.taskRevision||old.planRevision!==args.planRevision)
          throw Error('LOCAL_JOB_NONCE_CONFLICT');
        return old;
      }
      if(snap.jobs.length>=COUNT)throw Error('LOCAL_JOB_QUEUE_FULL');
      const task=await this.tasks.get(args.taskId),plan=await this.plans.status(args.taskId);
      if(task.phase!=='active'||task.revision!==args.taskRevision||
        (plan?.revision??0)!==args.planRevision)throw Error('LOCAL_JOB_TASK_STALE_OR_INACTIVE');
      if(snap.jobs.some(x=>x.taskId===task.id&&['queued','running'].includes(x.state)))
        throw Error('LOCAL_JOB_TASK_BUSY');
      const before=await fs.realpath(task.projectRoot),stat=await fs.lstat(task.projectRoot);
      if(before!==task.projectRoot||!stat.isDirectory()||stat.isSymbolicLink()||
        stat.dev!==task.rootDev||stat.ino!==task.rootIno)
        throw Error('LOCAL_JOB_PROJECT_CHANGED');
      if(!await this.approve({kind:args.kind,goal:task.goal,projectId:task.projectId}))
        throw Error('LOCAL_JOB_APPROVAL_DENIED');
      // A native approval dialog may take minutes. Reconcile the task again.
      const rechecked=await this.tasks.get(task.id),latest=await this.plans.status(task.id);
      if(rechecked.phase!=='active'||rechecked.revision!==args.taskRevision||
        (latest?.revision??0)!==args.planRevision)throw Error('LOCAL_JOB_TASK_STALE_OR_INACTIVE');
      const again=await fs.lstat(task.projectRoot);
      if(!again.isDirectory()||again.isSymbolicLink()||again.dev!==stat.dev||again.ino!==stat.ino)
        throw Error('LOCAL_JOB_PROJECT_CHANGED');
      const now=Date.now();
      const job:LocalCheckJob={id:randomUUID(),taskId:task.id,projectId:task.projectId,
        kind:args.kind,taskRevision:args.taskRevision,planRevision:args.planRevision,
        nonce:args.nonce,projectDev:stat.dev,projectIno:stat.ino,approvedAt:now,
        state:'queued',createdAt:now,startedAt:null,finishedAt:null,
        exitCode:null,changedCount:null,outputDigest:null,reason:null};
      snap.jobs.push(job);await this.write(snap);return {...job};
    });
  }
  /** One bounded native grant for a fixed, non-mutating team of 2–4 slots.
   * Every slot has its own durable identity and exit receipt. The team cannot
   * inherit a model credential or claim completion of the parent Goal.
   */
  async enqueueTeam(args:{taskId:string;taskRevision:number;planRevision:number;size:2|3|4;
    nonce:string}):Promise<ReadonlyArray<LocalCheckJob>>{
    if(!UUID.test(args.nonce)||![2,3,4].includes(args.size)||
      !Number.isSafeInteger(args.taskRevision)||args.taskRevision<1||
      !Number.isSafeInteger(args.planRevision)||args.planRevision<0)
      throw Error('LOCAL_WORKER_TEAM_INVALID');
    return this.locked(async()=>{
      const ledger=await this.read();
      // A repeated native click cannot silently mint another accepted team.
      if(ledger.jobs.some(j=>j.nonce===args.nonce))throw Error('LOCAL_WORKER_TEAM_NONCE_REUSED');
      if(ledger.jobs.length+args.size>COUNT)throw Error('LOCAL_JOB_QUEUE_FULL');
      const task=await this.tasks.get(args.taskId),plan=await this.plans.status(args.taskId);
      if(task.phase!=='active'||task.revision!==args.taskRevision||
        (plan?.revision??0)!==args.planRevision)throw Error('LOCAL_JOB_TASK_STALE_OR_INACTIVE');
      if(ledger.jobs.some(j=>j.taskId===task.id&&['queued','running'].includes(j.state)))
        throw Error('LOCAL_JOB_TASK_BUSY');
      const real=await fs.realpath(task.projectRoot),st=await fs.lstat(task.projectRoot);
      if(real!==task.projectRoot||!st.isDirectory()||st.isSymbolicLink()||
        st.dev!==task.rootDev||st.ino!==task.rootIno)throw Error('LOCAL_JOB_PROJECT_CHANGED');
      if(!await this.approve({kind:'worker-team',goal:task.goal,
        projectId:task.projectId,size:args.size}))throw Error('LOCAL_JOB_APPROVAL_DENIED');
      const after=await this.tasks.get(task.id),freshPlan=await this.plans.status(task.id);
      const changed=await fs.lstat(task.projectRoot),canonical=await fs.realpath(task.projectRoot);
      if(after.revision!==args.taskRevision||after.phase!=='active'||
        (freshPlan?.revision??0)!==args.planRevision||
        changed.ino!==st.ino||changed.dev!==st.dev||!changed.isDirectory()||
        changed.isSymbolicLink()||canonical!==task.projectRoot)
        throw Error('LOCAL_JOB_TASK_STALE_OR_INACTIVE');
      const now=Date.now();
      const jobs=LANES.slice(0,args.size).map((kind,index):LocalCheckJob=>({
        id:randomUUID(),taskId:task.id,projectId:task.projectId,
        kind,taskRevision:args.taskRevision,planRevision:args.planRevision,
        nonce:index===0?args.nonce:randomUUID(),projectDev:st.dev,
        projectIno:st.ino,approvedAt:now,state:'queued',createdAt:now,
        startedAt:null,finishedAt:null,exitCode:null,changedCount:null,
        outputDigest:null,reason:null
      }));
      ledger.jobs.push(...jobs);await this.write(ledger);
      return jobs;
    });
  }
  /** Starts each independently fenced slot without serializing the child work. */
  async runTeam(ids:ReadonlyArray<string>):Promise<ReadonlyArray<LocalCheckJob>>{
    if(ids.length<2||ids.length>4||new Set(ids).size!==ids.length||
      ids.some(id=>!UUID.test(id)))throw Error('LOCAL_WORKER_TEAM_INVALID');
    const initial=await this.read();
    const children=ids.map(id=>initial.jobs.find(j=>j.id===id));
    if(children.some(j=>!j||j.state!=='queued')||
      new Set(children.map(j=>j?.taskId)).size!==1||
      new Set(children.map(j=>j?.approvedAt)).size!==1||
      new Set(children.map(j=>j?.kind)).size!==ids.length)
      throw Error('LOCAL_WORKER_TEAM_MISMATCH');
    return Promise.all(ids.map(id=>this.run(id)));
  }
  /** Native user-approved diagnostic only. Queued items require explicit run. */
  async run(id:string):Promise<LocalCheckJob>{
    const started=await this.locked(async():Promise<{job:LocalCheckJob;root:string}|null>=>{
      const snap=await this.read(),job=snap.jobs.find(x=>x.id===id);
      if(!job)throw Error('LOCAL_JOB_NOT_FOUND');
      if(job.state!=='queued')return null;
      const task=await this.tasks.get(job.taskId),plan=await this.plans.status(job.taskId);
      if(task.phase!=='active'||task.revision!==job.taskRevision||
        (plan?.revision??0)!==job.planRevision||task.projectId!==job.projectId||
        task.rootDev!==job.projectDev||task.rootIno!==job.projectIno){
        job.state='review';job.finishedAt=Date.now();job.reason='LOCAL_JOB_CONTEXT_CHANGED';
        await this.write(snap);return null;
      }
      try{
        const real=await fs.realpath(task.projectRoot),st=await fs.lstat(task.projectRoot);
        if(real!==task.projectRoot||st.dev!==job.projectDev||st.ino!==job.projectIno||
          !st.isDirectory()||st.isSymbolicLink())throw Error('CHANGED');
      }catch{
        job.state='review';job.finishedAt=Date.now();job.reason='LOCAL_JOB_PROJECT_CHANGED';
        await this.write(snap);return null;
      }
      job.state='running';job.startedAt=Date.now();await this.write(snap);
      return {job:{...job},root:task.projectRoot};
    });
    if(!started)return this.get(id);
    const outcome=started.job.kind==='root-check'?
      {exitCode:0 as number|null,changedCount:null as number|null,
        outputDigest:createHash('sha256').update(JSON.stringify({kind:'root-check',
          taskId:started.job.taskId,dev:started.job.projectDev,ino:started.job.projectIno})).digest('hex'),
        reason:null as string|null}:
      await this.gitStatus(started.root,id,started.job.taskId,started.job.kind);
    return this.locked(async()=>{
      const snap=await this.read(),job=snap.jobs.find(x=>x.id===id);
      if(!job)throw Error('LOCAL_JOB_NOT_FOUND');
      if(job.state!=='running')return job; // concurrent stop/recovery takes precedence
      job.state=outcome.exitCode===0?'succeeded':
        outcome.reason==='LOCAL_JOB_OPERATOR_STOPPED'?'review':'failed';
      job.finishedAt=Date.now();
      job.exitCode=outcome.exitCode;job.changedCount=outcome.changedCount;
      job.outputDigest=outcome.outputDigest;job.reason=outcome.reason;
      await this.write(snap);return {...job};
    });
  }
  /** Only preselected Git status, never an interpolated shell / arbitrary command. */
  private async gitStatus(root:string,id:string,taskId:string,kind:LocalCheckKind):Promise<{
    exitCode:number|null;changedCount:number|null;outputDigest:string|null;reason:string|null}>{
    return new Promise(resolve=>{
      let settled=false,cut=false,timedOut=false,cancelled=false;
      let data='',bytes=0;const hash=createHash('sha256');
      const prefix=['--no-optional-locks','-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null'];
      const exact=kind==='git-status'?['status','--porcelain=v1','--untracked-files=no','--no-renames']:
        kind==='git-head'?['rev-parse','--verify','HEAD']:
        kind==='git-tracked'?['ls-files','-z']:null;
      if(!exact){resolve({exitCode:null,changedCount:null,outputDigest:null,
        reason:'LOCAL_JOB_KIND_INVALID'});return;}
      const child=spawn('/usr/bin/git',[...prefix,...exact],{
        cwd:root,shell:false,detached:process.platform!=='win32',windowsHide:true,
        env:{PATH:'/usr/bin:/bin',HOME:'/nonexistent',GIT_OPTIONAL_LOCKS:'0',
          GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0'},stdio:['ignore','pipe','pipe']
      });
      const terminate=()=>{
        if(child.pid){try{if(process.platform!=='win32')process.kill(-child.pid,'SIGTERM');
          else child.kill('SIGTERM');}catch{child.kill('SIGTERM');}}
      };
      this.cancelling.set(id,{taskId,cancel:()=>{cancelled=true;terminate();}});
      const timer=setTimeout(()=>{timedOut=true;terminate();},10_000);
      const hard=setTimeout(()=>{if(!settled&&child.pid){try{
        if(process.platform!=='win32')process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL');
      }catch{/* child may already exit */}}},12_000);
      const consume=(tag:string)=>(chunk:Buffer)=>{
        bytes+=chunk.length;
        if(bytes>32*1024){cut=true;terminate();return;}
        hash.update(tag).update(chunk);if(tag==='out')data+=chunk.toString('utf8');
      };
      child.stdout?.on('data',consume('out'));child.stderr?.on('data',consume('err'));
      const finish=(code:number|null)=>{
        if(settled)return;settled=true;clearTimeout(timer);clearTimeout(hard);
        this.cancelling.delete(id);
        const reason=cut?'LOCAL_JOB_OUTPUT_LIMIT':timedOut?'LOCAL_JOB_TIMEOUT':
          cancelled?'LOCAL_JOB_OPERATOR_STOPPED':code===0?null:'LOCAL_JOB_GIT_FAILED';
        const count=kind==='git-status'?data.split('\n').filter(Boolean).length:
          kind==='git-tracked'?data.split('\0').filter(Boolean).length:null;
        resolve({exitCode:cut||timedOut||cancelled?null:code,
          changedCount:cut||timedOut||cancelled||code!==0?null:count,
          outputDigest:cut?null:hash.digest('hex'),reason});
      };
      child.once('error',()=>finish(null));child.once('close',code=>finish(code));
    });
  }
  stopTask(taskId:string):void{
    for(const item of this.cancelling.values())if(item.taskId===taskId)item.cancel();
  }
  stopActive():void{for(const item of this.cancelling.values())item.cancel();}
}
