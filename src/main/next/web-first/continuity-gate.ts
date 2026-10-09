/**
 * Independent P3 continuity policy. A stable DOM assistant is NOT a trusted
 * platform completion receipt, and a Core checkpoint is NOT proof of caller
 * identity. This module never types into ChatGPT or grants a permission.
 */
import type {DurableTask} from './task-ledger.js';
import type {NativeWebSend} from './web-outbox.js';
import type {VisibleWebReply} from './web-reply-observer.js';
import {conversationFromUrl} from './web-reply-observer.js';

export interface ContinuityLease {
  taskId:string;conversationId:string;startedAt:number;expiresAt:number;
  maxTurns:number;baselineAssistantMessage:string|null;
}
export type ContinuityHoldReason=
  'NO_NATIVE_LEASE'|'LEASE_EXPIRED'|'CHAT_CHANGED'|'TASK_CHANGED'|
  'TASK_NOT_ACTIVE'|'OUTBOX_AMBIGUOUS'|'TURN_LIMIT'|'REPLY_NOT_SETTLED'|
  'OLD_ASSISTANT_REPLY'|'CHECKPOINT_NOT_NEW'|'NO_PROVIDER_COMPLETION_PROOF';
export type ContinuityAssessment={manualNextTurnReady:boolean;
  autonomousNextTurnAllowed:false;reason:ContinuityHoldReason|null;
  sentTurns:number;maxTurns:number};

export function createContinuityLease(args:{taskId:string;conversationId:string;
  now:number;maxTurns:number;maxMinutes:number;baselineAssistantMessage:string|null}):ContinuityLease{
  if(!/^[0-9a-f-]{36}$/i.test(args.taskId)||
    !/^[0-9a-f-]{36}$/i.test(args.conversationId)||
    !Number.isSafeInteger(args.now)||args.now<=0||
    !Number.isInteger(args.maxTurns)||args.maxTurns<1||args.maxTurns>5||
    !Number.isInteger(args.maxMinutes)||args.maxMinutes<1||args.maxMinutes>60)
    throw Error('CONTINUITY_LEASE_INVALID');
  return {taskId:args.taskId,conversationId:args.conversationId,
    startedAt:args.now,expiresAt:args.now+args.maxMinutes*60_000,
    maxTurns:args.maxTurns,baselineAssistantMessage:args.baselineAssistantMessage};
}

/**
 * Readiness for a new, separately authorized website turn.
 * Never reports autonomously allowed while conversation principal and provider
 * completion are unverified (the current Web-First deployment).
 */
export function assessContinuity(input:{lease:ContinuityLease|null;now:number;
  currentUrl:string;task:DurableTask|null;outbox:ReadonlyArray<NativeWebSend>;
  latestReply:VisibleWebReply|null;replySettled:boolean;replyObservedAt:number|null}):ContinuityAssessment{
  const {lease}=input;
  const scoped=lease?input.outbox.filter(row=>row.taskId===lease.taskId&&
    row.conversationId===lease.conversationId):[];
  const sentTurns=scoped.length,maxTurns=lease?.maxTurns??0;
  const denied=(reason:ContinuityHoldReason):ContinuityAssessment=>({
    manualNextTurnReady:false,autonomousNextTurnAllowed:false,reason,sentTurns,maxTurns});
  if(!lease)return denied('NO_NATIVE_LEASE');
  if(input.now>lease.expiresAt)return denied('LEASE_EXPIRED');
  if(conversationFromUrl(input.currentUrl)!==lease.conversationId)return denied('CHAT_CHANGED');
  if(!input.task||input.task.id!==lease.taskId)return denied('TASK_CHANGED');
  if(input.task.phase!=='active')return denied('TASK_NOT_ACTIVE');
  if(scoped.some(r=>r.state!=='delivered'))return denied('OUTBOX_AMBIGUOUS');
  if(sentTurns>=maxTurns)return denied('TURN_LIMIT');
  if(!input.replySettled||!input.latestReply||input.latestReply.generating||
    !input.latestReply.editorReady||
    input.latestReply.conversationId!==lease.conversationId)return denied('REPLY_NOT_SETTLED');
  if(sentTurns===0){
    // Initial sending is ALWAYS operator-driven (no completed previous turn).
    return {manualNextTurnReady:true,autonomousNextTurnAllowed:false,
      reason:'NO_PROVIDER_COMPLETION_PROOF',sentTurns,maxTurns};
  }
  const mostRecent=scoped.reduce((latest,row)=>
    !latest||row.updatedAt>latest.updatedAt?row:latest,undefined as NativeWebSend|undefined);
  if(!mostRecent||input.latestReply.messageId===lease.baselineAssistantMessage||
    input.replyObservedAt===null||input.replyObservedAt<=mostRecent.updatedAt)
    return denied('OLD_ASSISTANT_REPLY');
  const evidence=input.task.events.some(ev=>ev.kind==='checkpoint'&&
    ev.at>mostRecent.updatedAt);
  if(!evidence)return denied('CHECKPOINT_NOT_NEW');
  return {manualNextTurnReady:true,autonomousNextTurnAllowed:false,
    reason:'NO_PROVIDER_COMPLETION_PROOF',sentTurns,maxTurns};
}
