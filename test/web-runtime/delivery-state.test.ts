import {createHash,randomUUID} from 'node:crypto';
import {describe,it,expect} from 'vitest';
import {newDelivery,reduceDelivery,mayAttemptBrowserSend,mayAutomaticallyReplay}
  from '../../src/main/web-runtime/delivery-state.js';
import {assertTurnEnvelope,assertCurrentBinding,type TurnEnvelope}
  from '../../src/main/web-runtime/contracts.js';
const id=()=>randomUUID();
function turn():TurnEnvelope{
  const payload='hello website';
  return {missionId:id(),actorId:'actor-builder',actorGeneration:1,turnId:id(),
    deliveryId:id(),bindingRevision:1,conversationId:id(),
    payloadDigest:createHash('sha256').update(payload).digest('hex'),
    payload,deadlineMs:Date.now()+120000,capabilityScope:'project-read'};
}
describe('web-runtime v1 typed transport contract',()=>{
  it('rejects invalid messages and forged/stale Actor bindings',()=>{
    const t=turn();expect(()=>assertTurnEnvelope(t)).not.toThrow();
    const binding={actorId:t.actorId,actorGeneration:1,bindingRevision:1,
      conversationId:t.conversationId,pageTargetId:'target-realpage',
      connectorIdentityDigest:'a'.repeat(64),verifiedAt:Date.now()};
    expect(()=>assertCurrentBinding(t,binding)).not.toThrow();
    expect(()=>assertCurrentBinding(t,{...binding,actorGeneration:2}))
      .toThrow('WEB_ACTOR_BINDING_MISMATCH');
    expect(()=>assertTurnEnvelope({...t,payload:'x'.repeat(12001)}))
      .toThrow('WEB_TURN_CONTRACT_INVALID');
    expect(()=>assertTurnEnvelope({...t,deadlineMs:Date.now()-1}))
      .toThrow('WEB_TURN_CONTRACT_INVALID');
  });
  it('has no successful path from a clicked-only message',()=>{
    const t=turn();
    let r=newDelivery({deliveryId:t.deliveryId,actorId:t.actorId,
      actorGeneration:t.actorGeneration,turnId:t.turnId,conversationId:t.conversationId});
    for(const e of ['CLAIM','STAGE','ATTEMPT_SEND'] as const)r=reduceDelivery(r,e,r.revision);
    expect(r.phase).toBe('SEND_ATTEMPTED');
    expect(mayAttemptBrowserSend(r)).toBe(false);
    expect(()=>reduceDelivery(r,'COMPLETE',r.revision)).toThrow();
    expect(()=>reduceDelivery(r,'PRE_SEND_FAILURE',r.revision)).toThrow();
    expect(mayAutomaticallyReplay(r)).toBe(false);
    r=reduceDelivery(r,'MARK_AMBIGUOUS',r.revision);
    expect(()=>reduceDelivery(r,'ATTEMPT_SEND',r.revision)).toThrow();
    expect(()=>reduceDelivery(r,'RECONCILE_ECHO',r.revision)).not.toThrow();
  });
  it('requires new reply and tool-ack states before final completion when required',()=>{
    const t=turn();let r=newDelivery({deliveryId:t.deliveryId,actorId:t.actorId,
      actorGeneration:1,turnId:t.turnId,conversationId:t.conversationId});
    for(const e of ['CLAIM','STAGE','ATTEMPT_SEND','VERIFY_ECHO',
      'REPLY_BEGIN','REPLY_SETTLE','VERIFY_TOOLS','COMPLETE'] as const)
      r=reduceDelivery(r,e,r.revision);
    expect(r.phase).toBe('TURN_COMPLETED');
    expect(()=>reduceDelivery(r,'CLAIM',r.revision)).toThrow();
    expect(()=>reduceDelivery(r,'COMPLETE',r.revision-1)).toThrow('STALE_REVISION');
  });
  it('is stopped before submit but not after ambiguous submit',()=>{
    const t=turn(),r=newDelivery({deliveryId:t.deliveryId,actorId:t.actorId,
      actorGeneration:1,turnId:t.turnId,conversationId:t.conversationId});
    expect(reduceDelivery(r,'STOP',r.revision).phase).toBe('STOPPED');
    const c=reduceDelivery(r,'CLAIM',r.revision);
    const s=reduceDelivery(c,'STAGE',c.revision);
    expect(mayAttemptBrowserSend(s)).toBe(true);
    expect(reduceDelivery(s,'PRE_SEND_FAILURE',s.revision).phase).toBe('FAILED_PRE_SEND');
  });
});
