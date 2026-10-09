import {describe,expect,it} from 'vitest';
import {runApprovedWebGoalLoop,webLoopPrompt,type WebLoopServices} from '../../src/main/next/web-first/approved-web-goal-loop.js';
import type {DurableTask} from '../../src/main/next/web-first/task-ledger.js';
import type {NativeWebSend} from '../../src/main/next/web-first/web-outbox.js';
const id='11111111-1111-4111-8111-111111111111',chat='22222222-2222-4222-8222-222222222222';
function fixture(){
  let time=1000;let mid=0;let approved=true;let changed=false;
  let phase:DurableTask['phase']='active';let mode='checkpoint';const rows:NativeWebSend[]=[];
  const task={id,goal:'Inspect the project and report',phase,revision:1,
    events:[] as DurableTask['events']} as DurableTask;
  const signal=new AbortController();
  const services:WebLoopServices={
    getUrl:()=>changed?'https://chatgpt.com/':'https://chatgpt.com/c/'+chat,
    getTask:async()=>({...task,phase}),
    getOutbox:async()=>rows,
    enqueue:async data=>{const row={...data,id:String(rows.length+1),state:'queued',createdAt:time,
      updatedAt:time,proof:null} as NativeWebSend;rows.push(row);return row;},
    transition:async(rowId,from,to,proof)=>{const row=rows.find(r=>r.id===rowId)!;
      expect(row.state).toBe(from);row.state=to;row.proof=proof??null;row.updatedAt=time;},
    modelAllowed:async()=>approved,
    pageReady:async()=>!changed,
    snapshot:async()=>({conversationId:chat,messageId:'msg-'+mid,
      text:'Completed step '+mid,editorReady:true,generating:false}),
    send:async()=>{mid++;if(mode==='checkpoint'){task.events.push({
      kind:'checkpoint',at:time+1,nonce:'nonce-00000001',revision:2,note:'done'});}
      if(mode==='waiting')phase='waiting';
      return {proved:mode!=='unproved',proof:mode==='unproved'?null:'dom:test'};},
    sleep:async ms=>{time+=ms}
  };
  return {services,signal,getTime:()=>time,setMode:(x:string)=>mode=x,setApproved:(v:boolean)=>approved=v,
    change:()=>{changed=true;},rows};
}
const run=(f:ReturnType<typeof fixture>,n=2)=>runApprovedWebGoalLoop({
  taskId:id,conversationId:chat,maxTurns:n,deadline:200_000,signal:f.signal.signal,
  services:f.services,now:f.getTime,waitForReplyMs:90_000});
describe('website-only durable Goal/Loop',()=>{
  it('dispatches a bounded number of proved, checkpointed website turns',async()=>{
    const f=fixture(),result=await run(f);
    expect(result).toMatchObject({reason:'TURN_BUDGET',sent:2,replies:2});
    expect(f.rows).toHaveLength(2);
    expect(f.rows.every(x=>x.state==='delivered')).toBe(true);
    expect(webLoopPrompt({goal:'test'} as DurableTask,0)).toContain('test');
  });
  it('does not send another turn without real post-send checkpoint',async()=>{
    const f=fixture();f.setMode('no-checkpoint');
    expect(await run(f)).toMatchObject({reason:'NO_NEW_CHECKPOINT',sent:1,replies:1});
  });
  it('treats ambiguous input receipt as hold, never retry',async()=>{
    const f=fixture();f.setMode('unproved');
    expect(await run(f)).toMatchObject({reason:'SEND_UNPROVED',sent:1,replies:0});
    expect(f.rows[0]?.state).toBe('uncertain');
    expect(await run(f)).toMatchObject({reason:'AMBIGUOUS_DELIVERY',sent:0});
  });
  it('waits when task enters waiting; stops on cooldown and chat switch',async()=>{
    const f=fixture();f.setMode('waiting');
    expect(await run(f)).toMatchObject({reason:'TASK_WAIT',sent:1});
    const limited=fixture();limited.setApproved(false);
    expect(await run(limited)).toMatchObject({reason:'RATE_LIMIT_HOLD',sent:0});
    const moved=fixture();moved.change();
    expect(await run(moved)).toMatchObject({reason:'CHAT_CHANGED',sent:0});
    const stopped=fixture();stopped.signal.abort();
    expect(await run(stopped)).toMatchObject({reason:'STOP_REQUESTED',sent:0});
  });
});
