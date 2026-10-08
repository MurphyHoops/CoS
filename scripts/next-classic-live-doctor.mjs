/** Read-only inspection of the REAL running Next. Never attaches to its private test socket. */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const run=promisify(execFile);
const root=path.join(os.homedir(),'Library/Application Support/chat-on-steroids-next');
const maxLogBytes=512_000;
/** Per-connector authenticated tunnel poll evidence, not a process-start marker. */
const POLL_FRESH_MS=95_000; // src/main/tunnel/health.ts
async function candidateTempRoots(){
  const roots=new Set([os.tmpdir()]);
  if(process.platform==='darwin'){
    for(const a of await fs.readdir('/var/folders').catch(()=>[])){
      if(!/^[a-z0-9]{1,8}$/.test(a))continue;
      for(const b of await fs.readdir(path.join('/var/folders',a)).catch(()=>[])){
        if(!/^[a-z0-9_]{8,80}$/.test(b))continue;
        roots.add(path.join('/var/folders',a,b,'T'));
      }
    }
  }
  return [...roots];
}
export async function tunnelHandshakeHealth(config,livePids,nowMs,roots=null){
  const results={};
  roots??=await candidateTempRoots();
  for(const [label,name] of [['core','tunnelId'],['plugins','pluginsTunnelId'],['desktop','desktopTunnelId']]){
    const id=config.tunnel?.[name];
    if(typeof id!=='string' || !/^tunnel_[0-9a-f]{32}$/.test(id))continue;
    const hashed=createHash('sha256').update(`${label}\0${id}`).digest('hex').slice(0,24);
    let result={running:false,lastPollAgeSeconds:null,pollErrorCount:null,freshHandshake:false};
    for(const temp of roots){
      const dir=path.join(temp,'chat-on-steroids-tunnels',hashed);
      try{
        const owner=Number((await fs.readFile(path.join(dir,'client.pid'),'utf8')).trim());
        if(!livePids.has(owner))continue;
        result.running=true;
        const base=(await fs.readFile(path.join(dir,'health.url'),'utf8')).trim();
        const url=new URL(base);
        if(url.protocol!=='http:' || url.hostname!=='127.0.0.1' || !url.port)continue;
        const response=await fetch(base+'/metrics',{signal:AbortSignal.timeout(2500)});
        if(!response.ok)continue;
        const metric=await response.text();
        const get=(key)=>{
          const m=metric.match(new RegExp('(?:^|\\n)'+key+'(?:\\{[^}]*\\})?\\s+([0-9eE.+-]+)(?:\\n|$)'));
          return m?Number(m[1]):null;
        };
        const seconds=get('commands_poll_last_successful_timestamp_seconds');
        const errors=get('commands_poll_errors_total');
        const age=seconds&&seconds>0?Math.max(0,Math.round((nowMs-seconds*1000)/1000)):null;
        result={running:true,lastPollAgeSeconds:age,pollErrorCount:errors,
          freshHandshake:age!==null && seconds*1000<=nowMs+5000 && age*1000<=POLL_FRESH_MS};
        break;
      }catch{ /* Closed client, stale lease or no current metrics: NOT handshake proof. */ }
    }
    results[label]=result;
  }
  return results;
}
export async function inspectLiveNext(){
  const data={mode:'read-only-live',appRunning:false,appPid:null,
    configuredTunnelCount:0,tunnelProcessCount:0,connectedSinceLatestStart:false,
    handshakeFreshCount:0,handshakeExpectedCount:0,handshakes:{},
    bridgeHttpAuthenticationEnforced:null,bridgeListener:false,
    latestAppStartedAt:null,latestTunnelConnectedAt:null, modelCatalogueCached:false,
    chromeChatGPTTabs:null,readyForLiveModelProbe:false,requiresAction:[]};
  const p=await run('/bin/ps',['-axo','pid=,ppid=,command='],{maxBuffer:4_000_000});
  const lines=p.stdout.split('\n');
  const next=lines.find(s=>s.includes('/Chat On Steroids Next.app/Contents/MacOS/Chat On Steroids Next') && !s.includes('Helper'));
  if(next){data.appRunning=true;data.appPid=Number(next.trim().match(/^\d+/)?.[0])||null;}
  const tunnelLines=lines.filter(s=>s.includes('/tunnel-client') && !s.includes('grep ') && !s.includes('next-classic-live-doctor'));
  data.tunnelProcessCount=tunnelLines.length;
  const ownedPids=new Set(tunnelLines.flatMap(line=>{const m=line.trim().match(/^(\d+)\s+(\d+)\s+/);return m && Number(m[2])===data.appPid?[Number(m[1])]:[];}));
  const config=JSON.parse(await fs.readFile(path.join(root,'config.json'),'utf8'));
  data.configuredTunnelCount=['tunnelId','pluginsTunnelId','desktopTunnelId'].filter(k=>!!config.tunnel?.[k]).length;
  data.handshakes=await tunnelHandshakeHealth(config,ownedPids,Date.now());
  data.handshakeExpectedCount=Object.keys(data.handshakes).length;
  data.handshakeFreshCount=Object.values(data.handshakes).filter(x=>x.freshHandshake).length;
  const modelPath=path.join(root,'state/chat-models.json');
  try{
    const models=JSON.parse(await fs.readFile(modelPath,'utf8'));
    data.modelCatalogueCached=Array.isArray(models.models) && models.models.length>0;
  }catch{}
  try{
    const file=await fs.open(path.join(root,'app.log'),'r');
    try{
      const stat=await file.stat();const size=Math.min(stat.size,maxLogBytes);
      const bytes=Buffer.alloc(size);await file.read(bytes,0,size,stat.size-size);
      const lines=bytes.toString('utf8').split('\n');
      const starts=lines.filter(s=>s.includes('app started'));
      data.latestAppStartedAt=starts.at(-1)?.split(' ')[0]||null;
      const later=lines.filter(s=>data.latestAppStartedAt && s.slice(0,24)>=data.latestAppStartedAt && s.includes('core tunnel connected'));
      data.latestTunnelConnectedAt=later.at(-1)?.split(' ')[0]||null;
      data.connectedSinceLatestStart=!!data.latestTunnelConnectedAt;
    }finally{await file.close();}
  }catch{}
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),2200);
  try{
    const res=await fetch('http://127.0.0.1:8765/health',{signal:controller.signal});
    data.bridgeListener=true;
    data.bridgeHttpAuthenticationEnforced=res.status===401;
  }catch{}finally{clearTimeout(timeout);}
  try{
    const script='tell application "Google Chrome"\nset n to 0\nrepeat with w in windows\nrepeat with t in tabs of w\nif URL of t contains "chatgpt.com" then set n to n + 1\nend repeat\nend repeat\nreturn n\nend tell';
    const tabs=await run('/usr/bin/osascript',['-e',script],{timeout:2500});
    data.chromeChatGPTTabs=Number(tabs.stdout.trim());
  }catch{}
  if(!data.appRunning)data.requiresAction.push('Start the existing Next application');
  if(data.configuredTunnelCount<1)data.requiresAction.push('Configure a Next connector in Setup');
  if(data.tunnelProcessCount===0)data.requiresAction.push('Click Connect once in the existing Next window (macOS Accessibility automation is not authorized)');
  if(data.tunnelProcessCount>0 && data.handshakeFreshCount<data.handshakeExpectedCount)
    data.requiresAction.push('Tunnel process is local but OpenAI handshake is stale: check api.openai.com network/Shadowrocket route');
  if(!data.modelCatalogueCached)data.requiresAction.push('Discover real ChatGPT account model options');
  // A historical connected log and a running tunnel are preliminary evidence only.
  // Final readiness still needs exact authenticated browser/recipient observation.
  data.readyForLiveModelProbe=data.appRunning && data.tunnelProcessCount>0 && data.handshakeExpectedCount>0 && data.handshakeFreshCount===data.handshakeExpectedCount && data.bridgeHttpAuthenticationEnforced===true && data.modelCatalogueCached;
  return data;
}

