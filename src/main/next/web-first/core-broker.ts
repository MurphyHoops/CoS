/**
 * Dedicated OS-identity bridge for the user's EXISTING Next Keychain.
 * Only launched after an explicit native UI approval. No plaintext key ever
 * crosses stdout, IPC, environment, command line, disk or the webpage.
 */
import {app} from 'electron';
import {promises as fs} from 'node:fs';
import {initSecretsPath,peekSecretWithoutRotation} from '../../secrets.js';
import {startTunnel,type TunnelHandle} from '../../tunnel/index.js';
import {importedProfile,validateImportedTunnelConfiguration,existingTunnelOwnerPresent} from './core-transport.js';

export const BROKER_PREFIX='WEBFIRST_CORE_BROKER_';
export type CoreBrokerSignal='READY'|'CONNECTED'|'OFFLINE'|'FAILED'|'STOPPED_PROVEN'|'STOPPED_UNVERIFIED';
export function parseBrokerSignal(line:string):CoreBrokerSignal|null{
  const exact=line.trim();
  if(!exact.startsWith(BROKER_PREFIX))return null;
  const value=exact.slice(BROKER_PREFIX.length);
  return ['READY','CONNECTED','OFFLINE','FAILED','STOPPED_PROVEN','STOPPED_UNVERIFIED'].includes(value)
    ?value as CoreBrokerSignal:null;
}
export async function runWebFirstCoreBroker(appData:string){
  const status=(s:CoreBrokerSignal)=>process.stdout.write(BROKER_PREFIX+s+'\n');
  let handle:TunnelHandle|null=null;
  let stopping:Promise<boolean>|null=null;
  let shuttingDown=false;
  const stop=():Promise<boolean>=>stopping??=(async()=>{
    if(!handle)return true;
    return (await handle.stopWithProof?.())===true;
  })();
  const finish=async()=>{
    if(shuttingDown)return;
    shuttingDown=true;
    const proven=await stop().catch(()=>false);
    status(proven?'STOPPED_PROVEN':'STOPPED_UNVERIFIED');
    app.exit(proven?0:4);
  };
  // Parent owns the broker via an open pipe. Loss of parent drops stdin.
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  let buffer='';
  process.stdin.on('data',(chunk:string)=>{
    buffer+=chunk;
    if(buffer.length>1000){void finish();return;}
    if(buffer.includes('STOP\n'))void finish();
  });
  process.stdin.on('end',()=>{void finish();});
  process.on('SIGTERM',()=>{void finish();});
  process.on('SIGINT',()=>{void finish();});
  try{
    // The active Keychain service name is set to the user's prior Next app
    // BEFORE app.whenReady in the Electron entrypoint, independent of the
    // ChatGPT Web-First content profile and its login cookies.
    if(await existingTunnelOwnerPresent())throw Error('OWNER_CONFLICT');
    const source=importedProfile(appData);
    const value:unknown=JSON.parse(await fs.readFile(source.configFile,'utf8'));
    const settings={...validateImportedTunnelConfiguration(value),binaryPath:source.binary};
    if(!(await fs.stat(source.binary)).isFile())throw Error('MISSING_TUNNEL');
    initSecretsPath(source.sourceUserData);
    const credential=await peekSecretWithoutRotation('openaiApiKey');
    if(!credential)throw Error('KEYCHAIN_UNAVAILABLE');
    // Secret is held only in this short-lived child process and sent only
    // to the official tunnel client's stdin/config in startTunnel.
    const endpoint=process.env.COS_NEXT_WEBFIRST_BROKER_ENDPOINT;
    if(!endpoint||!/^http:\/\/127\.0\.0\.1:\d{2,5}\/web-first\/[A-Za-z0-9_-]{30,96}\/mcp$/.test(endpoint))
      throw Error('LOCAL_ENDPOINT_INVALID');
    status('READY');
    handle=await startTunnel({settings,apiKey:credential,localUrl:endpoint,
      nextRejectOrphans:true,label:'core',report:r=>{
        if(r.state==='connected'&&typeof r.handshakeAt==='number' &&
            Date.now()-r.handshakeAt<95_000)status('CONNECTED');
        else if(r.state==='offline')status('OFFLINE');
      }});
  }catch{
    status('FAILED');
    await finish();
  }
}
