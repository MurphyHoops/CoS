/**
 * Operator-launched, one-session real Next Classic QA. Unlike the synthetic QA
 * socket, this runs against the normal userData and may send ONE marked new-chat
 * request. No generic IPC/JavaScript, credentials, mutations or public listener.
 */
import { createServer, type Server } from 'node:net';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { App } from 'electron';

export interface LiveControlGate {
  isNext: boolean; packaged: boolean; home: string; userData: string;
  dir: string; socket: string; token: string; tempRoot?: string;
}
export function liveControlPermitted(v: LiveControlGate): boolean {
  if (!v.isNext || !v.packaged || !path.isAbsolute(v.home) || !path.isAbsolute(v.dir) ||
      !path.isAbsolute(v.socket) || !/^[a-f0-9]{64}$/.test(v.token)) return false;
  const home=path.resolve(v.home), dir=path.resolve(v.dir), tmp=path.resolve(v.tempRoot??os.tmpdir());
  if (path.dirname(dir)!==tmp || !path.basename(dir).startsWith('cos-next-live-')) return false;
  if (path.resolve(v.socket)!==path.join(dir,'control.sock')) return false;
  if (path.resolve(v.userData)!==path.join(home,'Library','Application Support','chat-on-steroids-next')) return false;
  return !home.startsWith(tmp+path.sep) && !dir.startsWith(home+path.sep);
}