/** Inspect only an explicitly marked live test; do not expose unrelated session prose. */
export async function inspectLiveFixture(id){
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))
    throw new Error('LIVE_FIXTURE_REQUIRES_UUID');
  let rows=[];
  try{
    const v=JSON.parse(await fs.readFile(path.join(root,'state/session-input.json'),'utf8'));
    if(!Array.isArray(v))throw new Error('LIVE_FIXTURE_INPUT_LEDGER_INVALID');
    rows=v.filter(x=>typeof x.text==='string' && x.text.startsWith('CoS Next live verification: ') && x.text.includes(id));
  }catch(error){
    if(error?.code!=='ENOENT')throw error;
  }
  if(rows.length>1)throw new Error('LIVE_FIXTURE_AMBIGUOUS_ROWS');
  const entry=rows[0];
  if(!entry)return {found:false,inputState:null,browserReceipt:false,assistantResponse:false,ackObserved:false,turnFinished:false};
  const owner=entry.deliveredSessionId??entry.sessionId;
  const allowedOwner=typeof owner==='string' && /^[0-9a-z-]{8,64}$/i.test(owner);
  let events=[];
  if(allowedOwner){
    const file=path.join(root,'sessions',owner,'events.jsonl');
    try{
      const raw=await fs.readFile(file,'utf8');
      // Bound nonessential diagnostic parsing to the last 1 MiB.
      const tail=raw.slice(-1024*1024).split('\n');
      events=tail.flatMap(line=>{try{return line.trim()?[JSON.parse(line)]:[];}catch{return [];}});
    }catch(error){if(error?.code!=='ENOENT')throw error;}
  }
  const subsequent=events.filter(x=>typeof x.time==='number' && x.time>=entry.createdAt);
  const response=subsequent.filter(x=>x.kind==='assistant_message');
  const ack=response.some(x=>typeof x.message?.text==='string' && x.message.text.includes(id));
  return {
    found:true,inputState:entry.state,browserReceipt:entry.state==='sent' && !!entry.messageId && !!entry.deliveredAt,
    userRecorded:subsequent.some(x=>x.kind==='user_message' && x.inputId===entry.id),
    assistantResponse:response.length>0,ackObserved:ack,
    turnFinished:subsequent.some(x=>x.kind==='turn_end' && x.outcome && x.outcome!=='unknown')
  };
}
