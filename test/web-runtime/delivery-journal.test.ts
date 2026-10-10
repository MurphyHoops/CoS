import {describe,it,expect} from 'vitest';
import {mkdtemp,readFile,rm,appendFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DeliveryJournal} from '../../src/main/web-runtime/delivery-journal.js';
const id=()=>randomUUID();
describe('Web Runtime write-ahead journal durability',()=>{
  it('fsyncs before possible send, survives restart and rejects stale revisions',async()=>{
    const root=await mkdtemp(path.join(tmpdir(),'cos-web-journal-'));
    try{
      const journal=new DeliveryJournal(root),deliveryId=id();
      let row=await journal.create({deliveryId,actorId:'builder-worker',
        actorGeneration:1,turnId:id(),conversationId:id()});
      expect(row.phase).toBe('QUEUED');
      for(const e of ['CLAIM','STAGE','ATTEMPT_SEND'] as const)
        row=await journal.transition(deliveryId,e,row.revision);
      expect((await new DeliveryJournal(root).list())[0]).toMatchObject({
        phase:'SEND_ATTEMPTED',revision:4});
      await expect(journal.transition(deliveryId,'STAGE',3)).rejects.toThrow('STALE_REVISION');
      await expect(journal.create({deliveryId:id(),actorId:'builder-worker',
        actorGeneration:1,turnId:id(),conversationId:id()}))
        .rejects.toThrow('WEB_JOURNAL_ACTOR_IN_FLIGHT');
      row=await journal.transition(deliveryId,'MARK_AMBIGUOUS',row.revision);
      expect(row.phase).toBe('AMBIGUOUS');
      expect((await readFile(path.join(root,'delivery-events.jsonl'),'utf8'))
        .trim().split('\n')).toHaveLength(5);
      await expect(journal.transition(deliveryId,'ATTEMPT_SEND',row.revision))
        .rejects.toThrow('TRANSITION_FORBIDDEN');
    }finally{await rm(root,{recursive:true,force:true});}
  });
  it('fails closed on a torn final event, does not assume no browser side effect',async()=>{
    const root=await mkdtemp(path.join(tmpdir(),'cos-web-journal-'));
    try{
      const journal=new DeliveryJournal(root);
      await journal.create({deliveryId:id(),actorId:'builder-worker',
        actorGeneration:1,turnId:id(),conversationId:id()});
      await appendFile(path.join(root,'delivery-events.jsonl'),'{"bad":');
      await expect(new DeliveryJournal(root).list()).rejects.toThrow('TORN_TAIL');
    }finally{await rm(root,{recursive:true,force:true});}
  });
  it('serialized concurrent claim cannot create two in-flight operations',async()=>{
    const root=await mkdtemp(path.join(tmpdir(),'cos-web-journal-'));
    try{
      const journal=new DeliveryJournal(root);
      const one=()=>journal.create({deliveryId:id(),actorId:'builder-worker',
        actorGeneration:1,turnId:id(),conversationId:id()});
      const result=await Promise.allSettled([one(),one()]);
      expect(result.map(x=>x.status).sort()).toEqual(['fulfilled','rejected']);
    }finally{await rm(root,{recursive:true,force:true});}
  });
});
