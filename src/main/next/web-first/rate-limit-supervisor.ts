/**
 * Durable model-limit hold. A history-list 429 is NOT proof that model
 * inference is exhausted. Never bypass website/provider use limits.
 * Cooldown expiry allows human re-check, not unattended model submission.
 */
import {randomUUID} from 'node:crypto';
import {constants,promises as fs} from 'node:fs';
import path from 'node:path';
export type ThrottleReason='manual-model-limit'|'other-chatgpt-api-429';
export interface ThrottleState {
  version:1;modelHoldUntil:number|null;modelReason:ThrottleReason|null;
  operatorReviewRequired:boolean;historyHoldUntil:number|null;
  history429Count:number;other429Count:number;updatedAt:number;
}
export type RateLimitStatus={model:'clear'|'cooldown'|'review';
  reason:ThrottleReason|null;modelHoldUntil:number|null;
  history:'normal'|'degraded';historyHoldUntil:number|null;
  history429Count:number;other429Count:number};
const FILE='web-first-rate-limit.json';
const MAX_BYTES=4096;
const initial=():ThrottleState=>({version:1,modelHoldUntil:null,modelReason:null,
  operatorReviewRequired:false,historyHoldUntil:null,history429Count:0,
  other429Count:0,updatedAt:Date.now()});
