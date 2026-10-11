/** Transport-only adapter for the ORIGINAL CoS Classic Goal/Agent/MCP
 * authority. Real account: standard Chrome exclusive profile, visible manual
 * login followed by headless Chrome CDP PIPE on exactly the SAME profile.
 * Fixture tests retain the pre-existing Electron substrate, unchanged.
 */
import {spawn,type ChildProcess} from 'node:child_process';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {archiveExitedOwnedChromeSingleton} from './chrome-login-locks.js';
import {browserControl} from '../browser-control.js';
import {ElectronWebRuntimeSupervisor} from './supervisor.js';
import {ChromeWebRuntimeSupervisor,STANDARD_CHROME_BINARY,
  type NativeMultiPageSupervisor} from './chrome-supervisor.js';
import {ProfileLease} from './profile-owner.js';
import {NativeClassicMultiPageExecutor} from './classic-multi-page-executor.js';
import {isAllowedComputerNavigation} from './browser-driver-electron.js';

type ManagedSupervisor=NativeMultiPageSupervisor&{
  start:()=>Promise<unknown>;stop:()=>Promise<void>;
};
let runtime:ManagedSupervisor|null=null;
let unbind:(()=>void)|null=null;
let multi:NativeClassicMultiPageExecutor|null=null;
let pending:Promise<void>|null=null;
let rootPath:string|null=null;
let useFixture=false;
let loginProcess:ChildProcess|null=null;
let loginLease:ProfileLease|null=null;
let loginFinalization:Promise<void>|null=null;
let reopenLoginRequested=false;
let switching=false;
let shutdown=false;
let statusListener:(()=>void)|null=null;
export function onClassicNativeStatusChange(callback:()=>void):void{
  statusListener=callback;
}
function notifyStatus():void{try{statusListener?.();}catch{/* UI closed */}}

export function getClassicNativeWebComputer(){
  if(!runtime?.running)throw Error('NATIVE_CLASSIC_NOT_STARTED');
  return runtime.requireComputer();
}
export async function showNativeBrowserForVerification(visible:boolean):Promise<void>{
  // This changes only the bounds of the already owned Chrome window.
  // It never releases/restarts the profile or modifies an account.
  if(!(runtime instanceof ChromeWebRuntimeSupervisor)||!runtime.running)
    throw Error('NATIVE_CLASSIC_BROWSER_NOT_READY');
  await runtime.setOperatorVisible(visible);
}
export function classicNativeWebHealth():string {
  if(loginProcess)return 'USER_LOGIN_STANDARD_CHROME';
  if(switching)return 'CHROME_PROFILE_TRANSITION';
  return runtime?.running?'READY':'NOT_STARTED';
}
export async function startClassicNativeWebRuntime(root:string,
  offlineFixture=false):Promise<void>{
  if(runtime?.running)return;
  if(pending)return pending;
  if(loginProcess||switching)throw Error('NATIVE_CLASSIC_LOGIN_IN_PROGRESS');
  if(!path.isAbsolute(root))throw Error('NATIVE_CLASSIC_ROOT_INVALID');
  rootPath=root;useFixture=offlineFixture;shutdown=false;
  pending=(async()=>{
    const supervisor:ManagedSupervisor=offlineFixture?
      new ElectronWebRuntimeSupervisor(root,true):new ChromeWebRuntimeSupervisor(root);
    try{
      await supervisor.start();
      const executor=new NativeClassicMultiPageExecutor(supervisor,offlineFixture);
      const unregister=browserControl.installNativeExecutor(executor);
      runtime=supervisor;unbind=unregister;multi=executor;
      notifyStatus();
    }catch(e){await supervisor.stop().catch(()=>undefined);throw e;}
  })();
  try{await pending;}finally{pending=null;}
}
async function stopOnlyTransport():Promise<void>{
  if(pending)await pending.catch(()=>undefined);
  const previous=runtime;
  unbind?.();unbind=null;
  multi?.retire();multi=null;
  await previous?.stop();
  runtime=null;
  notifyStatus();
}
/** Native Chrome login window, not Electron's broken Google OAuth WebView.
 * Resumes the SAME Chrome profile after the owned visible Chrome quits.
 * Never copies credentials, never attaches to the user's daily Chrome.
 */
