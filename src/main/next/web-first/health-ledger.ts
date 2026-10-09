/**
 * Native-only crash-resistant Web-First health events.
 * Events are whitelisted categories, not URLs, headers, cookies, DOM, chat
 * messages, conversation IDs or exception strings. Never a credential store.
 */
import {randomUUID} from 'node:crypto';
import {constants,promises as fs} from 'node:fs';
import path from 'node:path';

export type NativeHealthKind='app-started'|'main-frame-http-error'|
  'api-rate-limited'|'main-frame-network-error'|'web-renderer-gone'|
  'page-empty'|'page-recovered';
export type NativeHealthRoute='chatgpt-main'|'conversation-list'|'other-api'|'not-applicable';
export interface NativeHealthReceipt {
  version:1;id:string;at:number;kind:NativeHealthKind;
  route:NativeHealthRoute;status:number|null;code:number|null;
}
const FILENAME='web-first-health.jsonl';
const MAX_LOG_BYTES=512*1024;
const KINDS=new Set<NativeHealthKind>(['app-started','main-frame-http-error',
  'api-rate-limited','main-frame-network-error','web-renderer-gone',
  'page-empty','page-recovered']);
const ROUTES=new Set<NativeHealthRoute>(['chatgpt-main','conversation-list',
  'other-api','not-applicable']);
const ID=/^[0-9a-f-]{36}$/i;
function verify(receipt:unknown):asserts receipt is NativeHealthReceipt{
  if(!receipt||typeof receipt!=='object'||Array.isArray(receipt))throw Error('WEB_HEALTH_RECEIPT_INVALID');
  const r=receipt as Partial<NativeHealthReceipt>;
  if(r.version!==1||typeof r.id!=='string'||!ID.test(r.id)||
    !Number.isSafeInteger(r.at)||!r.kind||!KINDS.has(r.kind)||
    !r.route||!ROUTES.has(r.route)||
    (r.status!==null&&(typeof r.status!=='number'||!Number.isInteger(r.status)||r.status<100||r.status>599))||
    (r.code!==null&&(typeof r.code!=='number'||!Number.isInteger(r.code)||Math.abs(r.code)>100000)))
    throw Error('WEB_HEALTH_RECEIPT_INVALID');
  if(Object.keys(r).sort().join('|')!==
    ['at','code','id','kind','route','status','version'].join('|'))
    throw Error('WEB_HEALTH_UNEXPECTED_FIELDS');
}
export class WebFirstHealthLedger {
  private chain:Promise<unknown>=Promise.resolve();
  constructor(private readonly profile:string){
    if(!path.isAbsolute(profile))throw Error('WEB_HEALTH_PROFILE_NOT_ABSOLUTE');
  }
  private file(){return path.join(this.profile,FILENAME);}
  private async safeExistingFile():Promise<void>{
    let stat;
    try{stat=await fs.lstat(this.file());}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
    if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||
      (process.getuid&&stat.uid!==process.getuid())||stat.size>MAX_LOG_BYTES)
      throw Error('WEB_HEALTH_LEDGER_UNSAFE');
  }
  async last(count=20):Promise<ReadonlyArray<NativeHealthReceipt>>{
    await this.safeExistingFile();
    let fd;
    try{fd=await fs.open(this.file(),constants.O_RDONLY|constants.O_NOFOLLOW);}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error;}
    try{
      const content=await fd.readFile({encoding:'utf8'});
      if(Buffer.byteLength(content,'utf8')>MAX_LOG_BYTES)throw Error('WEB_HEALTH_LEDGER_UNSAFE');
      const rows=content.trim().split('\n').filter(Boolean);
      return rows.slice(-Math.max(1,Math.min(100,count))).map(line=>{
        const raw:unknown=JSON.parse(line);verify(raw);return raw;
      });
    }finally{await fd.close();}
  }
  async record(value:{kind:NativeHealthKind;route:NativeHealthRoute;
    status:number|null;code:number|null}):Promise<NativeHealthReceipt>{
    const entry:NativeHealthReceipt={version:1,id:randomUUID(),at:Date.now(),...value};
    verify(entry);
    const write=async()=>{
      await fs.mkdir(this.profile,{recursive:true,mode:0o700});
      await this.safeExistingFile();
      const fd=await fs.open(this.file(),constants.O_WRONLY|constants.O_CREAT|
        constants.O_APPEND|constants.O_NOFOLLOW,0o600);
      try{
        const stat=await fd.stat(),line=JSON.stringify(entry)+'\n';
        if(!stat.isFile()||(stat.mode&0o077)!==0||
          (process.getuid&&stat.uid!==process.getuid())||
          stat.size+Buffer.byteLength(line)>MAX_LOG_BYTES)
          throw Error('WEB_HEALTH_LEDGER_UNSAFE_OR_FULL');
        await fd.writeFile(line);await fd.sync();
      }finally{await fd.close();}
      return entry;
    };
    const result=this.chain.then(write);
    this.chain=result.catch(()=>undefined);
    return result;
  }
}
