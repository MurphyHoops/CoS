/** Opt-in visible ChatGPT reply capture, inside Electron's own WebContentsView. */
import {createHash,randomUUID} from 'node:crypto';
import {constants,promises as fs} from 'node:fs';
import path from 'node:path';

export interface VisibleWebReply {
  conversationId:string;
  messageId:string;
  text:string;
  editorReady:boolean;
  generating:boolean;
}
export interface StoredWebReply {
  id:string;conversationId:string;messageId:string;hash:string;
  at:number;text:string;
}
const MAX_REPLY=24*1024;
const FILE='web-first-replies.jsonl';
const MAX_LOG_BYTES=4*1024*1024;
export function conversationFromUrl(raw:string):string|null {
  try{
    const url=new URL(raw);
    if(url.protocol!=='https:'||url.hostname!=='chatgpt.com')return null;
    const match=/^\/c\/([0-9a-f-]{36})(?:\/)?$/i.exec(url.pathname);
    return match?match[1]!:null;
  }catch{return null;}
}
/** No cookies, localStorage, hidden tokens, network interception or DOM mutation. */
export const VISIBLE_REPLY_SCRIPT=`(() => {
  const candidates=[...document.querySelectorAll('[data-message-author-role="assistant"]')];
  const latest=candidates.at(-1);
  if(!latest)return null;
  const text=(latest.innerText||'').slice(0,24576);
  const messageId=latest.getAttribute('data-message-id')||
    latest.querySelector('[data-message-id]')?.getAttribute('data-message-id')||
    'assistant-index-'+candidates.length;
  const stopping=!!document.querySelector('[data-testid="stop-button"],button[aria-label="Stop generating"],button[aria-label="停止生成"]');
  const editor=!!document.querySelector('[contenteditable="true"]:not([aria-disabled="true"]),[role="textbox"]:not([aria-disabled="true"])');
  const busy=!!latest.matches('[aria-busy="true"]')||!!latest.querySelector('[aria-busy="true"]');
  return {messageId,text,editorReady:editor,generating:stopping||busy};
})()`;
export class WebReplySettleTracker {
  private candidate:{key:string;firstSeen:number;count:number}|null=null;
  private emitted=new Set<string>();
  private conversation:string|null=null;
  /** Settled here means stable visible DOM, NOT a provider-verified final turn. */
  observe(value:VisibleWebReply|null,now=Date.now()):VisibleWebReply|null{
    if(!value||!value.text.trim()||value.text.length>MAX_REPLY||
      !value.editorReady||value.generating){this.candidate=null;return null;}
    if(this.conversation!==value.conversationId){
      this.conversation=value.conversationId;this.candidate=null;this.emitted.clear();
    }
    const key=value.conversationId+'|'+value.messageId+'|'+
      createHash('sha256').update(value.text).digest('hex');
    if(this.emitted.has(key))return null;
    if(!this.candidate||this.candidate.key!==key){
      this.candidate={key,firstSeen:now,count:1};return null;
    }
    this.candidate.count++;
    if(this.candidate.count<2||now-this.candidate.firstSeen<4500)return null;
    this.emitted.add(key);
    return {...value};
  }
  reset(){this.candidate=null;this.conversation=null;this.emitted.clear();}
}
export class WebFirstReplyJournal {
  private chain:Promise<unknown>=Promise.resolve();
  constructor(private readonly profile:string){if(!path.isAbsolute(profile))throw Error('REPLY_PROFILE_INVALID');}
  private filename(){return path.join(this.profile,FILE);}
  async last(count=20):Promise<StoredWebReply[]>{
    let stat;
    try{stat=await fs.lstat(this.filename());}
    catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return [];throw e;}
    if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||stat.size>MAX_LOG_BYTES||
      (process.getuid&&stat.uid!==process.getuid()))throw Error('REPLY_JOURNAL_UNSAFE');
    const fd=await fs.open(this.filename(),constants.O_RDONLY|constants.O_NOFOLLOW);
    let data:string;
    try{data=await fd.readFile({encoding:'utf8'});}finally{await fd.close();}
    return data.trim().split('\n').filter(Boolean).slice(-Math.max(1,Math.min(100,count))).map(raw=>{
      const row=JSON.parse(raw) as StoredWebReply;
      if(typeof row.id!=='string'||typeof row.hash!=='string'||typeof row.text!=='string'||
        typeof row.conversationId!=='string'||typeof row.messageId!=='string'||
        !Number.isSafeInteger(row.at)||row.text.length>MAX_REPLY)throw Error('REPLY_JOURNAL_INVALID');
      return row;
    });
  }
  async record(reply:VisibleWebReply):Promise<StoredWebReply|null>{
    if(reply.text.length>MAX_REPLY||!reply.text.trim()||!reply.messageId||!reply.conversationId)
      throw Error('REPLY_PAYLOAD_INVALID');
    const hash=createHash('sha256').update(reply.text).digest('hex');
    const entry:StoredWebReply={id:randomUUID(),conversationId:reply.conversationId,
      messageId:reply.messageId,hash,at:Date.now(),text:reply.text};
    const run=async():Promise<StoredWebReply|null>=>{
      const old=await this.last(100);
      if(old.some(row=>row.conversationId===entry.conversationId&&
        row.messageId===entry.messageId&&row.hash===hash))return null;
      await fs.mkdir(this.profile,{recursive:true,mode:0o700});
      const fd=await fs.open(this.filename(),constants.O_WRONLY|constants.O_CREAT|
        constants.O_APPEND|constants.O_NOFOLLOW,0o600);
      try{
        const stat=await fd.stat();const line=JSON.stringify(entry)+'\n';
        if(!stat.isFile()||(stat.mode&0o077)!==0||stat.size+Buffer.byteLength(line)>MAX_LOG_BYTES)
          throw Error('REPLY_JOURNAL_UNSAFE_OR_FULL');
        await fd.writeFile(line);await fd.sync();return entry;
      }finally{await fd.close();}
    };
    const promise=this.chain.then(run);
    this.chain=promise.catch(()=>undefined);
    return promise;
  }
}
