#!/usr/bin/env node
/**
 * Private, offline CoS Next Classic packaged-app controller.
 * Each session launches an independent macOS app under a disposable HOME.
 * Commands are allowlisted by the app over a 0600 UNIX socket; NO DevTools,
 * raw JS, remote connectors, or existing user-profile access.
 *
 * Usage:
 *   node scripts/next-classic-cli.mjs verify /absolute/path/Chat\ On\ Steroids\ Next.app
 *   node scripts/next-classic-cli.mjs start <app>
 *   node scripts/next-classic-cli.mjs status|outbox|restart|stop <temporary-session>
 *   node scripts/next-classic-cli.mjs theme <temporary-session> dark|light
 *   node scripts/next-classic-cli.mjs send <temporary-session> 'Next CLI fixture: something'
 */
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { mkdtemp, mkdir, readFile, writeFile, chmod, rm, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const prefix = 'cos-next-ctl-';
const sessionFile = 'test-session.json';
const oldFixture = '{"sentinel":"old CoS profile immutable during CLI test"}\n';
const oldHash = createHash('sha256').update(oldFixture).digest('hex');

function ownRoot(session) {
  const p=path.resolve(session);
  if (path.dirname(p)!==path.resolve(os.tmpdir()) || !path.basename(p).startsWith(prefix))
    throw new Error('NEXT_CLI_ONLY_PRIVATE_TEMP_SESSION');
  return p;
}
async function load(session) {
  const root=ownRoot(session);
  const info=JSON.parse(await readFile(path.join(root,sessionFile),'utf8'));
  if (info.version!==1 || info.home!==root || !info.app?.endsWith('/Chat On Steroids Next.app') || !Number.isSafeInteger(info.pid))
    throw new Error('NEXT_CLI_SESSION_INVALID');
  const f=await stat(root);
  if ((f.mode & 0o077)!==0 || (typeof process.getuid==='function' && f.uid!==process.getuid()))
    throw new Error('NEXT_CLI_SESSION_NOT_PRIVATE');
  return info;
}
async function persist(info) {
  await writeFile(path.join(info.home,sessionFile),JSON.stringify(info)+'\n',{mode:0o600});
  await chmod(path.join(info.home,sessionFile),0o600);
}
function socketRequest(root,request) {
  return new Promise((resolve,reject)=>{
    const client=createConnection(path.join(root,'control.sock'));
    let settled=false, bytes='';
    const done=(error,value)=>{if(settled)return;settled=true;client.destroy();error?reject(error):resolve(value);};
    client.setTimeout(8000,()=>done(new Error('NEXT_CLI_SOCKET_TIMEOUT')));
    client.on('error',error=>done(error));
    client.on('connect',()=>client.write(JSON.stringify(request)+'\n'));
    client.on('data',buf=>{
      bytes+=buf.toString('utf8');
      if(bytes.length>16384)return done(new Error('NEXT_CLI_RESPONSE_TOO_LARGE'));
      if(bytes.includes('\n')){
        try {const r=JSON.parse(bytes.slice(0,bytes.indexOf('\n')));
          if(!r.ok)throw new Error(r.error||'NEXT_CLI_REQUEST_REJECTED');
          done(null,r.data);
        }catch(error){done(error);}
      }
    });
    client.on('end',()=>{if(!settled)done(new Error('NEXT_CLI_NO_REPLY'));});
  });
}
function safeChildEnv(home) {
  const env={...process.env};
  for(const key of Object.keys(env)){
    if (/SECRET|TOKEN|PASSWORD|CREDENTIAL|COOKIE|AUTH|API_KEY|OPENAI_|ANTHROPIC_|CODEX_|^COS_/i.test(key)) delete env[key];
  }
  return {...env, HOME:home, COS_NEXT_E2E_TEMP_PROFILE:'1', COS_NEXT_TEST_CONTROL_SOCKET:path.join(home,'control.sock')};
}
function spawnApp(info) {
  const exe=path.join(info.app,'Contents','MacOS','Chat On Steroids Next');
  const child=spawn(exe,[],{env:safeChildEnv(info.home),stdio:'ignore',detached:true});
  child.unref();
  return child.pid;
}
async function waitReady(root,pid) {
  const deadline=Date.now()+22000;
  while(Date.now()<deadline){
    try {
      const v=await socketRequest(root,{op:'status'});
      if(v?.ready && v?.hasWindow){
        const controls=await socketRequest(root,{op:'ui-status'});
        if(controls?.ready && controls.hasChat && controls.hasGoal && controls.hasSettings){
          await delay(250);return controls;
        }
      }
    }catch{ /* native startup may still be loading */ }
    try{process.kill(pid,0);}catch{throw new Error('NEXT_CLI_APP_EXITED_BEFORE_READY');}
    await delay(100);
  }
  throw new Error('NEXT_CLI_APP_NOT_READY');
}
async function begin(app){
  if(!app || !path.isAbsolute(app) || !app.endsWith('/Chat On Steroids Next.app'))throw new Error('NEXT_CLI_NEEDS_ABSOLUTE_APP_PATH');
  const verified=await realpath(app);
  if(verified!==path.resolve(app))throw new Error('NEXT_CLI_APP_MUST_NOT_BE_SYMLINK');
  await stat(path.join(app,'Contents/MacOS/Chat On Steroids Next'));
  const home=await mkdtemp(path.join(os.tmpdir(),prefix));
  await chmod(home,0o700);
  const old=path.join(home,'Library/Application Support/chat-on-steroids');
  const next=path.join(home,'Library/Application Support/chat-on-steroids-next');
  await mkdir(old,{recursive:true,mode:0o700});
  await mkdir(path.join(next,'state'),{recursive:true,mode:0o700});
  await writeFile(path.join(old,'config.json'),oldFixture,{mode:0o600});
  await writeFile(path.join(next,'state/chat-models.json'),JSON.stringify({
    observedAt:Date.now(),models:[{id:'synthetic-offline-model',label:'GPT-6',efforts:['high']}]
  }),{mode:0o600});
  const info={version:1,home,app,pid:0};
  try{
    info.pid=spawnApp(info);
    await persist(info);
    await waitReady(home,info.pid);
    return info;
  }catch(error){
    if(info.pid){
      try{process.kill(info.pid,'SIGTERM');}catch{}
      for(let i=0;i<25;i++){try{process.kill(info.pid,0);}catch{break;}await delay(100);}
      try{process.kill(info.pid,'SIGKILL');}catch{}
    }
    await delay(200);
    await rm(home,{recursive:true,force:true});
    throw error;
  }
}
async function waitExit(info){
  for(let i=0;i<320;i++){
    try{process.kill(info.pid,0);}catch{return;}
    await delay(100);
  }
  throw new Error('NEXT_CLI_SHUTDOWN_UNVERIFIED');
}
async function validateOld(root){
  const old=await readFile(path.join(root,'Library/Application Support/chat-on-steroids/config.json'));
  if(createHash('sha256').update(old).digest('hex')!==oldHash)throw new Error('NEXT_CLI_ORIGINAL_PROFILE_CHANGED');
  return true;
}
async function shutdown(info,cleanup=true){
  await socketRequest(info.home,{op:'quit'});
  await waitExit(info);
  await validateOld(info.home);
  if(cleanup)await rm(info.home,{recursive:true,force:true});
  return {stopped:true,oldProfileUnchanged:true,cleanedUp:cleanup};
}
async function restart(info){
  await shutdown(info,false);
  info.pid=spawnApp(info);
  await persist(info);
  return await waitReady(info.home,info.pid);
}
async function sendFixture(info,text){
  await socketRequest(info.home,{op:'send-fixture',text});
  for(let i=0;i<80;i++){
    const all=await socketRequest(info.home,{op:'outbox'});
    const found=all.find(row=>row.text===text);
    if(found)return found;
    await delay(100);
  }
  throw new Error('NEXT_CLI_INPUT_NOT_ADMITTED');
}
async function verify(app){
  const info=await begin(app);
  let finished=false;
  try{
    const sock=await stat(path.join(info.home,'control.sock'));
    if((sock.mode & 0o077)!==0)throw new Error('NEXT_CLI_CONTROL_SOCKET_NOT_PRIVATE');
    try {await socketRequest(info.home,{op:'arbitrary-js',source:'process.exit()'});
      throw new Error('NEXT_CLI_FORBIDDEN_OPERATION_ACCEPTED');
    }catch(error){if(error instanceof Error && error.message==='NEXT_CLI_FORBIDDEN_OPERATION_ACCEPTED')throw error;}
    const before=await socketRequest(info.home,{op:'ui-status'});
    if(!before.hasChat||!before.hasGoal||!before.hasSettings)throw new Error('NEXT_CLI_CLASSIC_UI_MISSING');
    const theme=before.theme==='dark'?'light':'dark';
    const selected=await socketRequest(info.home,{op:'theme',value:theme});
    if(selected.theme!==theme)throw new Error('NEXT_CLI_THEME_NOT_CHANGED');
    // Observe the actual persisted JSON; UI feedback alone isn't durability.
    let saved=false;
    for(let i=0;i<80;i++){
      try{
        const cfg=JSON.parse(await readFile(path.join(info.home,'Library/Application Support/chat-on-steroids-next/config.json'),'utf8'));
        if(cfg.ui?.theme===theme){saved=true;break;}
      }catch{ /* save IPC has not committed yet */ }
      await delay(100);
    }
    if(!saved)throw new Error('NEXT_CLI_THEME_NOT_SAVED');
    const text='Next CLI fixture: offline durable queue verification';
    const accepted=await sendFixture(info,text);
    if(accepted.state!=='queued'||accepted.deliveredAt!==null)throw new Error('NEXT_CLI_OFFLINE_FALSE_DELIVERY');
    await restart(info);
    const after=await socketRequest(info.home,{op:'ui-status'});
    if(after.theme!==theme)throw new Error('NEXT_CLI_THEME_NOT_RESTORED');
    const rows=await socketRequest(info.home,{op:'outbox'});
    const recovered=rows.find(x=>x.id===accepted.id);
    if(!recovered||recovered.text!==text||recovered.state!=='queued'||recovered.deliveredAt!==null)
      throw new Error('NEXT_CLI_DURABLE_INPUT_NOT_RESTORED');
    const ended=await shutdown(info);
    finished=true;
    return {verified:true,privateSocket:true,realPackagedRenderer:true,
      themeSavedAndRestored:true,queuedInputIdPreserved:true,noFalseDelivery:true,arbitraryCodeRejected:true,
      oldProfileUnchanged:ended.oldProfileUnchanged,temporaryHomeCleaned:true};
  }finally{
    if(!finished){try{await shutdown(info);}catch{/* retain unsafe session for manual inspection */}}
  }
}
const [operation,arg,value]=process.argv.slice(2);
try{
  let result;
  if(operation==='start')result=await begin(arg);
  else if(operation==='verify')result=await verify(arg);
  else{
    const info=await load(arg);
    if(operation==='status'||operation==='ui-status'||operation==='outbox')result=await socketRequest(info.home,{op:operation});
    else if(operation==='theme')result=await socketRequest(info.home,{op:'theme',value});
    else if(operation==='send')result=await sendFixture(info,value);
    else if(operation==='restart')result=await restart(info);
    else if(operation==='stop')result=await shutdown(info);
    else throw new Error('NEXT_CLI_USAGE: start/verify <app>; status/outbox/restart/stop <session>; theme <session> dark|light; send <session> marked-fixture');
  }
  process.stdout.write(JSON.stringify(result)+'\n');
}catch(error){
  process.stderr.write('NEXT_CLASSIC_CLI_ERROR='+(error instanceof Error ? error.message : 'unknown')+'\n');
  process.exitCode=1;
}
