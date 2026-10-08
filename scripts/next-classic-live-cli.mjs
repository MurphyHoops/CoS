#!/usr/bin/env node
/** The operator's intentional live-QA entry point. Real HOME, private socket, no secrets. */
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createConnection} from 'node:net';
import {mkdtemp,readFile,writeFile,chmod,rm,stat,realpath} from 'node:fs/promises';
import {randomBytes,randomUUID} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
const run=promisify(execFile);
const mark='cos-next-live-';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function rootOnly(dir){
  const r=path.resolve(dir??'');
  if(path.dirname(r)!==path.resolve(os.tmpdir()) || !path.basename(r).startsWith(mark))
    throw new Error('LIVE_QA_PRIVATE_SESSION_PATH_REQUIRED');
  return r;
}
async function load(dir){
  const root=rootOnly(dir), info=JSON.parse(await readFile(path.join(root,'session.json'),'utf8'));
  const st=await stat(root);
  if((st.mode&0o077)!==0 || (process.getuid && st.uid!==process.getuid()) ||
    info.dir!==root || !/^[a-f0-9]{64}$/.test(info.token) ||
    !Number.isInteger(info.pid) || info.pid<=0 || info.version!==1)
    throw new Error('LIVE_QA_SESSION_NOT_PRIVATE');
  return info;
}
async function save(info){
  const target=path.join(info.dir,'session.json');
  await writeFile(target,JSON.stringify(info)+'\n',{mode:0o600});
  await chmod(target,0o600);
}
async function ownedNext(){
  const p=(await run('/bin/ps',['-axo','pid=,command='],{maxBuffer:3_000_000})).stdout;
  return p.split('\n').flatMap(line=>{
    const m=line.trim().match(/^(\d+)\s+(.+)$/);
    return m && /\/Chat On Steroids Next\.app\/Contents\/MacOS\/Chat On Steroids Next(?:\s|$)/.test(m[2])?
      [{pid:Number(m[1]),command:m[2]}]:[];
  });
}
function send(info,op,payload={}){
  return new Promise((resolve,reject)=>{
    const socket=createConnection(path.join(info.dir,'control.sock'));
    let data='',done=false;
    const settle=(error,result)=>{
      if(done)return;done=true;socket.destroy();error?reject(error):resolve(result);
    };
    socket.setTimeout(15000,()=>settle(new Error('LIVE_QA_SOCKET_TIMEOUT')));
    socket.on('error',settle);
    socket.on('connect',()=>socket.write(JSON.stringify({op,token:info.token,...payload})+'\n'));
    socket.on('data',part=>{
      data+=part.toString('utf8');
      if(data.length>10000)return settle(new Error('LIVE_QA_RESPONSE_TOO_LARGE'));
      if(!data.includes('\n'))return;
      try{const result=JSON.parse(data.split('\n')[0]);
        if(!result.ok)throw new Error(result.error??'LIVE_QA_REJECTED');
        settle(null,result.data);
      }catch(error){settle(error);}
    });
  });
}
async function awaitReady(info){
  const deadline=Date.now()+29000;
  while(Date.now()<deadline){
    try {const status=await send(info,'status');if(status.connection)return status;}catch{}
    try{process.kill(info.pid,0);}catch{throw new Error('LIVE_QA_APP_EXITED_BEFORE_READY');}
    await sleep(450);
  }
  throw new Error('LIVE_QA_APP_START_TIMED_OUT');
}
function appEnv(info){
  const env={...process.env};
  for(const key of Object.keys(env))if(/SECRET|PASSWORD|COOKIE|TOKEN|CREDENTIAL|API_KEY|OPENAI_|ANTHROPIC_|CODEX_|^COS_/i.test(key))delete env[key];
  return {...env,HOME:os.homedir(),COS_NEXT_LIVE_QA:'1',
    COS_NEXT_LIVE_QA_DIR:info.dir,COS_NEXT_LIVE_QA_SOCKET:path.join(info.dir,'control.sock'),
    COS_NEXT_LIVE_QA_TOKEN:info.token};
}
async function start(app){
  if(!path.isAbsolute(app??'') || !app.endsWith('/Chat On Steroids Next.app') ||
    path.resolve(app)!==await realpath(app))throw new Error('LIVE_QA_APP_PATH_INVALID');
  await stat(path.join(app,'Contents/MacOS/Chat On Steroids Next'));
  if((await ownedNext()).length)throw new Error('LIVE_QA_ANOTHER_NEXT_ALREADY_RUNNING');
  const dir=await mkdtemp(path.join(os.tmpdir(),mark));
  await chmod(dir,0o700);
  const info={version:1,dir,app,token:randomBytes(32).toString('hex'),pid:0,attemptId:null};
  try{
    const processChild=spawn(path.join(app,'Contents/MacOS/Chat On Steroids Next'),[],{
      env:appEnv(info),detached:true,stdio:'ignore'});
    if(!processChild.pid)throw new Error('LIVE_QA_CANNOT_LAUNCH_APP');
    info.pid=processChild.pid;
    processChild.unref();
    await save(info);
    const status=await awaitReady(info);
    return {session:dir,pid:info.pid,status};
  }catch(error){
    // Never force-kill a possibly owner-acquiring real app. Leave the session
    // and PID for explicit inspection/recovery if start was ambiguous.
    if(!info.pid)await rm(dir,{recursive:true,force:true});
    throw error;
  }
}
async function assertNoAmbiguousDelivery(){
  const ledger=path.join(os.homedir(),'Library/Application Support/chat-on-steroids-next/state/session-input.json');
  let rows;
  try { rows=JSON.parse(await readFile(ledger,'utf8')); }
  catch(error) {
    if(error?.code==='ENOENT')return; // no durable input exists
    throw new Error('LIVE_QA_INPUT_LEDGER_NOT_VERIFIABLE');
  }
  if(!Array.isArray(rows))throw new Error('LIVE_QA_INPUT_LEDGER_NOT_VERIFIABLE');
  const ambiguous=rows.filter(x=>x && (x.state==='browser'||x.state==='tool'));
  if(ambiguous.length)throw new Error('LIVE_QA_AMBIGUOUS_DELIVERY_NO_SHUTDOWN count='+ambiguous.length);
}
async function quitCurrent(){
  const before=await ownedNext();
  if(before.length>1)throw new Error('LIVE_QA_MULTIPLE_NEXT_OWNERS_PREEXIST');
  if(!before.length)return {stopped:true,wasRunning:false};
  await assertNoAmbiguousDelivery();
  // Ordinary macOS Quit sends Electron's bounded will-quit lifecycle; no SIGTERM,
  // no credential intervention and no Delete/Reset user-data operation.
  await run('/usr/bin/osascript',['-e','tell application "Chat On Steroids Next" to quit'],{timeout:8500});
  const deadline=Date.now()+64000;
  while(Date.now()<deadline){
    if((await ownedNext()).length===0)return {stopped:true,wasRunning:true};
    await sleep(750);
  }
  throw new Error('LIVE_QA_QUIT_NOT_COMPLETED_NO_FORCE_USED');
}
async function startAfterUpgrade(app){
  // Durable real account safeguards: no ongoing task/Goal/waiter obligations may be
  // silently interrupted merely to switch versions.
  const root=path.join(os.homedir(),'Library/Application Support/chat-on-steroids-next/state');
  for(const [name,fields] of [['continuations',['entries']],['long-run',['epochs','obligations','waits']],
    ['goal-replies',['replies']],['bridge-commands',['commands','receipts']]]){
    const p=path.join(root,name+'.json');
    try{
      const raw=JSON.parse(await readFile(p,'utf8'));
      if(fields.some(k=>Array.isArray(raw[k])&&raw[k].length>0))throw new Error('LIVE_QA_ACTIVE_DURABLE_WORK_'+name);
    }catch(error){if(error?.code!=='ENOENT')throw error;}
  }
  await quitCurrent();
  for(let i=0;i<25;i++){
    const child=(await run('/bin/ps',['-axo','command='])).stdout;
    if(!child.split('\n').some(s=>s.includes('/Chat On Steroids Next.app/Contents/Resources/tunnel/tunnel-client'))) break;
    if(i===24)throw new Error('LIVE_QA_OLD_TUNNELS_STILL_RUNNING');
    await sleep(300);
  }
  return start(app);
}
async function stop(info){
  await assertNoAmbiguousDelivery();
  await send(info,'quit');
  const until=Date.now()+63000;
  while(Date.now()<until){
    try{process.kill(info.pid,0);}catch{
      await rm(info.dir,{recursive:true,force:true});
      return {stopped:true,sessionRemoved:true};
    }
    await sleep(700);
  }
  throw new Error('LIVE_QA_SHUTDOWN_UNVERIFIED_SESSION_PRESERVED');
}
const [op,first,second]=process.argv.slice(2);
try{
  let answer;
  if(op==='start')answer=await start(first);
  else if(op==='upgrade')answer=await startAfterUpgrade(first);
  else if(op==='quit-current')answer=await quitCurrent();
  else{
    const info=await load(first);
    if(op==='status')answer=await send(info,'status');
    else if(op==='connect')answer=await send(info,'connect');
    else if(op==='receipt')answer=await send(info,'receipt',{id:second??info.attemptId});
    else if(op==='send-fixture'){
      if(info.attemptId)throw new Error('LIVE_QA_ALREADY_ATTEMPTED_SEND: '+info.attemptId);
      const id=randomUUID();
      info.attemptId=id;
      // A locally durable one-shot record is written BEFORE calling the app.
      await save(info);
      try { answer=await send(info,'send-fixture',{id}); }
      catch(error){throw new Error('LIVE_QA_SEND_AMBIGUOUS_CHECK_RECEIPT_ID='+id+'; '+error.message);}
    }
    else if(op==='stop')answer=await stop(info);
    else throw new Error('LIVE_QA_USAGE: start|upgrade <app>; status|connect|send-fixture|receipt|stop <session>');
  }
  process.stdout.write(JSON.stringify(answer)+'\n');
}catch(error){
  process.stderr.write('NEXT_LIVE_CLI_ERROR='+String(error instanceof Error?error.message:'unknown')+'\n');
  process.exitCode=1;
}