export async function startClassicLiveControl(v: LiveControlGate & {app:App}): Promise<void> {
  if (!liveControlPermitted(v) || process.env.COS_NEXT_LIVE_QA!=='1')
    throw new Error('LIVE_QA_REQUIRES_EXPLICIT_OPERATOR_LAUNCH');
  const root=await fs.lstat(v.dir);
  if (!root.isDirectory() || root.isSymbolicLink() || (root.mode & 0o077)!==0 ||
    (process.getuid && root.uid!==process.getuid())) throw new Error('LIVE_QA_PRIVATE_ROOT_REQUIRED');
  try { await fs.lstat(v.socket); throw new Error('LIVE_QA_SOCKET_ALREADY_EXISTS'); }
  catch(error) { if ((error as NodeJS.ErrnoException).code!=='ENOENT') throw error; }

  let attempted=false;
  let fixtureId:string|null=null;
  let serial:Promise<unknown>=Promise.resolve();
  async function health(){
    const [{getStatus},{bridgeStatus},{getChatModels}]=await Promise.all([
      import('../../connection.js'),import('../../bridge.js'),import('../../chat-models.js')]);
    const s=getStatus(), b=await bridgeStatus(), models=getChatModels();
    const handshakeFresh= s.state==='connected' && typeof s.handshakeAt==='number' &&
      s.handshakeAt<=Date.now() && Date.now()-s.handshakeAt<95_000;
    return { connection:s.state,handshakeFresh,coreRequestSeen:s.lastRequestAt!==null,
      coreToolSeen:s.lastToolCallAt!==null,bridgeRunning:b.running,bridgePaired:b.paired,
      bridgePresent:b.present,bridgeWake:b.wakeConnected===true,
      companionCurrent:b.extensionSourceCurrent===true,
      modelsReady:models.state==='ready',modelCount:models.models.length,
      fixtureId,attempted };
  }
  async function receipt(id:string){
    const {listInputs}=await import('../../session/input.js');
    const {readRecentEvents}=await import('../../session/store.js');
    const row=(await listInputs()).find(x=>x.id===id &&
      x.text.startsWith('CoS Next live verification: '));
    if (!row) return {found:false};
    const owner=row.deliveredSessionId??row.sessionId;
    let events:Awaited<ReturnType<typeof readRecentEvents>>=[];
    if(owner && /^[a-z0-9-]{8,64}$/i.test(owner))events=await readRecentEvents(owner,80);
    const later=events.filter(x=>x.time>=row.createdAt);
    const responses=later.filter(x=>x.kind==='assistant_message');
    const acknowledgment=responses.some(x=>x.kind==='assistant_message' &&
      JSON.stringify(x.message).includes(id));
    const effectUncertain=row.state==='browser' && row.sendAuthorizedAt!==undefined && row.deliveredAt===undefined;
    return {found:true,id:row.id,state:row.state,opening:row.opening===true,
      providerConversationBound:!!row.conversationId,
      nativeSendAuthorized:row.sendAuthorizedAt!==undefined,
      sendEffectUncertain:effectUncertain,
      safeToRetry:!effectUncertain && row.state==='failed' && row.sendAuthorizedAt===undefined,
      browserReceipt:row.state==='sent' && !!row.deliveredAt && !!row.messageId,
      sessionBound:!!owner,recordedUser:later.some(x=>x.kind==='user_message' && x.inputId===id),
      assistantObserved:responses.length>0,exactAcknowledgment:acknowledgment,
      completed:later.some(x=>x.kind==='turn_end' && x.outcome==='completed'),
      transportError:row.error?.slice(0,160)??null};
  }
  async function dispatch(req:Record<string,unknown>){
    if(req.token!==v.token)throw new Error('LIVE_QA_UNAUTHORIZED');
    if(req.op==='status')return health();
    if(req.op==='connect'){
      const {connect}=await import('../../connection.js');
      await connect();
      return health();
    }
    if(req.op==='receipt'){
      if(typeof req.id!=='string' || !/^[0-9a-f-]{36}$/i.test(req.id)) throw new Error('LIVE_QA_RECEIPT_ID_INVALID');
      return receipt(req.id);
    }
    if(req.op==='send-fixture'){
      if(attempted)throw new Error('LIVE_QA_ONE_SHOT_SEND_ONLY');
      if(typeof req.id!=='string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(req.id))
        throw new Error('LIVE_QA_FIXTURE_UUID_INVALID');
      const current=await health();
      if(!current.handshakeFresh || !current.bridgePaired || !current.bridgePresent ||
          !current.bridgeWake || !current.modelsReady)
        throw new Error('LIVE_QA_PROVIDER_OR_COMPANION_NOT_READY');
      const {getChatModels}=await import('../../chat-models.js');
      const models=getChatModels().models;
      const model=models.find(m=>/^gpt[ -]?6$/i.test(m.label) && m.efforts.includes('high'));
      if(!model)throw new Error('LIVE_QA_REAL_GPT6_HIGH_MODEL_NOT_CONFIRMED');
      const {sendDesktopInput}=await import('../../session/start-input.js');
      const text=`CoS Next live verification: ${req.id}\nPlease reply exactly: ACK ${req.id}`;
      // Mark consumed BEFORE asynchronous side effects. Never auto-retry ambiguous delivery.
      attempted=true;fixtureId=req.id;
      await sendDesktopInput({id:req.id,sessionId:null,text,mode:'auto',dueAt:Date.now(),
        model:model.id,reasoningEffort:'high',automation:'off'});
      return receipt(req.id);
    }
    if(req.op==='quit'){
      if(attempted && fixtureId){
        const checked=await receipt(fixtureId);
        if(checked.found && checked.sendEffectUncertain)throw new Error('LIVE_QA_AMBIGUOUS_SEND_SHUTDOWN_REFUSED');
      }
      setImmediate(()=>v.app.quit());return {quitting:true};
    }
    throw new Error('LIVE_QA_OPERATION_NOT_ALLOWLISTED');
  }
  const server:Server=createServer(client=>{
    client.setTimeout(12000,()=>client.destroy());
    let buf='';
    client.on('data',piece=>{
      buf+=piece.toString('utf8');
      if(buf.length>2048){client.destroy();return;}
      const pos=buf.indexOf('\n');if(pos<0)return;
      client.pause();
      const raw=buf.slice(0,pos);
      serial=serial.catch(()=>undefined).then(async()=>{
        let answer:unknown;
        try { const p:unknown=JSON.parse(raw);
          if(!p || typeof p!=='object' || Array.isArray(p))throw new Error('LIVE_QA_INVALID_JSON');
          answer={ok:true,data:await dispatch(p as Record<string,unknown>)};
        }catch(e){answer={ok:false,error:e instanceof Error?e.message.slice(0,170):'LIVE_QA_REQUEST_FAILED'};}
        if(!client.destroyed)client.end(JSON.stringify(answer)+'\n');
      });
    });
    client.on('error',()=>undefined);
  });
  await new Promise<void>((resolve,reject)=>{
    server.once('error',reject);
    server.listen(v.socket,()=>{server.off('error',reject);resolve();});
  });
  await fs.chmod(v.socket,0o600);
  v.app.on('before-quit',()=>{
    server.close();void fs.rm(v.socket,{force:true});
  });
}
