/** CoS Web Runtime v1: transport only, never an alternative Mission authority. */
export type TurnId=string;
export type ActorId=string;
export type DeliveryId=string;
export type BrowserTargetId=string;

export interface TurnEnvelope {
  missionId:string; actorId:ActorId; actorGeneration:number; turnId:TurnId;
  deliveryId:DeliveryId; bindingRevision:number; conversationId:string;
  payloadDigest:string; payload:string; deadlineMs:number; capabilityScope:string;
}
export type WebRuntimeHoldReason=
  'STOPPED'|'RATE_LIMITED'|'AUTH_REQUIRED'|'MCP_UNAVAILABLE'|'WEB_CHANGED'|
  'NETWORK_OFFLINE'|'PAGE_BUSY'|'DELIVERY_AMBIGUOUS'|'STALE_ACTOR'|'BINDING_MISMATCH';

export interface ActorBinding {
  actorId:ActorId; actorGeneration:number; bindingRevision:number;
  conversationId:string; pageTargetId:BrowserTargetId;
  connectorIdentityDigest:string; verifiedAt:number;
}
export interface BrowserDeliveryPort {
  deliver(turn:TurnEnvelope, signal:AbortSignal):Promise<{deliveryId:DeliveryId;phase:string}>;
  reconcile(deliveryId:DeliveryId):Promise<{deliveryId:DeliveryId;phase:string}>;
  stop(actorId:ActorId,generation:number):Promise<void>;
}

const ID=/^[A-Za-z0-9][A-Za-z0-9:_-]{5,127}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA=/^[0-9a-f]{64}$/;
export function assertTurnEnvelope(t:TurnEnvelope,now=Date.now()):void{
  if(!t||typeof t!=='object'||!UUID.test(t.missionId)||
    !ID.test(t.actorId)||!UUID.test(t.turnId)||!UUID.test(t.deliveryId)||
    !Number.isSafeInteger(t.actorGeneration)||t.actorGeneration<1||
    !Number.isSafeInteger(t.bindingRevision)||t.bindingRevision<1||
    !UUID.test(t.conversationId)||!SHA.test(t.payloadDigest)||
    typeof t.payload!=='string'||t.payload.length<1||t.payload.length>12_000||
    t.payload.includes('\0')||!Number.isSafeInteger(t.deadlineMs)||
    t.deadlineMs<=now||t.deadlineMs>now+24*60*60_000||
    typeof t.capabilityScope!=='string'||t.capabilityScope.length<1||t.capabilityScope.length>256)
    throw Error('WEB_TURN_CONTRACT_INVALID');
}
export function assertCurrentBinding(turn:TurnEnvelope,binding:ActorBinding):void{
  if(!binding||binding.actorId!==turn.actorId||
    binding.actorGeneration!==turn.actorGeneration||
    binding.bindingRevision!==turn.bindingRevision||
    binding.conversationId!==turn.conversationId||
    !ID.test(binding.pageTargetId)||!SHA.test(binding.connectorIdentityDigest)||
    !Number.isSafeInteger(binding.verifiedAt)||binding.verifiedAt<1)
    throw Error('WEB_ACTOR_BINDING_MISMATCH');
}
