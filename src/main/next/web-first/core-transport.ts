/**
 * Explicit Web-First Core tunnel adoption. The existing Next config/Keychain is
 * accessed only after a separate native operator approval, never on startup.
 * Polling the tunnel is not a model call; it does NOT authenticate host metadata
 * or grant even a single project read without the separate native approval.
 */
import {execFile,spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import path from 'node:path';
import {promises as fs} from 'node:fs';
import {TUNNEL_ID_PATTERN} from '../../tunnel/index.js';
import {parseBrokerSignal} from './core-broker.js';
import type {TunnelSettings} from '../../../shared/types.js';

export function webFirstBundledTunnelBinary(resourcesPath:string|undefined=process.resourcesPath):string{
  if(!resourcesPath||!path.isAbsolute(resourcesPath))throw Error('WEBFIRST_BUNDLED_TUNNEL_UNAVAILABLE');
  return path.join(resourcesPath,'tunnel','tunnel-client');
}
export type CoreTunnelState='CONNECTING'|'CONNECTED'|'OFFLINE'|'HOLD';
/** A process retiring its owner can NEVER be a source for a retry. */
export function coreRecoveryEligible(x:{offline:boolean;closing:boolean;quitting:boolean;
  requested:boolean;localService:boolean;windowAlive:boolean;
  recovering:boolean;connectionInFlight:boolean}):boolean{
  return !x.offline&&!x.closing&&!x.quitting&&x.requested&&x.localService&&
    x.windowAlive&&!x.recovering&&!x.connectionInFlight;
}

export function coreRecoveryDecision(args:{requested:boolean;brokerAlive:boolean;
  ownerPresent:boolean;attempts:number;dueAt:number;now:number}):'idle'|'retry'|'hold'{
  if(!args.requested||args.brokerAlive)return 'idle';
  if(args.ownerPresent||args.attempts>=4)return 'hold';
  return args.now>=args.dueAt?'retry':'idle';
}

export type WebFirstTunnelProfile={configFile:string;sourceUserData:string;binary:string};
export function importedProfile(appData:string):WebFirstTunnelProfile{
  if(!path.isAbsolute(appData))throw Error('WEBFIRST_APPDATA_INVALID');
  const userData=path.join(appData,'chat-on-steroids-next');
  return {sourceUserData:userData,configFile:path.join(userData,'config.json'),binary:webFirstBundledTunnelBinary()};
}
export function validateImportedTunnelConfiguration(value:unknown):Omit<TunnelSettings,'binaryPath'>{
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('TUNNEL_CONFIG_INVALID');
  const entry=(value as {tunnel?:unknown}).tunnel;
  if(!entry||typeof entry!=='object'||Array.isArray(entry))throw Error('TUNNEL_CONFIG_INVALID');
  const settings=entry as Partial<TunnelSettings>;
  if(settings.kind!=='openai'||!settings.tunnelId||!TUNNEL_ID_PATTERN.test(settings.tunnelId))
    throw Error('TUNNEL_CONFIG_INVALID');
  const checked={...settings,kind:'openai' as const,tunnelId:settings.tunnelId};
  delete checked.binaryPath; // never trust a persisted source binary override
  return checked as Omit<TunnelSettings,'binaryPath'>;
}
export async function existingTunnelOwnerPresent():Promise<boolean>{
  const list=await new Promise<string>((resolve,reject)=>execFile('/bin/ps',
    ['-axo','comm='],{timeout:3500,maxBuffer:3_000_000},
    (error,stdout)=>error?reject(error):resolve(stdout)));
  return list.split('\n').some(s=>
    s.includes('/tunnel/tunnel-client') || s.trim()==='tunnel-client' ||
    s.includes('/Chat On Steroids Next.app/Contents/MacOS/Chat On Steroids Next') ||
    s.includes('/Chat On Steroids.app/Contents/MacOS/Chat On Steroids'));
}
/** Native parent launches a separately Keychain-named short-lived broker. */
export async function connectWebFirstImportedCore(args:{
  appData:string;
  localUrl:string;
  onChange:(state:CoreTunnelState)=>void;
}):Promise<{get state():CoreTunnelState;get alive():boolean;
  connected:Promise<boolean>;stopWithProof:()=>Promise<boolean>}>{
  if(await existingTunnelOwnerPresent())throw Error('EXISTING_CORE_OWNER_PRESENT');
  if(!args.localUrl.startsWith('http://127.0.0.1:'))throw Error('LOCAL_URL_INVALID');
  const source=importedProfile(args.appData);
  // Check only the existence of read-only source config and a trusted native binary.
  if(!(await fs.stat(source.binary)).isFile())throw Error('TUNNEL_CLIENT_BINARY_NOT_FOUND');
  validateImportedTunnelConfiguration(JSON.parse(await fs.readFile(source.configFile,'utf8')));
  const child=spawn(process.execPath,[],{
    env:{...process.env,COS_NEXT_WEBFIRST_CORE_BROKER:'1',
      COS_NEXT_WEBFIRST_BROKER_ENDPOINT:args.localUrl},
    stdio:['pipe','pipe','ignore'],windowsHide:true
  });
  let state:CoreTunnelState='CONNECTING';
  args.onChange(state);
  let completeReady!:(value:boolean)=>void;
  let completeStopped!:(value:boolean)=>void;
  const connected=new Promise<boolean>(resolve=>{completeReady=resolve;});
  const stopped=new Promise<boolean>(resolve=>{completeStopped=resolve;});
  let readyDone=false,stopDone=false,buffer='';
  const ready=(ok:boolean)=>{if(!readyDone){readyDone=true;completeReady(ok);}};
  const stopReported=(ok:boolean)=>{if(!stopDone){stopDone=true;completeStopped(ok);}};
  const update=(v:CoreTunnelState)=>{if(state!==v){state=v;args.onChange(v);}};
  child.stdin?.on('error',()=>{update('HOLD');ready(false);});
  child.stdout?.on('data',(chunk:Buffer)=>{
    buffer+=chunk.toString('utf8');
    if(buffer.length>16_384){buffer='';return;}
    let index=buffer.indexOf('\n');
    while(index>=0){
      const line=buffer.slice(0,index);buffer=buffer.slice(index+1);
      const signal=parseBrokerSignal(line);
      if(signal==='CONNECTED'){update('CONNECTED');ready(true);}
      if(signal==='OFFLINE')update('OFFLINE');
      if(signal==='FAILED'){update('HOLD');ready(false);}
      if(signal==='STOPPED_PROVEN')stopReported(true);
      if(signal==='STOPPED_UNVERIFIED')stopReported(false);
      index=buffer.indexOf('\n');
    }
  });
  child.once('error',()=>{update('HOLD');ready(false);stopReported(false);});
  child.once('exit',()=>{update('HOLD');ready(false);stopReported(false);});
  const timeout=setTimeout(()=>{update('HOLD');ready(false);},95_000);
  timeout.unref();
  let stopFlight:Promise<boolean>|null=null;
  return {get state(){return state;},get alive(){return child.exitCode===null&&child.signalCode===null;},connected,
    stopWithProof:()=>stopFlight??=(async()=>{
      clearTimeout(timeout);
      ready(false);
      if(child.exitCode!==null||child.signalCode!==null)return stopDone?await stopped:false;
      child.stdin?.write('STOP\n');
      child.stdin?.end();
      const result=await Promise.race([stopped,delay(10_000).then(()=>false)]);
      if(!result)update('HOLD');
      return result;
    })()
  };
}
