/** Owns a single dedicated STANDARD Chrome profile and hidden CDP PIPE
 * transport. The same profile is temporarily handed to a visible normal
 * Chrome process for user login, NEVER concurrently. No Chrome extension.
 */
import {promises as fs} from 'node:fs';
import path from 'node:path';
import type {WebContents} from 'electron';
import {inspectNativeChatGPTPage} from '../next/web-first/web-page-controls.js';
import {isAllowedComputerNavigation,validateComputerAction,
  type BackgroundWebComputer,type ComputerAction} from './browser-driver-electron.js';
import {ProfileLease} from './profile-owner.js';
import {ChromePipe,type ChromePipePage} from './chrome-pipe.js';

const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function makeChromeComputer(page:ChromePipePage):BackgroundWebComputer {
  // The legacy CoS browser executor requires only getURL, executeJavaScript,
  // id and CDP debugger methods. Keep this compatibility shim localized.
  const surface=page as unknown as WebContents;
  let busy=false;
  const requireAllowed=()=>{
    if(!isAllowedComputerNavigation(page.getURL()))
      throw Error('CHROME_COMPUTER_CHATGPT_ONLY');
  };
  return {
    transportTargetId:'chrome-'+page.id,
    documentHttpStatus:()=>page.documentHttpStatus(),
    webContents:surface,
    async open(url:string){
      if(!isAllowedComputerNavigation(url))throw Error('CHROME_COMPUTER_URL_BLOCKED');
      await page.navigate(url);
      requireAllowed();
    },
    async observe(){
      requireAllowed();
      const old=page.getURL();
      const r=await inspectNativeChatGPTPage(surface);
      if(page.getURL()!==old)throw Error('CHROME_PAGE_NAVIGATION_RACE');
      return {page:r.page,conversation:r.conversation,
        editorReady:r.composer==='READY',generating:r.composer==='GENERATING',
        messages:r.userMessages+r.assistantMessages};
    },
    async screenshot(){
      requireAllowed();
      const data=await page.command('Page.captureScreenshot',{format:'png'});
      if(typeof data.data!=='string'||data.data.length>3_000_000)
        throw Error('CHROME_SCREENSHOT_INVALID');
      return Buffer.from(data.data,'base64');
    },
    async action(input:ComputerAction){
      validateComputerAction(input);requireAllowed();
      if(busy)throw Error('CHROME_COMPUTER_ACTION_BUSY');
      busy=true;
      const before=page.getURL();
      try{
        if(input.kind==='click'){
          await page.command('Input.dispatchMouseEvent',{
            type:'mousePressed',x:input.x,y:input.y,button:'left',clickCount:1});
          await page.command('Input.dispatchMouseEvent',{
            type:'mouseReleased',x:input.x,y:input.y,button:'left',clickCount:1});
        }else if(input.kind==='type'){
          await page.command('Input.insertText',{text:input.text});
        }else if(input.kind==='key'){
          const keyCode=input.key==='Enter'?13:input.key==='Escape'?27:9;
          await page.command('Input.dispatchKeyEvent',{
            type:'keyDown',key:input.key,code:input.key,windowsVirtualKeyCode:keyCode});
          await page.command('Input.dispatchKeyEvent',{
            type:'keyUp',key:input.key,code:input.key,windowsVirtualKeyCode:keyCode});
        }else{
          await page.command('Input.dispatchMouseEvent',{
            type:'mouseWheel',x:input.x,y:input.y,deltaX:0,deltaY:input.deltaY});
        }
      }finally{busy=false;}
      if(page.getURL()!==before||!isAllowedComputerNavigation(page.getURL()))
        throw Error('CHROME_COMPUTER_NAVIGATION_RACE');
    },
    close(){void page.command('Page.stopLoading').catch(()=>undefined);},
    isHidden(){return true;}
  };
}
export interface NativeMultiPageSupervisor {
  readonly running:boolean;
  listPageTargets():number[];
  requireComputer():BackgroundWebComputer;
  createPage():BackgroundWebComputer|Promise<BackgroundWebComputer>;
  closePage(page:BackgroundWebComputer):void|Promise<void>;
}
export class ChromeWebRuntimeSupervisor implements NativeMultiPageSupervisor {
  private lease:ProfileLease|null=null;
  private pipe:ChromePipe|null=null;
  private computer:BackgroundWebComputer|null=null;
  private pages=new Map<BackgroundWebComputer,ChromePipePage>();
  private busy=false;
  readonly profilePath:string;
  constructor(root:string){
    if(!path.isAbsolute(root)||root.includes('\0'))
      throw Error('CHROME_SUPERVISOR_ROOT_INVALID');
    this.profilePath=path.join(root,'standard-chrome-profile');
  }
  get running(){return !this.busy&&!!this.lease&&!!this.pipe?.alive&&this.pages.size>0;}
  listPageTargets(){return [...this.pages.values()].map(page=>page.id);}
  requireComputer(){
    if(!this.running||!this.computer)throw Error('CHROME_SUPERVISOR_NOT_STARTED');
    return this.computer;
  }
  async setOperatorVisible(visible:boolean):Promise<void>{
    if(!this.running||!this.computer)throw Error('CHROME_SUPERVISOR_NOT_STARTED');
    const page=this.pages.get(this.computer);
    if(!page)throw Error('CHROME_SUPERVISOR_OWNER_PAGE_MISSING');
    await page.setOperatorVisible(visible);
  }
  async start():Promise<BackgroundWebComputer>{
    if(this.lease||this.pipe||this.busy)throw Error('CHROME_SUPERVISOR_BUSY');
    this.busy=true;
    let lease:ProfileLease|null=null;
    try{
      lease=await ProfileLease.acquire(this.profilePath);
      // A real Chrome may own this profile without knowing our app lock.
      // Never attach to, terminate or steal it.
      if(await fs.lstat(path.join(this.profilePath,'SingletonLock'))
        .then(()=>true,()=>false))throw Error('CHROME_PROFILE_OWNED_BY_OTHER_CHROME');
      const pipe=await ChromePipe.launch(this.profilePath,CHROME);
      this.pipe=pipe;this.lease=lease;
      const page=await pipe.createPage();
      const computer=makeChromeComputer(page);
      this.pages.set(computer,page);this.computer=computer;
      return computer;
    }catch(e){
      await this.pipe?.close().catch(()=>undefined);
      this.pipe=null;this.lease=null;this.pages.clear();this.computer=null;
      if(lease)await lease.release();
      throw e;
    }finally{this.busy=false;}
  }
  async createPage():Promise<BackgroundWebComputer>{
    if(!this.running||!this.pipe)throw Error('CHROME_SUPERVISOR_NOT_STARTED');
    if(this.pages.size>=16)throw Error('CHROME_SUPERVISOR_PAGE_LIMIT');
    const page=await this.pipe.createPage();
    const computer=makeChromeComputer(page);
    this.pages.set(computer,page);
    return computer;
  }
  async closePage(computer:BackgroundWebComputer):Promise<void>{
    const page=this.pages.get(computer);
    if(!page)throw Error('CHROME_SUPERVISOR_FOREIGN_PAGE');
    this.pages.delete(computer);
    if(this.computer===computer)this.computer=null;
    await this.pipe?.closePage(page);
  }
  async stop():Promise<void>{
    if(this.busy)throw Error('CHROME_SUPERVISOR_BUSY');
    if(!this.lease)return;
    this.busy=true;
    const lease=this.lease;
    try{
      const pipe=this.pipe;
      for(const page of [...this.pages.values()])
        await pipe?.closePage(page).catch(()=>undefined);
      this.pages.clear();this.computer=null;
      await pipe?.close();
      this.pipe=null;
      await lease.release();
      this.lease=null;
    }finally{this.busy=false;}
  }
}
export const STANDARD_CHROME_BINARY=CHROME;
