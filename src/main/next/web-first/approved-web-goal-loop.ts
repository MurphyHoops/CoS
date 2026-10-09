/**
 * One natively approved, bounded ChatGPT WEBSITE Goal/Loop. No Codex, model
 * API, private ChatGPT endpoint, hidden webpage state or silent retry.
 *
 * A stable rendered answer is a UI receipt, not provider-completed proof.
 * Progression requires a later durable MCP task checkpoint after the send.
 * Every outbound turn is journaled BEFORE input. Ambiguity => HOLD.
 */
import {randomUUID} from 'node:crypto';
import type {DurableTask} from './task-ledger.js';
import type {NativeWebSend} from './web-outbox.js';
import type {VisibleWebReply} from './web-reply-observer.js';
import {WebReplySettleTracker,conversationFromUrl} from './web-reply-observer.js';
export type WebLoopReason=
  'TURN_BUDGET'|'TIME_BUDGET'|'STOP_REQUESTED'|'CHAT_CHANGED'|'TASK_NOT_ACTIVE'|
  'RATE_LIMIT_HOLD'|'AMBIGUOUS_DELIVERY'|'OUTBOX_LIMIT'|'PAGE_BUSY'|
  'SEND_UNPROVED'|'REPLY_TIMEOUT'|'TASK_REVIEW'|'TASK_WAIT'|'NO_NEW_CHECKPOINT'|'WEB_ERROR';
export interface WebLoopOutcome {reason:WebLoopReason;sent:number;replies:number;
  taskId:string;conversationId:string;}