function validate(o:unknown):asserts o is ThrottleState {
  if(!o||typeof o!=='object'||Array.isArray(o))throw Error('RATE_LIMIT_LEDGER_INVALID');
  const x=o as Partial<ThrottleState>;
  const validTime=(n:unknown)=>n===null||(typeof n==='number'&&Number.isSafeInteger(n)&&n>=0);
  if(x.version!==1||!validTime(x.modelHoldUntil)||!validTime(x.historyHoldUntil)||
    (x.modelReason!==null&&x.modelReason!=='manual-model-limit'&&x.modelReason!=='other-chatgpt-api-429')||
    typeof x.operatorReviewRequired!=='boolean'||
    !Number.isSafeInteger(x.history429Count)||!Number.isSafeInteger(x.other429Count)||
    typeof x.history429Count!=='number'||typeof x.other429Count!=='number'||
    x.history429Count<0||x.other429Count<0||
    !Number.isSafeInteger(x.updatedAt)||typeof x.updatedAt!=='number'||
    Object.keys(x).sort().join('|')!==
      ['history429Count','historyHoldUntil','modelHoldUntil','modelReason',
        'operatorReviewRequired','other429Count','updatedAt','version'].join('|'))
    throw Error('RATE_LIMIT_LEDGER_INVALID');
}
export class WebFirstRateLimitSupervisor {
  private chain:Promise<unknown>=Promise.resolve();
  constructor(private readonly profile:string){
    if(!path.isAbsolute(profile))throw Error('RATE_LIMIT_PROFILE_INVALID');
  }
  private filepath(){return path.join(this.profile,FILE);}
  private serialized<T>(call:()=>Promise<T>):Promise<T>{
    const result=this.chain.then(call);this.chain=result.catch(()=>undefined);return result;
  }
  private async load():Promise<ThrottleState>{
    let st;
    try{st=await fs.lstat(this.filepath());}
    catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return initial();throw e;}
    if(!st.isFile()||st.isSymbolicLink()||(st.mode&0o077)!==0||
      (process.getuid&&st.uid!==process.getuid())||st.size>MAX_BYTES)
      throw Error('RATE_LIMIT_LEDGER_UNSAFE');
    const fd=await fs.open(this.filepath(),constants.O_RDONLY|constants.O_NOFOLLOW);
    try{const value:unknown=JSON.parse(await fd.readFile({encoding:'utf8'}));validate(value);return value;}
    finally{await fd.close();}
  }
  private async write(value:ThrottleState){
    validate(value);
    await fs.mkdir(this.profile,{recursive:true,mode:0o700});
    const data=JSON.stringify(value)+'\n';
    if(Buffer.byteLength(data)>MAX_BYTES)throw Error('RATE_LIMIT_LEDGER_OVERSIZE');
    const tmp=path.join(this.profile,'.rate-limit-'+randomUUID()+'.tmp');
    try{
      const fd=await fs.open(tmp,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY,0o600);
      try{await fd.writeFile(data,'utf8');await fd.sync();}finally{await fd.close();}
      await fs.rename(tmp,this.filepath());
    }finally{await fs.rm(tmp,{force:true});}
  }
  async status(now=Date.now()):Promise<RateLimitStatus>{
    const s=await this.load();
    const model=s.operatorReviewRequired?
      s.modelHoldUntil!==null&&now<s.modelHoldUntil?'cooldown':'review':'clear';
    return {model,reason:s.modelReason,modelHoldUntil:s.modelHoldUntil,
      history:s.historyHoldUntil!==null&&now<s.historyHoldUntil?'degraded':'normal',
      historyHoldUntil:s.historyHoldUntil,history429Count:s.history429Count,
      other429Count:s.other429Count};
  }
  /** CoS does not own ChatGPT website history fetches; record degradation only. */
  async history429(now=Date.now()):Promise<RateLimitStatus>{
    return this.serialized(async()=>{
      const s=await this.load();
      if(s.historyHoldUntil===null||now>=s.historyHoldUntil){
        s.history429Count=Math.min(s.history429Count+1,100000);
        const delay=Math.min(15*60_000,60_000*2**Math.min(4,s.history429Count-1));
        s.historyHoldUntil=now+delay;s.updatedAt=now;await this.write(s);
      }
      return this.derive(s,now);
    });
  }
  /** Unknown backend API 429 is held conservatively, never auto retried. */
  async backend429(now=Date.now()):Promise<RateLimitStatus>{
    return this.serialized(async()=>{
      const s=await this.load();
      if(s.modelHoldUntil===null||now>=s.modelHoldUntil){
        s.other429Count=Math.min(s.other429Count+1,100000);
        const delay=Math.min(30*60_000,2*60_000*2**Math.min(4,s.other429Count-1));
        s.modelHoldUntil=now+delay;s.modelReason='other-chatgpt-api-429';
        s.operatorReviewRequired=true;s.updatedAt=now;await this.write(s);
      }
      return this.derive(s,now);
    });
  }
  async pauseForModelLimit(minutes:15|30|60,now=Date.now()):Promise<RateLimitStatus>{
    return this.serialized(async()=>{
      const s=await this.load();
      s.modelHoldUntil=Math.max(s.modelHoldUntil??0,now+minutes*60_000);
      s.modelReason='manual-model-limit';s.operatorReviewRequired=true;
      s.updatedAt=now;await this.write(s);return this.derive(s,now);
    });
  }
  async confirmRecovery(now=Date.now()):Promise<RateLimitStatus>{
    return this.serialized(async()=>{
      const s=await this.load();
      // Operator can postpone recovery but cannot bypass their own cooldown.
      if(s.modelHoldUntil!==null&&now<s.modelHoldUntil)
        throw Error('RATE_LIMIT_COOLDOWN_NOT_DUE');
      s.modelHoldUntil=null;s.modelReason=null;s.operatorReviewRequired=false;
      s.updatedAt=now;await this.write(s);return this.derive(s,now);
    });
  }
  private derive(s:ThrottleState,now:number):RateLimitStatus{
    const model=s.operatorReviewRequired?
      s.modelHoldUntil!==null&&now<s.modelHoldUntil?'cooldown':'review':'clear';
    return {model,reason:s.modelReason,modelHoldUntil:s.modelHoldUntil,
      history:s.historyHoldUntil!==null&&now<s.historyHoldUntil?'degraded':'normal',
      historyHoldUntil:s.historyHoldUntil,history429Count:s.history429Count,
      other429Count:s.other429Count};
  }
  async requireManualModelAvailable(){
    const s=await this.status();
    if(s.model!=='clear')throw Error('RATE_LIMIT_MODEL_HOLD');
  }
}
