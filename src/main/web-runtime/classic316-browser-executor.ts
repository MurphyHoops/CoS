/**
 * Native Chrome-extension-free transport for the ORIGINAL CoS v3.1.16
 * browser tool broker. Uses EXACT legacy browserPage DOM engine from 3.1.16,
 * against ONE CoS-owned hidden Chromium page. An incomplete adapter must
 * refuse unsupported tools, not pretend they succeeded.
 *
 * This is a transport adapter, not a second Goal / Agent / MCP authority.
 */
import {randomUUID} from 'node:crypto';
import type {BrowserCommand,BrowserResult} from '../../shared/browser-control.js';
import type {NativeBrowserControlExecutor} from '../browser-control.js';
import type {BackgroundWebComputer} from './browser-driver-electron.js';
import {browserPage,boundedBrowserValue} from './vendor/classic316-browser-page.js';

const validateUrl=(url:string):boolean=>{
  try{const u=new URL(url);return u.protocol==='https:'&&u.hostname==='chatgpt.com'&&
    !u.username&&!u.password&&!u.port;}
  catch{return false;}
};
type PageResult=Record<string,unknown>;
export class NativeClassic316BrowserExecutor implements NativeBrowserControlExecutor {
  readonly id=randomUUID();
  readonly name='CoS Native ChatGPT Website (no Chrome extension)';
  private owner:string|null=null;
  private pageId=randomUUID();
  private readonly tabId=1;
  private busy=false;
  private opened=false;
  private screenshotId:string|null=null;
  private readonly lease=randomUUID();
  constructor(private readonly computer:BackgroundWebComputer,
    private readonly offlineFixture=false){}
  private handle(){return this.id+':'+this.tabId;}
  private url(){return this.computer.webContents.getURL();}
  private async current(command:BrowserCommand,check:()=>Promise<boolean>,
    requireOwnership=true):Promise<void>{
    if(!await check())throw Error('BROWSER_NATIVE_AUTH_REVOKED');
    if(command.expiresAt<=Date.now())throw Error('BROWSER_NATIVE_COMMAND_EXPIRED');
    if(requireOwnership&&(!this.owner||this.owner!==command.owner||
      command.args.tabId!==this.tabId))throw Error('BROWSER_NATIVE_TAB_NOT_OWNED');
    if(!this.opened||!(validateUrl(this.url())||
      this.offlineFixture&&this.url().startsWith('data:text/html,')))
      throw Error('BROWSER_NATIVE_CHATGPT_PAGE_REQUIRED');
    if(command.args.pageId&&command.args.pageId!==this.pageId)
      throw Error('BROWSER_PAGE_STALE: inspect again.');
    if(command.args.frameId&&command.args.frameId!=='top')
      throw Error('BROWSER_NATIVE_FRAME_UNSUPPORTED');
  }
  private async page(action:string,args:Record<string,unknown>):Promise<PageResult>{
    const expression='('+browserPage.toString()+')('+
      JSON.stringify(action)+','+
      JSON.stringify({...args,pageId:this.pageId,frameId:'top',lease:this.lease})+')';
    const value:unknown=await this.computer.webContents.executeJavaScript(expression,true);
    if(!value||typeof value!=='object')throw Error('BROWSER_NATIVE_DOM_INVALID');
    return value as PageResult;
  }
  private async executeCommand(command:BrowserCommand,check:()=>Promise<boolean>):
    Promise<BrowserResult>{
    const {tool,args}=command;
    if(tool==='browser_tabs'){
      const action=args.action;
      if(action==='list'){
        if(!await check())throw Error('BROWSER_NATIVE_AUTH_REVOKED');
        const item=this.opened&&(validateUrl(this.url())||
          this.offlineFixture&&this.url().startsWith('data:text/html,'))?{
          tabId:this.handle(),url:this.url(),title:'CoS-owned ChatGPT page',
          active:false,pinned:false,owned:this.owner===command.owner,
          claimed:!!this.owner,protected:false}:null;
        return {value:{browserId:this.id,tabs:item?[item]:[],total:item?1:0,
          truncated:false,nextOffset:null}};
      }
      if(action==='new'){
        if(this.opened||this.owner)throw Error('BROWSER_NATIVE_PAGE_ALREADY_EXISTS');
        const target=typeof args.url==='string'?args.url:'https://chatgpt.com/';
        if(!(validateUrl(target)||
          this.offlineFixture&&target.startsWith('data:text/html,')))
          throw Error('BROWSER_NATIVE_URL_NOT_PERMITTED');
        if(!await check())throw Error('BROWSER_NATIVE_AUTH_REVOKED');
        // A loadURL may have side effects. If it throws, don't recreate it
        // within this command; an unknown route remains a held state.
        this.owner=command.owner;this.opened=true;
        await this.computer.open(target);
        this.pageId=randomUUID();
        return {value:{tabId:this.handle(),attached:true,navigationRequested:target,
          message:'CoS-owned background page created; snapshot to inspect.'}};
      }
      if(!await check())throw Error('BROWSER_NATIVE_AUTH_REVOKED');
      if(args.tabId!==this.tabId||!this.opened)throw Error('BROWSER_NATIVE_TAB_UNKNOWN');
      if(action==='attach'){
        if(this.owner&&this.owner!==command.owner)
          throw Error('BROWSER_NATIVE_TAB_OWNED');
        this.owner=command.owner;
        return {value:{tabId:this.handle(),pageId:this.pageId,url:this.url(),attached:true}};
      }
      if(this.owner!==command.owner)throw Error('BROWSER_NATIVE_TAB_OWNED');
      if(action==='release'){
        this.owner=null;
        return {value:{tabId:this.handle(),released:true}};
      }
      if(action==='close')throw Error('BROWSER_NATIVE_CLOSE_REQUIRES_SUPERVISOR');
      throw Error('BROWSER_NATIVE_TABS_ACTION_UNKNOWN');
    }
    await this.current(command,check);
    if(tool==='browser_snapshot'){
      const url=this.url();
      const result=await this.page('snapshot',args);
      if(this.url()!==url)throw Error('BROWSER_NATIVE_NAVIGATION_RACE');
      const {refs:_,...values}=result;
      return {value:{...values,tabId:this.handle(),pageId:this.pageId,
        frameId:'top',frames:[{frameId:'top',url}],dialog:null}};
    }
    if(tool==='browser_screenshot'){
      const png=await this.computer.screenshot();
      if(!await check())throw Error('BROWSER_NATIVE_AUTH_REVOKED');
      if(png.length>1_200_000)throw Error('BROWSER_NATIVE_IMAGE_TOO_LARGE');
      this.screenshotId=randomUUID();
      return {value:{tabId:this.handle(),pageId:this.pageId,screenshotId:this.screenshotId,
        fullPage:false,scale:1,width:1030,height:770},
        image:{data:png.toString('base64'),mimeType:'image/png'}};
    }
    if(tool==='browser_navigate'){
      if(args.action!=='url'||typeof args.url!=='string'||
        !(validateUrl(args.url)||this.offlineFixture&&args.url.startsWith('data:text/html,')))
        throw Error('BROWSER_NATIVE_NAVIGATION_NOT_PERMITTED');
      if(!await check())throw Error('BROWSER_NATIVE_AUTH_REVOKED');
      // Navigation itself may complete after a timeout; identity invalidated
      // before the first navigation side effect.
      this.pageId=randomUUID();this.screenshotId=null;
      await this.computer.open(args.url);
      return {value:{tabId:this.handle(),accepted:true,message:'Navigation requested; snapshot again.'}};
    }
    if(tool==='browser_action'){
      if(!await check())throw Error('BROWSER_NATIVE_AUTH_REVOKED');
      const action=args.action;
      if(action==='click'&&typeof args.ref==='string'){
        if(!args.ref.startsWith(this.pageId+':'))throw Error('BROWSER_REF_STALE');
        const before=this.url();
        const point=await this.page('point',{ref:args.ref});
        if(this.url()!==before||!await check())throw Error('BROWSER_NATIVE_NAVIGATION_RACE');
        await this.computer.action({kind:'click',x:Number(point.x),y:Number(point.y)});
        return {value:{action:'click',accepted:true}};
      }
      if(action==='fill'||action==='type'){
        if(typeof args.ref!=='string'||!args.ref.startsWith(this.pageId+':')||
          typeof args.text!=='string'||args.text.length>2000)
          throw Error('BROWSER_NATIVE_TEXT_TARGET_INVALID');
        await this.page('focus',{ref:args.ref,replace:action==='fill'});
        if(!await check())throw Error('BROWSER_NATIVE_AUTH_REVOKED');
        await this.computer.action({kind:'type',text:args.text});
        return {value:{action,accepted:true}};
      }
      if(action==='key'&&['Enter','Escape','Tab'].includes(String(args.key))){
        if(!await check())throw Error('BROWSER_NATIVE_AUTH_REVOKED');
        await this.computer.action({kind:'key',key:args.key as 'Enter'|'Escape'|'Tab'});
        return {value:{action:'key',accepted:true}};
      }
      if(action==='scroll'){
        const x=Number(args.x),y=Number(args.y),deltaY=Number(args.deltaY);
        if(args.screenshotId!==this.screenshotId||!Number.isFinite(x)||
          !Number.isFinite(y)||!Number.isFinite(deltaY)||Math.abs(deltaY)>1500)
          throw Error('BROWSER_NATIVE_SCREENSHOT_STALE');
        await this.computer.action({kind:'scroll',x,y,deltaY});
        return {value:{action:'scroll',accepted:true}};
      }
      throw Error('BROWSER_NATIVE_ACTION_NOT_YET_SUPPORTED');
    }
    if(tool==='browser_evaluate'){
      if(typeof args.expression!=='string'||args.expression.length>24000)
        throw Error('BROWSER_NATIVE_EXPRESSION_INVALID');
      if(!await check())throw Error('BROWSER_NATIVE_AUTH_REVOKED');
      const before=this.url();
      const js='(async()=>{const output=await ('+args.expression+
        ');return ('+boundedBrowserValue.toString()+')(output);})()';
      const value:unknown=await this.computer.webContents.executeJavaScript(js,true);
      if(this.url()!==before)throw Error('BROWSER_NATIVE_NAVIGATION_RACE');
      this.screenshotId=null;
      return {value:{tabId:this.handle(),pageId:this.pageId,...(value as object)}};
    }
    return {error:'BROWSER_NATIVE_TOOL_NOT_YET_SUPPORTED: '+tool};
  }
  async execute(command:BrowserCommand,check:()=>Promise<boolean>):Promise<BrowserResult>{
    if(this.busy)return {error:'BROWSER_NATIVE_BUSY: command not dispatched'};
    this.busy=true;
    try{return await this.executeCommand(command,check);}
    catch(e){return {error:e instanceof Error?e.message.slice(0,420):'BROWSER_NATIVE_UNKNOWN'};}
    finally{this.busy=false;}
  }
}
