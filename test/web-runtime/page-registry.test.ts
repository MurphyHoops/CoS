import {describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {ActorPageRegistry} from '../../src/main/web-runtime/page-registry.js';
import type {ActorBinding,TurnEnvelope} from '../../src/main/web-runtime/contracts.js';
function binding(actorId:string):ActorBinding{
  return {actorId,actorGeneration:1,bindingRevision:1,
    conversationId:randomUUID(),pageTargetId:'target-'+randomUUID(),
    connectorIdentityDigest:'a'.repeat(64),verifiedAt:Date.now()};
}
function turn(b:ActorBinding):TurnEnvelope{
  return {missionId:randomUUID(),actorId:b.actorId,actorGeneration:b.actorGeneration,
    turnId:randomUUID(),deliveryId:randomUUID(),
    bindingRevision:b.bindingRevision,conversationId:b.conversationId,
    payload:'hello',payloadDigest:'c'.repeat(64),deadlineMs:Date.now()+60000,
    capabilityScope:'project-read'};
}
describe('trusted one-actor-per-Page registry, without activeTab',()=>{
  it('routes two workers only to their own verified target and conversation',()=>{
    const reg=new ActorPageRegistry(),a=reg.install(binding('builder-worker')),
      b=reg.install(binding('auditor-worker'));
    expect(reg.requireForTurn(turn(a)).pageTargetId).toBe(a.pageTargetId);
    expect(reg.requireForTurn(turn(b)).pageTargetId).toBe(b.pageTargetId);
    expect(()=>reg.requireForTurn({...turn(a),conversationId:b.conversationId}))
      .toThrow('WEB_ACTOR_BINDING_MISMATCH');
    expect(()=>reg.requireForTurn({...turn(b),actorId:a.actorId}))
      .toThrow('WEB_ACTOR_BINDING_MISMATCH');
    expect(reg.list()).toHaveLength(2);
  });
  it('refuses stolen Page/Chat and stale generation rebind',()=>{
    const reg=new ActorPageRegistry(),a=reg.install(binding('builder-worker'));
    const b=binding('auditor-worker');
    expect(()=>reg.install({...b,pageTargetId:a.pageTargetId}))
      .toThrow('WEB_REGISTRY_TARGET_OR_CHAT_OWNED');
    expect(()=>reg.install({...b,conversationId:a.conversationId}))
      .toThrow('WEB_REGISTRY_TARGET_OR_CHAT_OWNED');
    expect(()=>reg.install({...a,bindingRevision:a.bindingRevision}))
      .toThrow('WEB_REGISTRY_STALE_REBIND');
    expect(reg.lookup('builder-worker')).toEqual(a);
  });
  it('rotates atomically and fences stale Worker teardown',()=>{
    const reg=new ActorPageRegistry(),first=reg.install(binding('builder-worker'));
    const next=reg.install({...binding('builder-worker'),actorGeneration:2,bindingRevision:2});
    expect(reg.requireForTurn(turn(next)).pageTargetId).toBe(next.pageTargetId);
    expect(()=>reg.requireForTurn(turn(first))).toThrow('WEB_ACTOR_BINDING_MISMATCH');
    expect(()=>reg.disconnect(first.actorId,1,1)).toThrow('WEB_REGISTRY_STALE_DISCONNECT');
    expect(reg.lookup(next.actorId)).toEqual(next);
    reg.disconnect(next.actorId,2,2);
    expect(reg.lookup(next.actorId)).toBeNull();
  });
});
