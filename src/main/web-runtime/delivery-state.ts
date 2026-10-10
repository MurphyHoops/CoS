/**
 * Strict monotone website delivery state. Reducer is a PURE transport primitive.
 * User-visible completions remain owned by existing Classic Mission Kernel.
 */
export type DeliveryPhase=
  'QUEUED'|'CLAIMED'|'STAGED'|'SEND_ATTEMPTED'|'ACCEPTED'|
  'REPLY_STARTED'|'REPLY_SETTLED'|'TOOL_ACKED'|'TURN_COMPLETED'|
  'AMBIGUOUS'|'FAILED_PRE_SEND'|'STOPPED';
export type DeliveryEvent=
  'CLAIM'|'STAGE'|'ATTEMPT_SEND'|'VERIFY_ECHO'|'REPLY_BEGIN'|'REPLY_SETTLE'|
  'VERIFY_TOOLS'|'COMPLETE'|'MARK_AMBIGUOUS'|'PRE_SEND_FAILURE'|'STOP'|
  'RECONCILE_ECHO';
export interface DeliveryRecord {
  deliveryId:string;actorId:string;actorGeneration:number;turnId:string;
  conversationId:string;phase:DeliveryPhase;revision:number;
  createdAt:number;updatedAt:number;
}
const table:Partial<Record<DeliveryPhase,Partial<Record<DeliveryEvent,DeliveryPhase>>>>={
  QUEUED:{CLAIM:'CLAIMED',STOP:'STOPPED'},
  CLAIMED:{STAGE:'STAGED',PRE_SEND_FAILURE:'FAILED_PRE_SEND',STOP:'STOPPED'},
  STAGED:{ATTEMPT_SEND:'SEND_ATTEMPTED',PRE_SEND_FAILURE:'FAILED_PRE_SEND',STOP:'STOPPED'},
  SEND_ATTEMPTED:{VERIFY_ECHO:'ACCEPTED',MARK_AMBIGUOUS:'AMBIGUOUS'},
  AMBIGUOUS:{RECONCILE_ECHO:'ACCEPTED'},
  ACCEPTED:{REPLY_BEGIN:'REPLY_STARTED'},
  REPLY_STARTED:{REPLY_SETTLE:'REPLY_SETTLED'},
  REPLY_SETTLED:{VERIFY_TOOLS:'TOOL_ACKED',COMPLETE:'TURN_COMPLETED'},
  TOOL_ACKED:{COMPLETE:'TURN_COMPLETED'}
};
export function reduceDelivery(record:DeliveryRecord,event:DeliveryEvent,
  expectedRevision:number,at=Date.now()):DeliveryRecord{
  if(!Number.isSafeInteger(expectedRevision)||record.revision!==expectedRevision)
    throw Error('WEB_DELIVERY_STALE_REVISION');
  const next=table[record.phase]?.[event];
  if(!next)throw Error('WEB_DELIVERY_TRANSITION_FORBIDDEN');
  if(!Number.isSafeInteger(at)||at<record.updatedAt)
    throw Error('WEB_DELIVERY_TIME_INVALID');
  return {...record,phase:next,revision:record.revision+1,updatedAt:at};
}
export function newDelivery(data:Omit<DeliveryRecord,'revision'|'phase'|'createdAt'|'updatedAt'>,
  at=Date.now()):DeliveryRecord{
  if(!data.deliveryId||!data.actorId||!data.turnId||!data.conversationId||
    !Number.isSafeInteger(data.actorGeneration)||data.actorGeneration<1||
    !Number.isSafeInteger(at)||at<1)throw Error('WEB_DELIVERY_INVALID');
  return {...data,phase:'QUEUED',revision:1,createdAt:at,updatedAt:at};
}
export function mayAttemptBrowserSend(record:DeliveryRecord):boolean{
  return record.phase==='STAGED';
}
export function mayAutomaticallyReplay(_record:DeliveryRecord):boolean{
  // Same deliveryId is NEVER replayed. A pre-send failure requires a NEW,
  // explicit attempt with its own durable identifier.
  return false;
}
