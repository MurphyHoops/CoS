/**
 * Single-process append-only durable website delivery journal.
 * Per-event fd.sync before browser send. Replay rejects sequence gaps and
 * stops at a torn trailing record (never assumes submission did not occur).
 */
import {constants,promises as fs} from 'node:fs';
import path from 'node:path';
import {newDelivery,reduceDelivery,type DeliveryRecord,type DeliveryEvent} from './delivery-state.js';

export interface JournalEvent {
  deliveryId:string;revision:number;event:'CREATE'|DeliveryEvent;
  row:DeliveryRecord;
}
export class DeliveryJournal {
  private tail:Promise<unknown>=Promise.resolve();
  constructor(private readonly directory:string){
    if(!path.isAbsolute(directory))throw Error('WEB_JOURNAL_ROOT_INVALID');
  }
  private serial<T>(action:()=>Promise<T>):Promise<T>{
    const next=this.tail.then(action);this.tail=next.catch(()=>undefined);return next;
  }
  private filename(){return path.join(this.directory,'delivery-events.jsonl');}
  private async prepare():Promise<void>{
    await fs.mkdir(this.directory,{recursive:true,mode:0o700});
    const stat=await fs.lstat(this.directory);
    if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o077)!==0)
      throw Error('WEB_JOURNAL_DIR_UNSAFE');
  }
  private async readRows():Promise<Map<string,DeliveryRecord>>{
    await this.prepare();
    let text='';
    try{
      const stat=await fs.lstat(this.filename());
      if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||
        stat.size>4*1024*1024)throw Error('WEB_JOURNAL_FILE_UNSAFE');
      const handle=await fs.open(this.filename(),constants.O_RDONLY|constants.O_NOFOLLOW);
      try{text=await handle.readFile({encoding:'utf8'});}finally{await handle.close();}
    }catch(error){
      if((error as NodeJS.ErrnoException).code==='ENOENT')return new Map();
      throw error;
    }
    const rows=new Map<string,DeliveryRecord>();
    const lines=text.split('\n');
    if(lines.pop()!=='')throw Error('WEB_JOURNAL_TORN_TAIL_NEEDS_REVIEW');
    for(const line of lines){
      if(line.length>8192)throw Error('WEB_JOURNAL_RECORD_TOO_LARGE');
      const item=JSON.parse(line) as JournalEvent;
      if(!item||!item.deliveryId||!item.row||item.row.deliveryId!==item.deliveryId||
        item.row.revision!==item.revision)throw Error('WEB_JOURNAL_INVALID_RECORD');
      const previous=rows.get(item.deliveryId);
      if(!previous){
        if(item.event!=='CREATE'||item.revision!==1||item.row.phase!=='QUEUED')
          throw Error('WEB_JOURNAL_CREATE_INVALID');
      }else{
        if(item.event==='CREATE')throw Error('WEB_JOURNAL_DUPLICATE_CREATE');
        const calculated=reduceDelivery(previous,item.event,previous.revision,item.row.updatedAt);
        if(JSON.stringify(calculated)!==JSON.stringify(item.row))
          throw Error('WEB_JOURNAL_REPLAY_DIVERGENCE');
      }
      rows.set(item.deliveryId,item.row);
    }
    return rows;
  }
  private async append(item:JournalEvent):Promise<void>{
    const line=JSON.stringify(item)+'\n';
    if(Buffer.byteLength(line)>8192)throw Error('WEB_JOURNAL_RECORD_TOO_LARGE');
    const fd=await fs.open(this.filename(),
      constants.O_WRONLY|constants.O_CREAT|constants.O_APPEND|constants.O_NOFOLLOW,0o600);
    try{await fd.writeFile(line);await fd.sync();}finally{await fd.close();}
    const dir=await fs.open(this.directory,constants.O_RDONLY);
    try{await dir.sync();}finally{await dir.close();}
  }
  list():Promise<readonly DeliveryRecord[]>{
    return this.serial(async()=>[...(await this.readRows()).values()]);
  }
  create(fields:Omit<DeliveryRecord,'revision'|'phase'|'createdAt'|'updatedAt'>):Promise<DeliveryRecord>{
    return this.serial(async()=>{
      const rows=await this.readRows();
      if(rows.has(fields.deliveryId))throw Error('WEB_JOURNAL_DUPLICATE_DELIVERY');
      if([...rows.values()].some(r=>r.actorId===fields.actorId&&
        r.actorGeneration===fields.actorGeneration&&
        !['TURN_COMPLETED','FAILED_PRE_SEND','STOPPED'].includes(r.phase)))
        throw Error('WEB_JOURNAL_ACTOR_IN_FLIGHT');
      const row=newDelivery(fields);await this.append({deliveryId:row.deliveryId,revision:1,
        event:'CREATE',row});return row;
    });
  }
  transition(id:string,event:DeliveryEvent,expectedRevision:number):Promise<DeliveryRecord>{
    return this.serial(async()=>{
      const row=(await this.readRows()).get(id);
      if(!row)throw Error('WEB_JOURNAL_DELIVERY_NOT_FOUND');
      const next=reduceDelivery(row,event,expectedRevision);
      await this.append({deliveryId:id,revision:next.revision,event,row:next});
      return next;
    });
  }
}
