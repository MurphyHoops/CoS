/** One verified Actor -> one Chromium Page target -> one ChatGPT conversation.
 * No active-tab fallback, no connection credential copied into tool arguments.
 */
import {assertCurrentBinding,type ActorBinding,type TurnEnvelope}
  from './contracts.js';

export class ActorPageRegistry {
  private readonly actors=new Map<string,ActorBinding>();
  private readonly targets=new Map<string,string>();
  private readonly conversations=new Map<string,string>();

  list():ReadonlyArray<ActorBinding>{return [...this.actors.values()].map(x=>({...x}));}
  lookup(actorId:string):ActorBinding|null {
    const value=this.actors.get(actorId);
    return value?{...value}:null;
  }
  /** Only caller's separately VERIFIED binding should be registered here. */
  install(binding:ActorBinding):ActorBinding{
    if(!binding||typeof binding.actorId!=='string'||binding.actorId.length<6||
      typeof binding.pageTargetId!=='string'||binding.pageTargetId.length<6||
      typeof binding.conversationId!=='string'||binding.conversationId.length!==36||
      !Number.isSafeInteger(binding.actorGeneration)||binding.actorGeneration<1||
      !Number.isSafeInteger(binding.bindingRevision)||binding.bindingRevision<1||
      !Number.isSafeInteger(binding.verifiedAt)||binding.verifiedAt<1||
      !/^[0-9a-f]{64}$/.test(binding.connectorIdentityDigest))
      throw Error('WEB_REGISTRY_BINDING_INVALID');
    const occupiedTarget=this.targets.get(binding.pageTargetId);
    const occupiedChat=this.conversations.get(binding.conversationId);
    if(occupiedTarget&&occupiedTarget!==binding.actorId||
      occupiedChat&&occupiedChat!==binding.actorId)
      throw Error('WEB_REGISTRY_TARGET_OR_CHAT_OWNED');
    const previous=this.actors.get(binding.actorId);
    if(previous){
      if(binding.actorGeneration<previous.actorGeneration||
        binding.bindingRevision<=previous.bindingRevision)
        throw Error('WEB_REGISTRY_STALE_REBIND');
      // Remove previous identity only AFTER the replacement has passed all checks.
      this.targets.delete(previous.pageTargetId);
      this.conversations.delete(previous.conversationId);
    }
    const copy={...binding};
    this.actors.set(binding.actorId,copy);
    this.targets.set(binding.pageTargetId,binding.actorId);
    this.conversations.set(binding.conversationId,binding.actorId);
    return {...copy};
  }
  requireForTurn(turn:TurnEnvelope):ActorBinding{
    const binding=this.actors.get(turn.actorId);
    if(!binding)throw Error('WEB_REGISTRY_ACTOR_UNBOUND');
    assertCurrentBinding(turn,binding);
    return {...binding};
  }
  /** An old Worker generation cannot disconnect its successor. */
  disconnect(actorId:string,actorGeneration:number,bindingRevision:number):void{
    const current=this.actors.get(actorId);
    if(!current)return;
    if(current.actorGeneration!==actorGeneration||
      current.bindingRevision!==bindingRevision)
      throw Error('WEB_REGISTRY_STALE_DISCONNECT');
    this.actors.delete(actorId);
    this.targets.delete(current.pageTargetId);
    this.conversations.delete(current.conversationId);
  }
}
