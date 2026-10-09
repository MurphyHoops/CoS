/** P3 append-only native action receipt; never includes requested paths, chat or file text. */
import {promises as fs,constants} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
export type ProjectOperation='project_list'|'project_ls'|'project_read'|'project_find'|'project_replace';
export type OperationStage='STARTED'|'SUCCEEDED'|'REJECTED';
export interface OperationReceipt {id:string;at:number;action:ProjectOperation;projectId:string|null;stage:OperationStage;}
const LOG='web-first-operations.jsonl';
const MAX=2*1024*1024;
export class WebFirstOperationJournal {
  private queue:Promise<unknown>=Promise.resolve();
  constructor(private readonly profile:string){if(!path.isAbsolute(profile))throw Error('JOURNAL_PROFILE_INVALID');}
  private file(){return path.join(this.profile,LOG);}
  private async append(entry:OperationReceipt):Promise<void>{
    await fs.mkdir(this.profile,{recursive:true,mode:0o700});
    const file=this.file();
    const fd=await fs.open(file,constants.O_CREAT|constants.O_WRONLY|constants.O_APPEND|constants.O_NOFOLLOW,0o600);
    try{
      const stat=await fd.stat();
      if(!stat.isFile()||(stat.mode&0o077)!==0||
        (process.getuid&&stat.uid!==process.getuid())||stat.size>MAX)
        throw Error('JOURNAL_FILE_UNSAFE_OR_FULL');
      const data=Buffer.from(JSON.stringify(entry)+'\n');
      if(stat.size+data.length>MAX)throw Error('JOURNAL_FULL');
      await fd.writeFile(data);await fd.sync();
    }finally{await fd.close();}
  }
  async record(entry:OperationReceipt){
    const write=this.queue.then(()=>this.append(entry));
    this.queue=write.catch(()=>undefined);await write;
  }
  async start(action:ProjectOperation,projectId?:string){
    const id=randomUUID();
    await this.record({id,at:Date.now(),action,projectId:projectId??null,stage:'STARTED'});
    return id;
  }
  async finish(id:string,action:ProjectOperation,projectId:string|undefined,ok:boolean){
    await this.record({id,at:Date.now(),action,projectId:projectId??null,
      stage:ok?'SUCCEEDED':'REJECTED'});
  }
  async last(count=20):Promise<ReadonlyArray<OperationReceipt>>{
    const name=this.file();let info;
    try{info=await fs.lstat(name);}catch(e){
      if((e as NodeJS.ErrnoException).code==='ENOENT')return [];throw e;
    }
    if(!info.isFile()||info.isSymbolicLink()||(info.mode&0o077)!==0||info.size>MAX||
      (process.getuid&&info.uid!==process.getuid()))throw Error('JOURNAL_FILE_UNSAFE_OR_FULL');
    const fd=await fs.open(name,constants.O_RDONLY|constants.O_NOFOLLOW);
    let content:string;
    try{content=await fd.readFile({encoding:'utf8'});}finally{await fd.close();}
    const lines=content.trim().split('\n').filter(Boolean);
    const read=Math.max(1,Math.min(100,Math.trunc(count)));
    return lines.slice(-read).map(raw=>{
      const data:unknown=JSON.parse(raw);
      if(!data||typeof data!=='object'||Array.isArray(data))throw Error('JOURNAL_RECORD_INVALID');
      const row=data as Partial<OperationReceipt>;
      if(typeof row.id!=='string'||!/^[-a-f0-9]{36}$/i.test(row.id)||
        !Number.isSafeInteger(row.at)||!['project_list','project_ls','project_read','project_find','project_replace'].includes(String(row.action))||
        !['STARTED','SUCCEEDED','REJECTED'].includes(String(row.stage))||
        (row.projectId!==null&&typeof row.projectId!=='string'))throw Error('JOURNAL_RECORD_INVALID');
      return row as OperationReceipt;
    });
  }
}
