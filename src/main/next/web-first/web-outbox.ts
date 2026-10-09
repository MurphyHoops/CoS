/** Native-only single-message outbox for ChatGPT's embedded website. */
import {randomUUID} from 'node:crypto';
import {constants,promises as fs} from 'node:fs';
import path from 'node:path';
export type WebSendState='queued'|'dispatching'|'delivered'|'uncertain';
export interface NativeWebSend {
  id:string;taskId:string;conversationId:string;text:string;nonce:string;
  state:WebSendState;createdAt:number;updatedAt:number;proof:string|null;
}
const FILE='web-first-outbox.json';
const ID=/^[0-9a-f-]{36}$/i;
const MAX_SENDS=128,MAX_BYTES=300*1024;
function validate(value:unknown):asserts value is NativeWebSend{
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('OUTBOX_RECORD_INVALID');
  const row=value as Partial<NativeWebSend>;
  if(typeof row.id!=='string'||!ID.test(row.id)||typeof row.taskId!=='string'||!ID.test(row.taskId)||
    typeof row.conversationId!=='string'||!ID.test(row.conversationId)||
    typeof row.text!=='string'||row.text.length<1||row.text.length>2000||
    typeof row.nonce!=='string'||!ID.test(row.nonce)||
    !['queued','dispatching','delivered','uncertain'].includes(String(row.state))||
    !Number.isSafeInteger(row.createdAt)||!Number.isSafeInteger(row.updatedAt)||
    (row.proof!==null&&typeof row.proof!=='string'))throw Error('OUTBOX_RECORD_INVALID');
}
export class WebFirstWebOutbox {
  private queue:Promise<unknown>=Promise.resolve();
  constructor(private readonly profile:string){if(!path.isAbsolute(profile))throw Error('OUTBOX_PROFILE_INVALID');}
  private file(){return path.join(this.profile,FILE);}
  private serialized<T>(f:()=>Promise<T>){const p=this.queue.then(f);this.queue=p.catch(()=>undefined);return p;}
  private async load():Promise<NativeWebSend[]>{
    let st;
    try{st=await fs.lstat(this.file());}
    catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return [];throw e;}
    if(!st.isFile()||st.isSymbolicLink()||(st.mode&0o077)!==0||
      (process.getuid&&st.uid!==process.getuid())||st.size>MAX_BYTES)throw Error('OUTBOX_UNSAFE');
    const fd=await fs.open(this.file(),constants.O_RDONLY|constants.O_NOFOLLOW);
    let text:string;
    try{text=await fd.readFile({encoding:'utf8'});}finally{await fd.close();}
    const data:unknown=JSON.parse(text);
    if(!data||typeof data!=='object'||Array.isArray(data))throw Error('OUTBOX_INVALID');
    const payload=data as {version?:unknown;messages?:unknown};
    if(payload.version!==1||!Array.isArray(payload.messages)||payload.messages.length>MAX_SENDS)
      throw Error('OUTBOX_INVALID');
    for(const item of payload.messages)validate(item);
    if(new Set(payload.messages.map(x=>x.id)).size!==payload.messages.length)
      throw Error('OUTBOX_DUPLICATE_ID');
    return payload.messages;
  }
  private async persist(records:NativeWebSend[]){
    await fs.mkdir(this.profile,{recursive:true,mode:0o700});
    const contents=JSON.stringify({version:1,messages:records})+'\n';
    if(Buffer.byteLength(contents)>MAX_BYTES)throw Error('OUTBOX_FULL');
    const temp=path.join(this.profile,'.web-outbox-'+randomUUID()+'.tmp');
    try{
      const fd=await fs.open(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL,0o600);
      try{await fd.writeFile(contents);await fd.sync();}finally{await fd.close();}
      await fs.rename(temp,this.file());
    }finally{await fs.rm(temp,{force:true});}
  }
  async list(){return this.load();}
  async enqueue(data:{taskId:string;conversationId:string;text:string;nonce:string}){
    return this.serialized(async()=>{
      const rows=await this.load();
      const existing=rows.find(x=>x.nonce===data.nonce);
      if(existing){
        if(existing.taskId!==data.taskId||existing.conversationId!==data.conversationId||
          existing.text!==data.text)throw Error('OUTBOX_NONCE_CONFLICT');
        return existing;
      }
      const now=Date.now();const row:NativeWebSend={...data,id:randomUUID(),state:'queued',
        createdAt:now,updatedAt:now,proof:null};validate(row);
      if(rows.length>=MAX_SENDS)throw Error('OUTBOX_FULL');
      rows.push(row);await this.persist(rows);return row;
    });
  }
  async transition(id:string,from:WebSendState,to:WebSendState,proof:string|null=null){
    return this.serialized(async()=>{
      const rows=await this.load();const row=rows.find(x=>x.id===id);
      if(!row)throw Error('OUTBOX_NOT_FOUND');
      if(row.state!==from)throw Error('OUTBOX_STALE_STATE');
      const transitions:Partial<Record<WebSendState,WebSendState[]>>={
        queued:['dispatching','uncertain'],dispatching:['delivered','uncertain']};
      if(!transitions[from]?.includes(to))throw Error('OUTBOX_TRANSITION_INVALID');
      if(to==='delivered'&&(!proof||proof.length>200))throw Error('OUTBOX_PROOF_REQUIRED');
      row.state=to;row.updatedAt=Date.now();row.proof=proof;
      await this.persist(rows);return row;
    });
  }
  /** Atomically bind a just-created webpage conversation to its first durable
   * browser send receipt. The pre-send placeholder is NEVER treated as a chat.
   */
  async bindNewChatDelivered(id:string,placeholder:string,actualConversationId:string,proof:string){
    if(!ID.test(placeholder)||!ID.test(actualConversationId)||placeholder===actualConversationId||
      !proof||proof.length>200)throw Error('OUTBOX_NEW_CHAT_BIND_INVALID');
    return this.serialized(async()=>{
      const rows=await this.load(),row=rows.find(x=>x.id===id);
      if(!row||row.state!=='dispatching'||row.conversationId!==placeholder)
        throw Error('OUTBOX_NEW_CHAT_STALE_BIND');
      if(rows.some(x=>x.id!==id&&x.nonce===row.nonce))
        throw Error('OUTBOX_NEW_CHAT_NONCE_CONFLICT');
      row.conversationId=actualConversationId;row.state='delivered';row.proof=proof;
      row.updatedAt=Date.now();await this.persist(rows);return row;
    });
  }
  /** A restart can never replay a message accepted by the browser before fsync. */
  async holdUncertain():Promise<number>{
    return this.serialized(async()=>{
      const rows=await this.load();let n=0;
      for(const row of rows){if(row.state==='queued'||row.state==='dispatching'){
        row.state='uncertain';row.updatedAt=Date.now();n++;
      }}
      if(n)await this.persist(rows);return n;
    });
  }
}
