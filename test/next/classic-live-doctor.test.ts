import {describe,it,expect} from 'vitest';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const run=promisify(execFile);
const cli=path.resolve('scripts/next-classic-cli.mjs');
const id='123e4567-e89b-42d3-a456-426614174000';
describe('read-only Next live receipt CLI',()=>{
  it('proves only the exact fixture with its durable browser and assistant evidence', async()=>{
    const home=await mkdtemp(path.join(os.tmpdir(),'cos-next-live-receipt-'));
    try{
      const profile=path.join(home,'Library/Application Support/chat-on-steroids-next');
      const session='123e4567-e89b-42d3-a456-426614174001';
      await mkdir(path.join(profile,'state'),{recursive:true});
      await mkdir(path.join(profile,'sessions',session),{recursive:true});
      const marker='CoS Next live verification: '+id;
      const row={id,sessionId:session,text:marker,createdAt:1000,state:'sent',messageId:'provider-proof',deliveredAt:1100};
      await writeFile(path.join(profile,'state/session-input.json'),JSON.stringify([row]));
      const events=[
        {time:1200,kind:'user_message',inputId:id,message:{text:marker}},
        {time:1300,kind:'assistant_message',message:{text:'ACK '+id}},
        {time:1400,kind:'turn_end',outcome:'completed'}
      ];
      await writeFile(path.join(profile,'sessions',session,'events.jsonl'),events.map(x=>JSON.stringify(x)).join('\n')+'\n');
      const response=await run(process.execPath,[cli,'live-receipt',id],{env:{...process.env,HOME:home}});
      expect(JSON.parse(response.stdout)).toMatchObject({found:true,inputState:'sent',browserReceipt:true,userRecorded:true,assistantResponse:true,ackObserved:true,turnFinished:true});
      const missing=await run(process.execPath,[cli,'live-receipt','223e4567-e89b-42d3-a456-426614174000'],{env:{...process.env,HOME:home}});
      expect(JSON.parse(missing.stdout)).toMatchObject({found:false,browserReceipt:false,assistantResponse:false});
    }finally{await rm(home,{recursive:true,force:true});}
  });
  it('rejects malformed marker UUIDs without scanning arbitrary conversation records',async()=>{
    const runResult=await run(process.execPath,[cli,'live-receipt','not-a-uuid']).then(()=>null,error=>error);
    expect(runResult).not.toBeNull();
    expect(runResult.stderr).toContain('LIVE_FIXTURE_REQUIRES_UUID');
  });
});
