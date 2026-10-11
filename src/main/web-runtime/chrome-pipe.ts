/** Standard Google Chrome CDP PIPE transport. No extension, TCP debug port,
 * shell command from model, or copied Chrome credentials. Owns only its child.
 * Chrome 136+ requires an isolated non-default --user-data-dir.
 */
import {spawn,type ChildProcess} from 'node:child_process';
import type {Readable,Writable} from 'node:stream';
import {StringDecoder} from 'node:string_decoder';
import {currentSystemChromeProxyArgs} from './chrome-proxy.js';

type Pending={resolve:(value:Record<string,unknown>)=>void;
  reject:(reason:Error)=>void; timer:ReturnType<typeof setTimeout>};
type Message={id?:number;sessionId?:string;method?:string;
  params?:Record<string,unknown>;result?:Record<string,unknown>;
  error?:{message?:string;code?:number}};
const MAX_FRAME=8_000_000;
let nextPageId=40_000;

export class ChromePipe {
  private sequence=0;
  private input='';
  private readonly decoder=new StringDecoder('utf8');
  private exited=false;
  private pending=new Map<number,Pending>();
  private closed=false;
  private readonly pages=new Map<string,ChromePipePage>();
  private constructor(private readonly child:ChildProcess,
    private readonly writer:Writable,reader:Readable){
    reader.on('data',(data:Buffer)=>this.receive(data));
    reader.on('error',()=>this.fail(Error('CHROME_PIPE_READ_FAILED')));
    writer.on('error',()=>this.fail(Error('CHROME_PIPE_WRITE_FAILED')));
    child.stderr?.resume(); // Drain diagnostics, do not log browsing data.
    child.once('exit',()=>{this.exited=true;this.fail(Error('CHROME_PIPE_PROCESS_EXITED'));});
    child.once('error',()=>this.fail(Error('CHROME_PIPE_PROCESS_ERROR')));
  }
  static async launch(profile:string,chromeBinary:string):Promise<ChromePipe>{
    // Real ChatGPT's ordinary site currently returns HTTP 403 in
    // --headless=new but HTTP 200 in unmodified standard Chrome with
    // the same CDP Pipe and network proxy. Use normal Chrome offscreen;
    // never spoof a browser identity or bypass website security controls.
    // On macOS a headful, non-activated, offscreen Chrome process retains
    // normal DOM/network behavior without OS mouse or keyboard injection.
    const child=spawn(chromeBinary,[
      '--no-first-run','--no-default-browser-check',
      '--window-position=-20000,-20000','--window-size=960,720',
      '--disable-background-mode',...currentSystemChromeProxyArgs(),
      '--remote-debugging-pipe',
      '--user-data-dir='+profile,'about:blank'
    ],{stdio:['ignore','ignore','pipe','pipe','pipe'],detached:false,
      env:{...process.env,NODE_OPTIONS:''}});
    const writer=child.stdio[3] as Writable;
    const reader=child.stdio[4] as Readable;
    if(!writer||!reader)throw Error('CHROME_PIPE_FDS_UNAVAILABLE');
    const pipe=new ChromePipe(child,writer,reader);
    try{
      const result=await pipe.call('Browser.getVersion',{},undefined,12000);
      if(typeof result.product!=='string'||!result.product.startsWith('Chrome/'))
        throw Error('CHROME_PIPE_NOT_STANDARD_CHROME');
      return pipe;
    }catch(e){await pipe.close();throw e;}
  }
  get alive(){return !this.closed&&!this.exited;}
  private receive(chunk:Buffer):void{
    if(this.closed)return;
    this.input+=this.decoder.write(chunk);
    if(this.input.length>MAX_FRAME){this.fail(Error('CHROME_PIPE_FRAME_TOO_LARGE'));return;}
    let split:number;
    while((split=this.input.indexOf('\0'))>=0){
      const raw=this.input.slice(0,split);
      this.input=this.input.slice(split+1);
      if(!raw)continue;
      let message:Message;
      try{message=JSON.parse(raw) as Message;}
      catch{this.fail(Error('CHROME_PIPE_INVALID_JSON'));return;}
      if(typeof message.id==='number'){
        const p=this.pending.get(message.id);
        if(!p)continue;
        this.pending.delete(message.id);clearTimeout(p.timer);
        if(message.error)p.reject(Error('CHROME_CDP_'+String(message.error.code??'ERR')+
          ': '+String(message.error.message??'unknown')));
        else p.resolve(message.result??{});
      }else if(message.method==='Network.responseReceived'&&message.sessionId){
        // Metadata only: never collect bodies, cookies or request headers.
        const response=message.params?.response as {status?:number}|undefined;
        const status=response?.status;
        if(message.params?.type==='Document'&&typeof status==='number'&&
          Number.isFinite(status)){
          for(const page of this.pages.values())
            if(page.sessionId===message.sessionId)page.noteDocumentStatus(status);
        }
      }else if(message.sessionId&&(
        message.method==='Page.frameNavigated'||
        message.method==='Page.navigatedWithinDocument')){
        // ChatGPT SPA conversations often change / -> /c/<id> via the
        // History API without a main-frame reload. Observe BOTH CDP events.
        const frame=message.params?.frame as {parentId?:string;url?:string}|undefined;
        const url=message.method==='Page.navigatedWithinDocument'?
          message.params?.url:frame&&!frame.parentId?frame.url:undefined;
        if(typeof url==='string'){
          for(const page of this.pages.values())
            if(page.sessionId===message.sessionId)page.noteUrl(url);
        }
      }
    }
  }
  private fail(error:Error):void{
    if(this.closed)return;
    this.closed=true;
    for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error);}
    this.pending.clear();this.pages.clear();
  }
  call(method:string,params:Record<string,unknown>={},
    sessionId?:string,timeoutMs=10000):Promise<Record<string,unknown>>{
    if(!this.alive)return Promise.reject(Error('CHROME_PIPE_CLOSED'));
    if(this.pending.size>=100)return Promise.reject(Error('CHROME_PIPE_PENDING_LIMIT'));
    return new Promise((resolve,reject)=>{
      const id=++this.sequence;
      const timer=setTimeout(()=>{
        this.pending.delete(id);reject(Error('CHROME_CDP_TIMEOUT: '+method));
      },timeoutMs);
      this.pending.set(id,{resolve,reject,timer});
      const message={id,method,params,...(sessionId?{sessionId}:{})};
      try{this.writer.write(JSON.stringify(message)+'\0');}
      catch(e){clearTimeout(timer);this.pending.delete(id);reject(e);}
    });
  }
  async createPage():Promise<ChromePipePage>{
    const created=await this.call('Target.createTarget',{url:'about:blank'});
    const targetId=created.targetId;
    if(typeof targetId!=='string')throw Error('CHROME_TARGET_MISSING');
    try{
      const attached=await this.call('Target.attachToTarget',{targetId,flatten:true});
      if(typeof attached.sessionId!=='string')throw Error('CHROME_SESSION_MISSING');
      const page=new ChromePipePage(this,targetId,attached.sessionId,++nextPageId);
      await page.command('Page.enable');
      await page.command('Network.enable');
      await page.command('Runtime.enable');
      this.pages.set(targetId,page);
      return page;
    }catch(e){
      await this.call('Target.closeTarget',{targetId}).catch(()=>undefined);
      throw e;
    }
  }
  async closePage(page:ChromePipePage):Promise<void>{
    if(this.pages.get(page.targetId)!==page)throw Error('CHROME_PAGE_FOREIGN');
    this.pages.delete(page.targetId);
    page.retire();
    if(this.alive)await this.call('Target.closeTarget',{targetId:page.targetId})
      .catch(()=>undefined);
  }
  async close():Promise<void>{
    if(this.exited){this.fail(Error('CHROME_PIPE_SHUTDOWN'));return;}
    const exited=new Promise<void>(resolve=>this.child.once('exit',()=>resolve()));
    // Chrome can tear down the transport before acknowledging Browser.close.
    if(!this.closed)await this.call('Browser.close',{},undefined,2000)
      .catch(()=>undefined);
    // Allow Chrome to finish its own profile/singleton cleanup before using
    // the child-only termination fallback. Immediate SIGTERM leaves a stale
    // SingletonLock on macOS and breaks the next login/work handoff.
    await Promise.race([exited,new Promise<void>(resolve=>setTimeout(resolve,3000))]);
    if(!this.exited)this.child.kill('SIGTERM');
    await Promise.race([exited,new Promise<void>(resolve=>setTimeout(resolve,6000))]);
    if(!this.exited)throw Error('CHROME_PROCESS_STILL_OWNS_PROFILE');
    this.fail(Error('CHROME_PIPE_SHUTDOWN'));
  }
}
export class ChromePipePage {
  private currentUrl='about:blank';
  private documentStatus:number|null=null;
  private disposed=false;
  readonly debugger:{
    attach:(_version?:string)=>void;detach:()=>void;isAttached:()=>boolean;
    sendCommand:(method:string,params?:Record<string,unknown>)=>Promise<Record<string,unknown>>
  };
  constructor(private readonly pipe:ChromePipe,readonly targetId:string,
    readonly sessionId:string,readonly id:number){
    // Shape compatible with the small CDP-facing subset of Electron WebContents.
    // attach/detach do not affect ownership of the dedicated Chrome target.
    this.debugger={
      attach:()=>this.requireAlive(),detach:()=>undefined,
      isAttached:()=>!this.disposed&&this.pipe.alive,
      sendCommand:(method,params={})=>this.command(method,params)
    };
  }
  private requireAlive(){if(this.disposed||!this.pipe.alive)throw Error('CHROME_PAGE_CLOSED');}
  retire(){this.disposed=true;}
  isDestroyed():boolean{return this.disposed||!this.pipe.alive;}
  /** Operator-invoked visibility change for an official website security
   * checkpoint. Reuses THIS Chrome child/Profile; never restarts Chrome,
   * copies cookies or enters CAPTCHA on the user's behalf.
   */
  async setOperatorVisible(visible:boolean):Promise<void>{
    this.requireAlive();
    const lookup=await this.pipe.call('Browser.getWindowForTarget',{
      targetId:this.targetId});
    if(!Number.isSafeInteger(lookup.windowId))
      throw Error('CHROME_WINDOW_ID_UNAVAILABLE');
    await this.pipe.call('Browser.setWindowBounds',{
      windowId:lookup.windowId,
      bounds:{left:visible?100:-20000,top:visible?90:-20000,
        width:960,height:720,windowState:'normal'}
    });
  }
  noteUrl(url:string){this.currentUrl=url;}
  noteDocumentStatus(status:number){this.documentStatus=status;}
  documentHttpStatus():number|null{return this.documentStatus;}
  getURL():string{return this.currentUrl;}
  async command(method:string,params:Record<string,unknown>={}){
    this.requireAlive();return this.pipe.call(method,params,this.sessionId);
  }
  async executeJavaScript(source:string,_userGesture=false):Promise<unknown>{
    this.requireAlive();
    if(source.length>150_000)throw Error('CHROME_EVALUATE_TOO_LARGE');
    const result=await this.command('Runtime.evaluate',{
      expression:source,awaitPromise:true,returnByValue:true,
      userGesture:_userGesture,timeout:10000});
    if(result.exceptionDetails)throw Error('CHROME_PAGE_JAVASCRIPT_FAILED');
    const remote=result.result as {value?:unknown;type?:string}|undefined;
    return remote?.value;
  }
  async navigate(url:string):Promise<void>{
    this.requireAlive();
    const result=await this.command('Page.navigate',{url});
    if(result.errorText)throw Error('CHROME_NAVIGATION_FAILED');
    // Do not report a loaded URL from Page.navigate acceptance alone.
    const deadline=Date.now()+12000;
    while(Date.now()<deadline){
      const got=await this.executeJavaScript('location.href').catch(()=>undefined);
      if(typeof got==='string'&&got!=='about:blank'){
        this.currentUrl=got;
        if(got===url||got.startsWith('https://chatgpt.com/'))return;
        throw Error('CHROME_NAVIGATION_REDIRECTED');
      }
      await new Promise(resolve=>setTimeout(resolve,180));
    }
    throw Error('CHROME_NAVIGATION_TIMEOUT');
  }
}