export interface WebLoopServices {
  getUrl:()=>string;getTask:()=>Promise<DurableTask>;
  getOutbox:()=>Promise<readonly NativeWebSend[]>;
  enqueue:(message:{taskId:string;conversationId:string;text:string;nonce:string})=>Promise<{id:string}>;
  transition:(id:string,from:'queued'|'dispatching',to:'dispatching'|'uncertain'|'delivered',proof?:string|null)=>Promise<unknown>;
  modelAllowed:()=>Promise<boolean>;
  snapshot:()=>Promise<VisibleWebReply|null>;
  pageReady:()=>Promise<boolean>;
  send:(conversationId:string,prompt:string)=>Promise<{proved:boolean;proof:string|null}>;
  sleep:(ms:number)=>Promise<void>;
  onUpdate?:(status:string)=>void;
}
export const WEB_LOOP_MAX_TURNS=3;
export function webLoopPrompt(task:DurableTask,turn:number):string{
  if(turn===0)return ('请继续以下已授权的 CoS 项目目标。先核对项目现状与已有操作收据，避免重复执行。'+
    '在权限允许时调用 Core 工具保存 task_checkpoint；需要等待用 task_wait，'+
    '真正完成时调用 task_finish_request 请求本机验收。不要猜测完成、不要未经授权重复副作用。'+
    '本轮完成后如仍需推进，请明确说明下一步。目标：'+task.goal).slice(0,1900);
  return '继续刚才已授权的 CoS 项目目标。先核对当前任务与工具回执，推进尚未完成的一步，'+
    '仅在实际有新进展时调用 task_checkpoint；等待用 task_wait，完成用 task_finish_request。'+
    '不得重复执行不确定的写操作，也不得绕过模型限流。';
}
export async function runApprovedWebGoalLoop(args:{
  taskId:string;conversationId:string;maxTurns:number;deadline:number;signal:AbortSignal;
  services:WebLoopServices;now?:()=>number;waitForReplyMs?:number;
}):Promise<WebLoopOutcome>{
  const {taskId,conversationId,services:s}=args;
  const now=args.now??Date.now;
  if(!/^[a-f0-9-]{36}$/i.test(taskId)||!/^[a-f0-9-]{36}$/i.test(conversationId)||
    !Number.isInteger(args.maxTurns)||args.maxTurns<1||args.maxTurns>WEB_LOOP_MAX_TURNS||
    !Number.isFinite(args.deadline)||args.deadline<=now()||args.deadline>now()+20*60_000)
    throw Error('WEB_LOOP_CONTRACT_INVALID');
  let sent=0,replies=0;
  const stop=(reason:WebLoopReason):WebLoopOutcome=>({reason,sent,replies,taskId,conversationId});
  const check=async():Promise<WebLoopReason|null>=>{
    if(args.signal.aborted)return 'STOP_REQUESTED';
    if(now()>args.deadline)return 'TIME_BUDGET';
    if(conversationFromUrl(s.getUrl())!==conversationId)return 'CHAT_CHANGED';
    const task=await s.getTask();
    if(task.id!==taskId||task.phase!=='active')
      return task.phase==='review'?'TASK_REVIEW':
        task.phase==='waiting'?'TASK_WAIT':'TASK_NOT_ACTIVE';
    if(!await s.modelAllowed())return 'RATE_LIMIT_HOLD';
    const rows=(await s.getOutbox()).filter(x=>x.taskId===taskId&&x.conversationId===conversationId);
    if(rows.some(x=>x.state!=='delivered'))return 'AMBIGUOUS_DELIVERY';
    if(rows.length>=5)return 'OUTBOX_LIMIT';
    return null;
  };
  try{
    for(let turn=0;turn<args.maxTurns;turn++){
      const denied=await check();
      if(denied)return stop(denied);
      const before=await s.snapshot();
      if((before&& (before.conversationId!==conversationId||
        !before.editorReady||before.generating))||!await s.pageReady())
        return stop('PAGE_BUSY');
      const task=await s.getTask();
      const prior=(await s.getOutbox()).filter(x=>x.taskId===taskId&&
        x.conversationId===conversationId&&x.state==='delivered');
      if(turn===0&&prior.length){
        const last=prior.reduce((a,b)=>a.updatedAt>=b.updatedAt?a:b);
        if(!before||!task.events.some(e=>e.kind==='checkpoint'&&e.at>=last.createdAt))
          return stop('NO_NEW_CHECKPOINT');
      }
      const prompt=webLoopPrompt(task,turn===0&&prior.length>0?1:turn);
      // Recheck immediately before durable claim (not after pressing Enter).
      const fenced=await check();
      if(fenced)return stop(fenced);
      const row=await s.enqueue({taskId,conversationId,text:prompt,nonce:randomUUID()});
      await s.transition(row.id,'queued','dispatching');
      let receipt:string|null=null;
      try{
        const result=await s.send(conversationId,prompt);
        if(result.proved)receipt=result.proof;
      }finally{
        await s.transition(row.id,'dispatching',receipt?'delivered':'uncertain',receipt);
      }
      sent++;
      if(!receipt)return stop('SEND_UNPROVED');
      s.onUpdate?.('sent:'+sent);
      const timeout=Math.min(args.deadline,now()+(args.waitForReplyMs??180_000));
      const tracker=new WebReplySettleTracker();
      let settled:VisibleWebReply|null=null;
      while(now()<timeout){
        if(args.signal.aborted)return stop('STOP_REQUESTED');
        if(conversationFromUrl(s.getUrl())!==conversationId)return stop('CHAT_CHANGED');
        if(!await s.modelAllowed())return stop('RATE_LIMIT_HOLD');
        const taskNow=await s.getTask();
        if(taskNow.phase==='waiting')return stop('TASK_WAIT');
        if(taskNow.phase==='review')return stop('TASK_REVIEW');
        if(taskNow.phase!=='active')return stop('TASK_NOT_ACTIVE');
        await s.sleep(2400);
        const reply=await s.snapshot();
        if(reply?.conversationId!==conversationId||reply.messageId===before?.messageId)continue;
        settled=tracker.observe(reply,now());
        if(settled)break;
      }
      if(!settled)return stop('REPLY_TIMEOUT');
      replies++;
      s.onUpdate?.('reply:'+replies);
      const updated=await s.getTask();
      if(updated.phase==='review')return stop('TASK_REVIEW');
      if(updated.phase==='waiting')return stop('TASK_WAIT');
      if(updated.phase!=='active')return stop('TASK_NOT_ACTIVE');
      // Unlike a raw page DOM completion, a fresh checkpoint proves the model
      // actually made a durable Core progress report after this send.
      const lastDelivery=(await s.getOutbox()).find(x=>x.id===row.id);
      if(!lastDelivery||!updated.events.some(e=>e.kind==='checkpoint'&&
        e.at>=lastDelivery.createdAt))return stop('NO_NEW_CHECKPOINT');
    }
    return stop('TURN_BUDGET');
  }catch{return stop('WEB_ERROR');}
}
