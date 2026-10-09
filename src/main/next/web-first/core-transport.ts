/**
 * Explicit Web-First Core tunnel adoption. The existing Next config/Keychain is
 * accessed only after a separate native operator approval, never on startup.
 * Polling the tunnel is not a model call; it does NOT authenticate host metadata
 * or grant even a single project read without the separate native approval.
 */
import {execFile} from 'node:child_process';
import path from 'node:path';
import {promises as fs} from 'node:fs';
import {startTunnel,TUNNEL_ID_PATTERN,type TunnelHandle} from '../../tunnel/index.js';
import {initSecretsPath,peekSecretWithoutRotation} from '../../secrets.js';
import type {TunnelSettings} from '../../../shared/types.js';

export function webFirstBundledTunnelBinary(resourcesPath:string|undefined=process.resourcesPath):string{
  if(!resourcesPath||!path.isAbsolute(resourcesPath))throw Error('WEBFIRST_BUNDLED_TUNNEL_UNAVAILABLE');
  return path.join(resourcesPath,'tunnel','tunnel-client');
}
export type CoreTunnelState='CONNECTING'|'CONNECTED'|'OFFLINE'|'HOLD';
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
async function otherTunnelOwnerPresent():Promise<boolean>{
  const list=await new Promise<string>((resolve,reject)=>execFile('/bin/ps',
    ['-axo','comm='],{timeout:3500,maxBuffer:3_000_000},
    (error,stdout)=>error?reject(error):resolve(stdout)));
  return list.split('\n').some(s=>
    s.includes('/tunnel/tunnel-client') || s.trim()==='tunnel-client' ||
    s.includes('/Chat On Steroids Next.app/Contents/MacOS/Chat On Steroids Next') ||
    s.includes('/Chat On Steroids.app/Contents/MacOS/Chat On Steroids'));
}
export async function connectWebFirstImportedCore(args:{
  appData:string;
  localUrl:string;
  onChange:(state:CoreTunnelState)=>void;
}):Promise<{get state():CoreTunnelState;connected:Promise<boolean>;stopWithProof:()=>Promise<boolean>}>{
  if(await otherTunnelOwnerPresent())throw Error('EXISTING_CORE_OWNER_PRESENT');
  const source=importedProfile(args.appData);
  const stat=await fs.stat(source.binary);
  if(!stat.isFile())throw Error('TUNNEL_CLIENT_BINARY_NOT_FOUND');
  const raw:unknown=JSON.parse(await fs.readFile(source.configFile,'utf8'));
  const settings={...validateImportedTunnelConfiguration(raw),binaryPath:source.binary};
  // ONLY read a preexisting encrypted Next credential store. Do not copy the
  // secret into the separate Web-First profile and never print its plaintext.
  initSecretsPath(source.sourceUserData);
  const apiKey=await peekSecretWithoutRotation('openaiApiKey');
  if(!apiKey)throw Error('EXISTING_NEXT_KEYCHAIN_UNAVAILABLE');
  let state:CoreTunnelState='CONNECTING';
  args.onChange(state);
  let resolveReady!:(yes:boolean)=>void;
  const connected=new Promise<boolean>(resolve=>{resolveReady=resolve;});
  let completed=false;
  const report=(next:CoreTunnelState)=>{
    if(next===state)return;
    state=next;args.onChange(next);
    if(!completed&&(next==='CONNECTED'||next==='HOLD')){
      completed=true;resolveReady(next==='CONNECTED');
    }
  };
  let handle:TunnelHandle;
  try{
    handle=await startTunnel({settings,apiKey,localUrl:args.localUrl,
      nextRejectOrphans:true,label:'core',report:r=>{
        if(r.state==='connected' && typeof r.handshakeAt==='number' && Date.now()-r.handshakeAt<95_000)
          report('CONNECTED');
        else if(r.state==='offline')report('OFFLINE');
        else if(r.state==='auth-failed')report('HOLD');
      }});
  }catch(error){report('HOLD');throw error;}
  const timer=setTimeout(()=>{if(!completed){completed=true;resolveReady(false);report('HOLD');}},95000);
  let stopFlight:Promise<boolean>|null=null;
  return {get state(){return state;},connected,
    stopWithProof:()=>stopFlight??=(async()=>{
      clearTimeout(timer);
      if(!completed){completed=true;resolveReady(false);}
      const proof=await handle.stopWithProof?.();
      report('HOLD');
      return proof===true;
    })()
  };
}