export async function showClassicNativeLogin():Promise<void>{
  if(switching)throw Error('NATIVE_CLASSIC_PROFILE_BUSY');
  if(!rootPath||useFixture)throw Error('NATIVE_CLASSIC_LOGIN_NOT_AVAILABLE');
  if(loginProcess){
    // On macOS closing the final Chrome window does not exit the app.
    // Forwarding --new-window to that still-live Chrome is unreliable.
    // Explicit user reopen: terminate ONLY the CoS-owned child and start
    // a fresh visible Chrome after the identical Profile is fully released.
    if(!loginLease||loginProcess.exitCode!==null)
      throw Error('NATIVE_CLASSIC_LOGIN_OWNER_UNCERTAIN');
    if(reopenLoginRequested)return;
    reopenLoginRequested=true;
    if(!loginProcess.kill('SIGTERM')){
      reopenLoginRequested=false;
      throw Error('NATIVE_CLASSIC_LOGIN_REOPEN_TERMINATION_FAILED');
    }
    return;
  }
  switching=true;
  const root=rootPath;
  let lease:ProfileLease|null=null;
  try{
    await stopOnlyTransport();
    const profile=path.join(root,'standard-chrome-profile');
    lease=await ProfileLease.acquire(profile);
    // A different normal Chrome process may still have an OS SingletonLock.
    if(await fs.lstat(path.join(profile,'SingletonLock'))
      .then(()=>true,()=>false))throw Error('CHROME_PROFILE_EXTERNALLY_OPEN');
    const child=spawn(STANDARD_CHROME_BINARY,[
      '--user-data-dir='+profile,'--profile-directory=Default',
      '--new-window','--no-first-run','--no-default-browser-check',
      '--disable-background-mode','https://chatgpt.com/'
    ],{stdio:'ignore',detached:false,env:{...process.env,NODE_OPTIONS:''}});
    await new Promise<void>((resolve,reject)=>{
      child.once('spawn',()=>resolve());child.once('error',reject);
    });
    loginProcess=child;loginLease=lease;lease=null;
    notifyStatus();
    const finish=async()=>{
      if(loginProcess!==child)return;
      loginProcess=null;
      const owned=loginLease;
      // Chrome has exited; recover only its verified orphan IPC sentinels.
      // Do not remove any login credentials or claim another owner's profile.
      try{
        const profile=path.join(root,'standard-chrome-profile');
        const sentinel=path.join(profile,'SingletonLock');
        for(let i=0;i<15;i++){
          const busy=await fs.lstat(sentinel).then(()=>true,()=>false);
          if(!busy)break;
          await new Promise(resolve=>setTimeout(resolve,100));
        }
        await archiveExitedOwnedChromeSingleton(profile,child.pid??0);
        await owned?.release();
        if(loginLease===owned)loginLease=null;
      }catch{return;} // Fail closed on unexpected lock ownership.
      const reopen=reopenLoginRequested;
      reopenLoginRequested=false;
      if(!shutdown&&rootPath===root){
        if(reopen)await showClassicNativeLogin().catch(()=>undefined);
        else await startClassicNativeWebRuntime(root,false).catch(()=>undefined);
      }
      notifyStatus();
    };
    child.once('exit',()=>{loginFinalization=finish();void loginFinalization;});
  }finally{
    if(lease)await lease.release();
    switching=false;
  }
}
/** Explicit cancel action; kills only the Chrome process CoS itself spawned.
 * Never closes the user's default Chrome or an unidentified profile owner.
 */
export function cancelClassicNativeLogin():void{
  loginProcess?.kill('SIGTERM');
}
export async function openClassicNativeConversation(url:string):Promise<void>{
  const supervisor=runtime;
  if(!supervisor?.running)throw Error('NATIVE_CLASSIC_NOT_STARTED');
  if(!isAllowedComputerNavigation(url))throw Error('NATIVE_CLASSIC_CHATGPT_ONLY');
  const page=await supervisor.createPage();
  try{await page.open(url);}
  catch(e){await supervisor.closePage(page);throw e;}
}
export async function stopClassicNativeWebRuntime():Promise<void>{
  shutdown=true;
  await stopOnlyTransport();
  const child=loginProcess;
  if(child){
    // Electron's app.quit() must WAIT for our visible Chrome child and
    // ProfileLease to exit. Otherwise a stale .cos owner file prevents the
    // next launch even though Chrome has already terminated.
    if(child.exitCode===null&&!child.kill('SIGTERM'))
      throw Error('NATIVE_LOGIN_CHILD_TERMINATION_FAILED');
    const deadline=Date.now()+8000;
    while(loginProcess===child&&Date.now()<deadline)
      await new Promise(resolve=>setTimeout(resolve,100));
    if(loginProcess===child)throw Error('NATIVE_LOGIN_CHILD_EXIT_TIMEOUT');
  }
  if(loginFinalization)await loginFinalization;
  if(loginLease)throw Error('NATIVE_LOGIN_PROFILE_LEASE_STILL_OWNED');
}
