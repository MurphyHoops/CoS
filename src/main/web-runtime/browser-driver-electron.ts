/**
 * Chrome-extension-free, non-activating Computer Use substrate.
 * Chromium CDP actions are sent to one owned hidden Electron WebContents,
 * never macOS CGEvent / AppleScript, global SendInput, OS keyboard or cursor.
 *
 * This is NOT a ChatGPT principal/mission authorization boundary. The caller
 * must separately enforce the native scope/Outbox/limit before a model send.
 */
import {BrowserWindow,session,type Session,type WebContents} from 'electron';
import {WEB_FIRST_PARTITION} from '../next/web-first/host-policy.js';
import {inspectNativeChatGPTPage} from '../next/web-first/web-page-controls.js';
import {registerOwnedWebContents} from './owned-contents.js';

export type ComputerAction=
  | {kind:'click';x:number;y:number}
  | {kind:'type';text:string}
  | {kind:'key';key:'Enter'|'Escape'|'Tab'}
  | {kind:'scroll';x:number;y:number;deltaY:number};

export function isAllowedComputerNavigation(value:string,offlineFixture=false):boolean{
  if(offlineFixture&&value.startsWith('data:text/html,'))return true;
  try{
    const u=new URL(value);
    return u.protocol==='https:'&&u.hostname==='chatgpt.com'&&
      !u.username&&!u.password&&!u.port;
  }catch{return false;}
}
export function validateComputerAction(value:ComputerAction):void{
  if(!value||typeof value!=='object')throw Error('COMPUTER_ACTION_INVALID');
  if(value.kind==='type'){
    if(typeof value.text!=='string'||value.text.length<1||value.text.length>2000)
      throw Error('COMPUTER_TYPE_INVALID');
    return;
  }
  if(value.kind==='key'){
    if(!['Enter','Escape','Tab'].includes(value.key))throw Error('COMPUTER_KEY_INVALID');
    return;
  }
  if(value.kind==='click'||value.kind==='scroll'){
    if(!Number.isFinite(value.x)||!Number.isFinite(value.y)||
      value.x<0||value.y<0||value.x>2000||value.y>2000)
      throw Error('COMPUTER_COORDINATES_INVALID');
    if(value.kind==='scroll'&&(!Number.isFinite(value.deltaY)||Math.abs(value.deltaY)>1500))
      throw Error('COMPUTER_SCROLL_INVALID');
    return;
  }
  throw Error('COMPUTER_ACTION_INVALID');
}
export interface BackgroundWebComputer {
  transportTargetId?:string;
  documentHttpStatus?:()=>number|null;
  webContents:WebContents;
  open(url:string):Promise<void>;
  observe():Promise<{page:'CHATGPT'|'OFFLINE_FIXTURE'|'OTHER';conversation:boolean;
    editorReady:boolean;generating:boolean;messages:number}>;
  screenshot():Promise<Buffer>;
  action(action:ComputerAction):Promise<void>;
  close():void;
  isHidden():boolean;
}
export function createBackgroundWebComputer(options:{offlineFixture?:boolean;
  sharedSession?:Session}={}):BackgroundWebComputer{
  const isFixture=options.offlineFixture===true;
  const background=new BrowserWindow({
    title:'CoS Native Background Computer',
    show:false,skipTaskbar:true,focusable:false,
    width:1030,height:770,backgroundColor:'#ffffff',
    webPreferences:{
      session:options.sharedSession??session.fromPartition(WEB_FIRST_PARTITION),
      offscreen:{useSharedTexture:false},
      backgroundThrottling:false,
      nodeIntegration:false,contextIsolation:true,sandbox:true,
      webSecurity:true,webviewTag:false
    }
  });
  const wc=background.webContents;
  registerOwnedWebContents(wc);
  let closed=false;
  let actionBusy=false;
  const insist=()=>{
    if(closed||background.isDestroyed()||wc.isDestroyed())
      throw Error('BACKGROUND_COMPUTER_CLOSED');
  };
  const allowed=(url:string)=>isAllowedComputerNavigation(url,isFixture);
  wc.setWindowOpenHandler(()=>({action:'deny'}));
  wc.on('will-navigate',(event,url)=>{if(!allowed(url))event.preventDefault();});
  wc.on('will-redirect',(event,url)=>{if(!allowed(url))event.preventDefault();});
  wc.on('will-attach-webview',event=>event.preventDefault());
  background.on('closed',()=>{closed=true;});
  return {
    transportTargetId:'electron-'+wc.id,
    webContents:wc,
    async open(url){
      insist();
      if(!allowed(url))throw Error('BACKGROUND_COMPUTER_URL_BLOCKED');
      await wc.loadURL(url);
      insist();
      if(!allowed(wc.getURL()))throw Error('BACKGROUND_COMPUTER_NAVIGATION_RACE');
    },
    async observe(){
      insist();
      if(!allowed(wc.getURL()))throw Error('BACKGROUND_COMPUTER_URL_BLOCKED');
      const before=wc.getURL();
      const r=await inspectNativeChatGPTPage(wc,isFixture);
      if(wc.getURL()!==before)throw Error('BACKGROUND_COMPUTER_NAVIGATION_RACE');
      const busy=r.composer==='GENERATING';
      return {page:r.page,conversation:r.conversation,
        editorReady:r.composer==='READY',generating:busy,
        messages:r.userMessages+r.assistantMessages};
    },
    async screenshot(){
      insist();
      if(!allowed(wc.getURL()))throw Error('BACKGROUND_COMPUTER_URL_BLOCKED');
      const picture=await wc.capturePage();
      insist();
      if(picture.isEmpty())throw Error('BACKGROUND_COMPUTER_CAPTURE_EMPTY');
      return picture.toPNG();
    },
    async action(input){
      insist();validateComputerAction(input);
      if(actionBusy)throw Error('BACKGROUND_COMPUTER_ACTION_BUSY');
      if(!allowed(wc.getURL()))throw Error('BACKGROUND_COMPUTER_URL_BLOCKED');
      actionBusy=true;
      let attached=false;
      const before=wc.getURL();
      try{
        wc.debugger.attach('1.3');attached=true;
        if(input.kind==='click'){
          await wc.debugger.sendCommand('Input.dispatchMouseEvent',{
            type:'mousePressed',x:input.x,y:input.y,button:'left',clickCount:1});
          await wc.debugger.sendCommand('Input.dispatchMouseEvent',{
            type:'mouseReleased',x:input.x,y:input.y,button:'left',clickCount:1});
        }else if(input.kind==='type'){
          await wc.debugger.sendCommand('Input.insertText',{text:input.text});
        }else if(input.kind==='key'){
          const virtual=input.key==='Enter'?13:input.key==='Escape'?27:9;
          const code=input.key;
          await wc.debugger.sendCommand('Input.dispatchKeyEvent',{
            type:'keyDown',key:code,code,windowsVirtualKeyCode:virtual});
          await wc.debugger.sendCommand('Input.dispatchKeyEvent',{
            type:'keyUp',key:code,code,windowsVirtualKeyCode:virtual});
        }else{
          await wc.debugger.sendCommand('Input.dispatchMouseEvent',{
            type:'mouseWheel',x:input.x,y:input.y,
            deltaX:0,deltaY:input.deltaY});
        }
      }finally{
        if(attached&&wc.debugger.isAttached())wc.debugger.detach();
        actionBusy=false;
      }
      insist();
      if(wc.getURL()!==before||!allowed(wc.getURL()))
        throw Error('BACKGROUND_COMPUTER_NAVIGATION_RACE');
    },
    close(){if(closed)return;closed=true;if(!background.isDestroyed())background.destroy();},
    isHidden(){return !background.isDestroyed()&&!background.isVisible();}
  };
}
