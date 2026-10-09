/**
 * Electron-owned ChatGPT web surface, not a Chrome extension or an inference API.
 * P1 deliberately presents the real site; it neither inspects replies nor drives
 * the ChatGPT composer. P2 must use separately authenticated, approved MCP tools.
 */
import {
  BrowserWindow, Menu, WebContentsView, session, dialog, type WebContents,
  type MenuItemConstructorOptions
} from 'electron';
import {
  CHATGPT_START_URL, WEB_FIRST_PARTITION, isAllowedWebFirstNavigation,
  classifyWebFirstNavigation
} from './host-policy.js';
import {newWebHealthTracker,safeApiRouteClass,classifyRequest,type WebHealthSnapshot} from './web-health.js';
import {WebFirstHealthLedger,type NativeHealthKind,type NativeHealthRoute} from './health-ledger.js';
import {WebFirstRateLimitSupervisor} from './rate-limit-supervisor.js';
import {PageRecoveryGate,type SafePageProbe} from './page-recovery.js';
import {allowedOAuthStoragePermission,allowedOAuthPopup} from './login-permissions.js';
import {WebFirstProjectRegistry, type WebFirstProject} from './project-registry.js';
import {renderProjectSidebar} from './project-sidebar.js';
import {renderWorkspaceHeader} from './workspace-header.js';
import {WebFirstReadAuthority, type ReadAction, type NativeReadApproval} from './project-read.js';
import {WebFirstReadGrants,isSensitiveProjectPath} from './read-grants.js';
import {WebFirstOperationJournal} from './operation-journal.js';
import {WebFirstProjectWriter} from './project-write.js';
import {WebFirstTaskLedger} from './task-ledger.js';
import {WebFirstTaskTools} from './task-tools.js';
import {WebFirstPlanLedger} from './plan-ledger.js';
import {WebFirstLocalJobQueue} from './local-job-queue.js';
import {WebFirstPlanTools} from './plan-tools.js';
import {renderGoalWorkbench,parseWorkbenchAction,parsePlanLines,completePlanStep} from './goal-workbench.js';
import {conversationFromUrl,VISIBLE_REPLY_SCRIPT,WebReplySettleTracker,WebFirstReplyJournal,type VisibleWebReply} from './web-reply-observer.js';
import {WebFirstWebOutbox} from './web-outbox.js';
import {sendNativeWebFirstMessage} from './native-web-input.js';
import {randomUUID} from 'node:crypto';
import {createContinuityLease,assessContinuity,type ContinuityLease} from './continuity-gate.js';
import {createWebFirstCoreLoopback} from './core-loopback.js';
import {readWebFirstLocalToolList,EXPECTED_READ_ONLY_CORE_TOOLS} from './core-catalogue.js';
import {connectWebFirstImportedCore,existingTunnelOwnerPresent,coreRecoveryDecision,type CoreTunnelState} from './core-transport.js';

export interface NativeWebHostStatus {
  state: 'starting' | 'loaded' | 'load-failed';
  location: 'chatgpt' | 'login' | 'blocked' | 'offline-test';
  lastErrorCode: number | null;
  blockedNavigations: number;
}
export interface NativeWebHost {
  window: BrowserWindow;
  status: () => Readonly<NativeWebHostStatus>;
  reload: () => void;
  diagnostics: () => Promise<WebHealthSnapshot>;
  nativeProjects: () => Promise<ReadonlyArray<WebFirstProject>>;
  enableNativeCore: () => Promise<{endpointUrl:string;port:number}>;
  disableNativeCore: () => Promise<void>;
  getCorePosture:()=>string;
  snapshotVisibleAssistant:()=>Promise<VisibleWebReply|null>;
  testRecoveryOverlayOffline?:()=>Promise<boolean>;
  testGoalWorkbenchOffline?:()=>Promise<boolean>;
}
export function launchNextWebFirstHost(options: {
  /** Only a fixture launch may use data URLs; the production path is fixed. */
  offlineSmoke?: boolean;
  /** Entirely native and isolated from the ChatGPT partition. */
  projectStoreDir:string;
  appDataDir:string;
  onOfflineLoaded?: (contents:WebContents) => void;
  /** HTTPS P1 smoke emits status categories only; never page content/cookies. */
  onNavigationOutcome?: (state: Readonly<NativeWebHostStatus>) => void;
}): NativeWebHost {
  const offline = options.offlineSmoke === true;
  const health=newWebHealthTracker();
  const healthLedger=new WebFirstHealthLedger(options.projectStoreDir);
  const throttle=new WebFirstRateLimitSupervisor(options.projectStoreDir);
  const healthReceipt=(kind:NativeHealthKind,route:NativeHealthRoute,
    status:number|null=null,code:number|null=null)=>{
    if(offline)return;
    void healthLedger.record({kind,route,status,code}).catch(()=>{
      // Diagnostic journal is non-authoritative; corruption never grants
      // privileges or triggers a browser reload or model send.
    });
  };
  healthReceipt('app-started','not-applicable');
  const pageRecovery=new PageRecoveryGate();
  pageRecovery.navigate(Date.now());
  const webSession = session.fromPartition(WEB_FIRST_PARTITION);
  // No general device, file, clipboard or camera permission is inherited.
  // Chromium's Storage Access API may be essential for OAuth/Google SSO after
  // redirect; allow ONLY the explicitly pinned HTTPS identity origins.
  webSession.setPermissionRequestHandler((_wc,permission,done,details)=>{
    let origin='';
    try{origin=new URL(details.requestingUrl||'about:blank').origin;}catch{/* deny malformed */}
    done(allowedOAuthStoragePermission(permission,origin));
  });
  webSession.setPermissionCheckHandler((_wc,permission,origin,details)=>
    allowedOAuthStoragePermission(permission,origin,details?.embeddingOrigin));
  webSession.on('will-download', event => event.preventDefault());
  webSession.webRequest.onCompleted(details=>{
    if(details.webContentsId)health.completed(details.url,details.statusCode);
    if(details.webContentsId!==view.webContents.id)return;
    if(details.resourceType==='mainFrame'){
      pageRecovery.httpStatus(details.statusCode);
      if(details.statusCode>=400)healthReceipt('main-frame-http-error',
        'chatgpt-main',details.statusCode);
    }else if(details.statusCode===429){
      const route=safeApiRouteClass(details.url);
      if(route==='conversation-list'){
        // A history-list 429 is not proof of model inference exhaustion.
        healthReceipt('api-rate-limited','conversation-list',429);
        void throttle.history429().catch(()=>undefined);
      }else if(classifyRequest(details.url)==='chatgpt-api'&&
        route!=='auth'&&route!=='profile'){
        // Unknown ChatGPT API limit: don't infer a particular model quota.
        // Hold optional native follow-ups pending cooldown and human review.
        healthReceipt('api-rate-limited','other-api',429);
        void throttle.backend429().catch(()=>undefined);
      }
    }
  });
  webSession.webRequest.onErrorOccurred(details=>{if(details.webContentsId)health.failed(details.url,details.error);});
  const owner = new BrowserWindow({
    title: 'CoS Next · ChatGPT Web-First Preview',
    width: 1210, height: 820, minWidth: 850, minHeight: 530,
    center: true, backgroundColor: '#121820', show: false,
    webPreferences: {nodeIntegration: false,contextIsolation: true,sandbox: true,webSecurity: true,
      webviewTag: false, javascript: false}
  });
  const view = new WebContentsView({ webPreferences: {
    session: webSession, nodeIntegration:false,contextIsolation:true,sandbox:true,
    webSecurity:true,webviewTag:false
  }});
  const status: NativeWebHostStatus = {
    state:'starting',location: offline ? 'offline-test':'chatgpt',
    lastErrorCode:null,blockedNavigations:0
  };
  // A failed ChatGPT page must not leave the user with an unexplained white
  // WebContentsView. The overlay is separate, no JS, no site privileges.
  let recoveryOverlay:WebContentsView|null=null;
  const showRecoveryOverlay=()=>{
    if(owner.isDestroyed())return;
    const message=pageRecovery.fallbackMessage();
    if(!message)return;
    if(!recoveryOverlay){
      recoveryOverlay=new WebContentsView({webPreferences:{nodeIntegration:false,
        contextIsolation:true,sandbox:true,webSecurity:true,javascript:false,webviewTag:false}});
      recoveryOverlay.webContents.setWindowOpenHandler(()=>({action:'deny'}));
      recoveryOverlay.webContents.on('will-navigate',e=>e.preventDefault());
      owner.contentView.addChildView(recoveryOverlay);
    }
    const encode=(value:string)=>value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;',
      '>':'&gt;','"':'&quot;',"'":'&#39;'}[c]??''));
    const body='<!doctype html><html lang="zh"><meta charset="utf-8"><style>'+
      'body{margin:0;background:#f8fafc;color:#172033;font:15px system-ui;padding:42px 50px}'+
      'h1{font-size:21px}p{max-width:610px;line-height:1.8}small{color:#55667d}'+
      '</style><h1>'+encode(message.title)+'</h1><p>'+encode(message.detail)+'</p>'+
      '<p><small>请使用顶部「ChatGPT 网页 → 安全重新加载网页」；不会删除 ChatGPT 登录或本地项目。</small></p></html>';
    void recoveryOverlay.webContents.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(body));
    const [w=1,h=1]=owner.getContentSize();const x=sidebarVisible?268:0;
    recoveryOverlay.setBounds({x,y:48,width:Math.max(1,w-x),height:Math.max(1,h-48)});
  };
  const hideRecoveryOverlay=()=>{
    if(!recoveryOverlay)return;
    owner.contentView.removeChildView(recoveryOverlay);
    if(!recoveryOverlay.webContents.isDestroyed())recoveryOverlay.webContents.close();
    recoveryOverlay=null;
  };

  // The project sidecar runs in a completely separate renderer WITHOUT preload,
  // JavaScript, network access, native IPC or access to the ChatGPT partition.
  const sidebar = new WebContentsView({webPreferences:{
    nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,
    webviewTag:false,javascript:false
  }});
  sidebar.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  sidebar.webContents.on('will-navigate',event=>event.preventDefault());
  sidebar.webContents.on('will-attach-webview',event=>event.preventDefault());
  owner.contentView.addChildView(sidebar);
  owner.contentView.addChildView(view);
  const projects=new WebFirstProjectRegistry(options.projectStoreDir);
  const grants=new WebFirstReadGrants(options.projectStoreDir);
  const journal=new WebFirstOperationJournal(options.projectStoreDir);
  const writeAuthority=new WebFirstProjectWriter(projects,async changes=>{
    if(offline)return true;
    if(owner.isDestroyed())return false;
    const decision=await dialog.showMessageBox(owner,{
      type:'warning',title:'CoS Next · 单次代码修改批准',
      message:'允许修改项目 '+changes.projectName+' 内的一个文件吗？',
      detail:'文件：'+changes.relativePath+'\n'
        +'原始片段：\n'+changes.before+'\n\n替换为：\n'+changes.after+'\n\n'
        +'仅此一次批准，不继承永久只读授权；不会执行终端或提交 Git。',
      buttons:['拒绝','仅批准本次修改'],defaultId:0,cancelId:0,noLink:true
    });
    return !owner.isDestroyed()&&decision.response===1;
  });

  const taskLedger=new WebFirstTaskLedger(options.projectStoreDir);
  const planLedger=new WebFirstPlanLedger(options.projectStoreDir,taskLedger);
  const localJobs=new WebFirstLocalJobQueue(options.projectStoreDir,taskLedger,planLedger,
    async request=>{
      if(offline)return true; // Synthetic packaged fixture has no real project.
      if(owner.isDestroyed())return false;
      const approved=await dialog.showMessageBox(owner,{
        type:'question',title:'批准一次本地只读检查',
        message:request.kind==='root-check'?'检查项目目录是否仍是原目录？':'检查项目的 Git 工作区状态？',
        detail:'目标：'+request.goal.slice(0,360)+'\n\n'+
          '仅允许这一次固定的只读检查；不会执行用户提供的任意命令、修改文件、发送网页消息或推进模型。'+
          '\n检查结果只保留退出状态、变更数量及 SHA-256，不保存文件名或文件内容。',
        buttons:['取消','仅批准本次检查'],defaultId:0,cancelId:0,noLink:true
      });
      return !owner.isDestroyed()&&approved.response===1;
    });
  const webReplies=new WebFirstReplyJournal(options.projectStoreDir);
  const webOutbox=new WebFirstWebOutbox(options.projectStoreDir);
  const replyTracker=new WebReplySettleTracker();
  let recordingChat:string|null=null;
  let replyTimer:NodeJS.Timeout|null=null;
  let replyBusy=false;
  async function snapshotVisibleAssistant():Promise<VisibleWebReply|null>{
    if(view.webContents.isDestroyed())return null;
    const conversationId=offline?'offline-synthetic':conversationFromUrl(view.webContents.getURL());
    if(!conversationId)return null;
    try{
      const data:unknown=await view.webContents.executeJavaScript(VISIBLE_REPLY_SCRIPT,true);
      if(!data||typeof data!=='object')return null;
      const result=data as {messageId?:unknown;text?:unknown;editorReady?:unknown;generating?:unknown};
      if(typeof result.text!=='string'||typeof result.messageId!=='string'||
        typeof result.editorReady!=='boolean'||typeof result.generating!=='boolean'||
        result.text.length>24576||result.messageId.length>256)return null;
      return {conversationId,messageId:result.messageId,text:result.text,
        editorReady:result.editorReady,generating:result.generating};
    }catch{return null;}
  }
  async function captureVisibleReply(){
    if(!recordingChat||replyBusy||owner.isDestroyed())return;
    replyBusy=true;
    try{
      const snapshot=await snapshotVisibleAssistant();
      if(!snapshot||snapshot.conversationId!==recordingChat){
        if(snapshot&&snapshot.conversationId!==recordingChat)stopReplyCapture();
        return;
      }
      const settled=replyTracker.observe(snapshot);
      if(settled)await webReplies.record(settled);
    }catch{/* local ledger failure does not mutate ChatGPT or retry a message */}
    finally{replyBusy=false;}
  }
  function stopReplyCapture(){
    recordingChat=null;replyTracker.reset();
    if(replyTimer){clearInterval(replyTimer);replyTimer=null;}
  }

  const taskTools=new WebFirstTaskTools(taskLedger,projects,async (_action,details)=>{
    if(offline)return true;
    if(owner.isDestroyed())return false;
    const approve=await dialog.showMessageBox(owner,{
      type:'question',title:'开始 Web-First 持久任务',
      message:'允许 ChatGPT 为 '+details.name+' 创建本地持久任务吗？',
      detail:'目标：'+details.goal+'\n\n这只是创建任务状态与检查点；不会自动发送网页消息、执行终端或写入文件。'
        +'身份归属尚未通过验证，请确认这是你请求的任务。',
      buttons:['取消','创建任务'],defaultId:0,cancelId:0,noLink:true
    });
    return !owner.isDestroyed()&&approve.response===1;
  });
  const planTools=new WebFirstPlanTools(planLedger,taskLedger,async (_action,details)=>{
    if(offline)return true;
    if(owner.isDestroyed())return false;
    const approve=await dialog.showMessageBox(owner,{
      type:'question',title:'批准 ChatGPT 更新本地计划',
      message:'允许更新任务计划（'+details.steps.length+' 个步骤）吗？',
      detail:details.goal.slice(0,300)+'\n\n'+
        details.steps.slice(0,12).map(st=>st.status+' · '+st.step).join('\n').slice(0,1700)+
        '\n\n只保存任务元数据；不授予文件修改、终端或自动 Loop 权限。',
      buttons:['拒绝','保存本次计划'],defaultId:0,cancelId:0,noLink:true
    });
    return !owner.isDestroyed()&&approve.response===1;
  });
  let approvals:Promise<unknown>=Promise.resolve();
  let mcpService:Awaited<ReturnType<typeof createWebFirstCoreLoopback>>|null=null;
  let mcpStartFlight:Promise<{endpointUrl:string;port:number}>|null=null;
  let mcpState:'UNCONNECTED'|'LOCAL_ONLY'|'REMOTE_CONNECTING'|'REMOTE_CONNECTED'|'HOLD'='UNCONNECTED';
  let coreTunnel:Awaited<ReturnType<typeof connectWebFirstImportedCore>>|null=null;
  let remoteConnectionFlight:Promise<void>|null=null;
  let recoverApproved=false;
  let recoverAttempts=0;
  let recoverDueAt=0;
  let lastConnectedAt=0;
  let recovering=false;

  let sidebarVisible=true;
  let closingForTunnelStop=false;
  let cachedProjects:ReadonlyArray<WebFirstProject>=[];
  const refreshSidebar=async()=>{
    let state:typeof mcpState=mcpState;
    let registryError=false;
    try{cachedProjects=await projects.list();}
    catch{registryError=true;cachedProjects=[];}
    let grantSummary={permanent:0,session:0,error:false};
    try{
      const info=await grants.inspect();
      grantSummary={permanent:info.persistent.length,session:info.session.length,error:false};
    }catch{grantSummary.error=true;}
    let goalSummary={total:0,active:0,waiting:0,error:false};
    try{const saved=await taskLedger.list();
      goalSummary={total:saved.length,active:saved.filter(t=>t.phase==='active').length,
        waiting:saved.filter(t=>['waiting','recovery-hold','paused','review'].includes(t.phase)).length,
        error:false};
    }catch{goalSummary.error=true;}
    if(closingForTunnelStop||owner.isDestroyed()||sidebar.webContents.isDestroyed())return;
    await sidebar.webContents.loadURL('data:text/html;charset=utf-8,'+
      encodeURIComponent(renderProjectSidebar(cachedProjects,state,registryError,
        grantSummary,goalSummary)));
    // Reuse the existing, JavaScript-disabled BrowserWindow toolbar rather than
    // creating an extra privileged UI surface or Electron renderer process.
    if(!owner.isDestroyed()){
      await owner.loadURL('data:text/html;charset=utf-8,'+
        encodeURIComponent(renderWorkspaceHeader(state))).catch(()=>undefined);
    }
  };
  const headerHeight = 48;
  const sidebarWidth=268;
  const resize = () => {
    if (owner.isDestroyed()) return;
    const size = owner.getContentSize();
    const w=size[0]??1, h=size[1]??1, x=sidebarVisible?sidebarWidth:0;
    sidebar.setBounds({x:0,y:headerHeight,width:sidebarVisible?sidebarWidth:0,height:Math.max(1,h-headerHeight)});
    view.setBounds({x,y:headerHeight,width:Math.max(1,w-x),height:Math.max(1,h-headerHeight)});
    if(recoveryOverlay)recoveryOverlay.setBounds({x,y:headerHeight,
      width:Math.max(1,w-x),height:Math.max(1,h-headerHeight)});
  };
  void refreshSidebar();
  owner.on('resize',resize);
  owner.on('enter-full-screen',resize);
  owner.on('leave-full-screen',resize);
  // BrowserWindow has no normal renderer: the real page lives in a
  // WebContentsView. On macOS ready-to-show is not guaranteed to fire for
  // this native composition. Do not leave the login/workspace window hidden
  // while its Core MCP and Tunnel start successfully in the background.
  let windowRevealed=false;
  let revealTimer:NodeJS.Timeout|null=null;
  const revealWindow=()=>{
    if(owner.isDestroyed())return;
    resize();
    if(!windowRevealed){windowRevealed=true;owner.show();}
    if(revealTimer){clearTimeout(revealTimer);revealTimer=null;}
  };
  owner.once('ready-to-show',revealWindow);
  revealTimer=setTimeout(revealWindow,2500);
  revealTimer.unref();
  owner.on('closed',()=>{if(revealTimer)clearTimeout(revealTimer);});
  let nativeQuitting=false;
  owner.on('close',event=>{
    if(nativeQuitting||(!coreTunnel&&!remoteConnectionFlight))return;
    event.preventDefault();
    if(closingForTunnelStop)return;
    closingForTunnelStop=true;
    void (async()=>{
      try{
        await disconnectRemoteCore();
        if(!owner.isDestroyed()){nativeQuitting=true;owner.close();}
      }catch{
        // Keep the window and native authority alive when tunnel shutdown
        // cannot be proved. Never make a sidecar reload gate the shutdown.
        closingForTunnelStop=false;
        if(!owner.isDestroyed())void dialog.showMessageBox(owner,{
          type:'warning',title:'CoS Next · 安全退出受阻',
          message:'Core Tunnel 尚未确认完整退出，窗口已保留。',
          detail:'请先从「本地项目」菜单断开 Core；在退出收据明确之前不要运行第二个连接。',
          buttons:['关闭']
        });
      }
    })();
  });
  owner.on('closed',()=>{
    stopReplyCapture();
    hideRecoveryOverlay();
    void disableNativeCore().catch(()=>undefined);
    // BaseWindow-based children must be explicitly closed; do not leave a web
    // renderer process keeping an authenticated session alive after its owner.
    if(!view.webContents.isDestroyed())view.webContents.close();
    if(!sidebar.webContents.isDestroyed())sidebar.webContents.close();
  });
  owner.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  owner.webContents.on('will-navigate',e=>e.preventDefault());
  owner.webContents.on('will-attach-webview',e=>e.preventDefault());

  // A Google/OpenAI sign-in may open a separate identity window. Keep it
  // inside Electron and the same isolated session; never hand it to Chrome.
  view.webContents.setWindowOpenHandler(({url})=>{
    if(!allowedOAuthPopup(url))return {action:'deny'};
    return {action:'allow',outlivesOpener:false,
      overrideBrowserWindowOptions:{
        title:'CoS Next · 身份验证',width:620,height:740,show:true,autoHideMenuBar:true,
        webPreferences:{session:webSession,nodeIntegration:false,contextIsolation:true,
          sandbox:true,webSecurity:true,webviewTag:false}
      }
    };
  });
  view.webContents.on('did-create-window',popup=>{
    popup.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    popup.webContents.on('will-navigate',(event,url)=>{
      if(!isAllowedWebFirstNavigation(url))event.preventDefault();
    });
    popup.webContents.on('will-redirect',(event,url)=>{
      if(!isAllowedWebFirstNavigation(url))event.preventDefault();
    });
  });
  view.webContents.on('will-navigate',(event,url)=>{
    if(offline && url.startsWith('data:text/html,webfirst-offline'))return;
    if(!isAllowedWebFirstNavigation(url)){
      status.blockedNavigations++;
      event.preventDefault();
    }
  });
  view.webContents.on('will-redirect',(event,url)=>{
    if(!isAllowedWebFirstNavigation(url)){
      status.blockedNavigations++;
      event.preventDefault();
    }
  });
  view.webContents.on('did-start-navigation',(_event,_url,_inPlace,isMainFrame)=>{
    if(!offline&&isMainFrame){pageRecovery.navigate(Date.now());hideRecoveryOverlay();
      status.state='starting';status.lastErrorCode=null;}
  });
  view.webContents.on('did-navigate',(_event,url)=>{
    if(!offline)status.location=classifyWebFirstNavigation(url);
  });
  view.webContents.on('did-finish-load',()=>{
    if(view.webContents.isDestroyed())return;
    status.state='loaded';
    if(offline){status.location='offline-test';options.onOfflineLoaded?.(view.webContents);}
    else status.location=classifyWebFirstNavigation(view.webContents.getURL());
    options.onNavigationOutcome?.({...status});
  });
  view.webContents.on('did-fail-load',(_event,code,isMainFrame)=>{
    if(!isMainFrame || code===-3)return; // ordinary redirect cancellation
    status.state='load-failed'; status.lastErrorCode=code;
    if(!offline){
      healthReceipt('main-frame-network-error','chatgpt-main',null,code);
      pageRecovery.renderFailure(code);showRecoveryOverlay();
    }
    options.onNavigationOutcome?.({...status});
  });
  view.webContents.on('render-process-gone',()=>{
    if(offline||owner.isDestroyed())return;
    status.state='load-failed';
    healthReceipt('web-renderer-gone','chatgpt-main');
    pageRecovery.rendererGone();showRecoveryOverlay();
  });
  // A completed but entirely empty document produces no did-fail-load event.
  // Observe counts ONLY, never HTML/text/conversation content or cookies.
  let probing=false;
  const blankPoll=setInterval(()=>{
    if(offline||probing||owner.isDestroyed()||view.webContents.isDestroyed()||
      status.location!=='chatgpt'||pageRecovery.issue)return;
    probing=true;
    void (async()=>{
      let sample:SafePageProbe|null=null;
      try{
        const reply:unknown=await view.webContents.executeJavaScript(`(() => {
          const body=document.body;
          return {readyState:document.readyState,hasBody:!!body,
            bodyElements:body?.querySelectorAll('*').length??0,
            buttons:document.querySelectorAll('button').length,
            editorPresent:!!document.querySelector('[contenteditable="true"],[role="textbox"],textarea'),
            visibleElements:body?[...body.children].filter(e=>{
              const r=e.getBoundingClientRect();const s=getComputedStyle(e);
              return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none';
            }).length:0};
        })()`,true);
        if(reply&&typeof reply==='object')sample=reply as SafePageProbe;
      }catch{/* renderer not accessible; manual recovery remains available */}
      const result=pageRecovery.probe(sample,Date.now());
      if(result.issue)healthReceipt('page-empty','chatgpt-main',result.issue.status);
      if(result.retry&&!view.webContents.isDestroyed()&&
        classifyWebFirstNavigation(view.webContents.getURL())==='chatgpt'){
        // At most once, only after sustained truly empty DOM with no editor.
        pageRecovery.navigate(Date.now());
        view.webContents.reloadIgnoringCache();
      }else if(result.issue)showRecoveryOverlay();
    })().finally(()=>{probing=false;});
  },4000);
  blankPoll.unref();
  owner.on('closed',()=>clearInterval(blankPoll));
  const diagnostics = async ():Promise<WebHealthSnapshot>=>{
    const snapshot=health.snapshot();
    try{
      // Strict metadata-only read. Never read textContent, cookie, HTML,
      // localStorage, conversation IDs, model responses or script errors.
      const page=await view.webContents.executeJavaScript(`(() => ({
        readyState:document.readyState,
        textareaCount:document.querySelectorAll('textarea').length,
        enabledTextareas:document.querySelectorAll('textarea:not([disabled])').length,
        disabledButtons:document.querySelectorAll('button:disabled').length,
        totalButtons:document.querySelectorAll('button').length,
        serviceWorkerControlled:!!navigator.serviceWorker?.controller,
        editorPresent:!!document.querySelector('[role="textbox"],[contenteditable="true"]'),
        editorEnabled:!!document.querySelector('[role="textbox"]:not([aria-disabled="true"]),[contenteditable="true"]'),
        historyLinkCount:document.querySelectorAll('a[href^="/c/"]').length,
        editableNodes:document.querySelectorAll('[contenteditable="true"]').length,
        textBoxRoles:document.querySelectorAll('[role="textbox"]').length,
        inputNodes:document.querySelectorAll('input:not([type="hidden"])').length,
        editorVisible:(()=>{const e=document.querySelector('[role="textbox"],[contenteditable="true"]');if(!e)return false;const r=e.getBoundingClientRect();const st=getComputedStyle(e);return r.width>0&&r.height>0&&st.display!=='none'&&st.visibility!=='hidden';})(),
        editorAcceptsInput:(()=>{const e=document.querySelector('[role="textbox"],[contenteditable="true"]');if(!e)return false;const st=getComputedStyle(e);return e.getAttribute('aria-disabled')!=='true'&&e.getAttribute('contenteditable')!=='false'&&st.pointerEvents!=='none';})()
      }))()`,true);
      if(page && typeof page.readyState==='string')snapshot.page=page;
    }catch{/* fail closed without disclosing a page exception */}
    return snapshot;
  };
  const showDiagnostics=async()=>{
    const snap=await diagnostics();
    if(owner.isDestroyed())return;
    let recentHealth:unknown='NO_HEALTH_RECEIPTS';
    try{recentHealth=await healthLedger.last(8);}catch{recentHealth='LOCAL_HEALTH_LEDGER_INVALID';}
    await dialog.showMessageBox(owner,{
      type:'info',title:'CoS Next · Web-First 安全诊断',
      message:'网页状态（不读取 Cookie 或聊天正文）',
      detail:JSON.stringify({navigation:status,
        recovery:{mainFrameHttpStatus:pageRecovery.http,issue:pageRecovery.issue,
          blankAutoRetryUsed:pageRecovery.autoRetried,overlayVisible:!!recoveryOverlay},
        recentNativeHealthReceipts:recentHealth,...snap},null,2),
      buttons:['关闭']
    });
  };
  const manageReadGrants=async()=>{
    try{
      const state=await grants.inspect();
      const entries=[...state.persistent.map(g=>({...g,mode:'永久'})),
        ...state.session.map(g=>({...g,mode:'本次运行'}))];
      if(!entries.length){
        await dialog.showMessageBox(owner,{type:'info',message:'当前没有已授予的只读权限。',
          detail:'你也可以在下次读取弹窗中选择“本次运行允许”或“始终允许”。',buttons:['关闭']});return;
      }
      for(let i=0;i<entries.length;i++){
        const grant=entries[i];if(!grant||owner.isDestroyed())return;
        const decision=await dialog.showMessageBox(owner,{
          type:'question',title:'管理与撤销本地只读授权',
          message:(i+1)+' / '+entries.length+'：'+grant.mode+' · '+
            (grant.scope==='catalog'?'仅项目名称与 ID':'项目目录只读'),
          detail:(grant.root??'项目名称列表')+'\n\n撤销立即生效。正在处理中的已获批请求不能被撤回。',
          buttons:['撤销这一项','查看下一项','关闭'],defaultId:2,cancelId:2,noLink:true
        });
        if(decision.response===2)return;
        if(decision.response===0)await grants.revoke(grant.scope,grant.projectId);
      }
      await refreshSidebar();
    }catch{
      if(!owner.isDestroyed())await dialog.showMessageBox(owner,{type:'error',
        message:'授权记录无法安全读取或更新。所有自动批准已暂停。',buttons:['关闭']});
    }
  };
  const revokeAllReadGrants=async()=>{
    if(owner.isDestroyed())return;
    const decision=await dialog.showMessageBox(owner,{
      type:'warning',title:'撤销所有本地只读授权',
      message:'确定撤销全部永久授权和本次运行授权？',
      detail:'以后访问每个项目都将重新请求明确批准。不会删除项目目录或原有 ChatGPT 登录。',
      buttons:['取消','撤销全部'],defaultId:0,cancelId:0,noLink:true
    });
    if(decision.response!==1)return;
    try{await grants.revokeAll();await refreshSidebar();}
    catch{if(!owner.isDestroyed())await dialog.showMessageBox(owner,{
      type:'error',message:'撤销未能安全完成，请暂停使用项目工具。',buttons:['关闭']});}
  };
  const showOperations=async()=>{
    try{
      const receipts=await journal.last(18);
      const details=receipts.map(r=>new Date(r.at).toLocaleString()+'  '+
        r.action+'  '+r.stage).join('\n');
      await dialog.showMessageBox(owner,{title:'P3 · 本地工具执行收据',
        message:'本地只读工具事件（仅元数据）',detail:details||'目前没有本地工具执行记录。',
        buttons:['关闭']});
    }catch{if(!owner.isDestroyed())await dialog.showMessageBox(owner,{type:'error',
      message:'本地操作收据验证失败，操作应暂停。',buttons:['关闭']});}
  };
  const approveScopedRead:NativeReadApproval=async request=>{
    const review=async():Promise<boolean>=>{
      if(offline)return true; // disposable offline smoke fixture only
      if(owner.isDestroyed())return false;
      const scope=request.action==='project_list'?'catalog':'project-read';
      const projectId=request.projectId??null;
      const root=request.projectRoot??null;
      try{
        if(await grants.allowed(scope,projectId,root,request.target??null,request.action))return true;
        const sensitive=scope==='project-read'&&(!root||!request.target||isSensitiveProjectPath(root,request.target));
        const label:Record<ReadAction,string>={
          project_list:'查看项目名称与 ID',
          project_ls:'列举项目目录中的文件名',
          project_read:'读取项目内文件正文（上限 32 KiB）',
          project_find:'搜索指定项目目录中的普通文本和文件名（排除隐私文件）'
        };
        const buttons=sensitive?['拒绝','仅允许这一次']:
          ['拒绝','仅允许这一次','本次运行允许','始终允许（该范围只读）'];
        const result=await dialog.showMessageBox(owner,{
          type:'question',title:'CoS Next · 本地项目只读授权',
          message:'是否'+label[request.action]+'？',
          detail:(request.projectName?'项目：'+request.projectName+'\n':'')+
            (request.target?'路径：'+request.target+'\n':'')+
            (sensitive?'敏感目录或文件不会授予持久自动访问。\n':'')+
            '注意：目前无法可靠绑定具体 ChatGPT 会话。\n'
            +'永久授权可被同一 Core 连接中的其他对话使用；请只授予你信任的项目。\n'
            +'本次/永久授权不包括文件写入、终端执行或 Git 发布。',
          buttons,defaultId:0,cancelId:0,noLink:true
        });
        if(result.response===0||owner.isDestroyed())return false;
        if(result.response===2)await grants.grant(scope,projectId,root,'session');
        if(result.response===3)await grants.grant(scope,projectId,root,'always');
        if(result.response>=2)await refreshSidebar();
        return true;
      }catch{
        if(!owner.isDestroyed())await dialog.showMessageBox(owner,{type:'error',
          message:'只读授权记录校验失败，已拒绝本次自动访问。',buttons:['关闭']});
        return false;
      }
    };
    // Coalesce racing requests: the first durable approval covers subsequent
    // reads in its approved scope, preventing a storm of duplicate dialogs.
    const wait=approvals.then(review);approvals=wait.catch(()=>undefined);return wait;
  };
  const addProjectFromNativePicker=async()=>{
    const chosen=await dialog.showOpenDialog(owner,{
      title:'CoS Next — 选择本地项目目录',properties:['openDirectory']
    });
    if(chosen.canceled||!chosen.filePaths[0]||owner.isDestroyed())return;
    // Selecting a folder does not grant an MCP capability or execute a command.
    const response=await dialog.showMessageBox(owner,{
      type:'question',title:'确认仅在本地登记项目',
      message:'保存此项目目录为本地书签？',detail:chosen.filePaths[0]+
        '\n\n不会自动读取文件、上传项目、运行命令或授权 ChatGPT/AI。',
      buttons:['取消','仅登记'],defaultId:0,cancelId:0,noLink:true
    });
    if(response.response!==1||owner.isDestroyed())return;
    try{
      await projects.register(chosen.filePaths[0]);
      await refreshSidebar();
    }catch{
      if(!owner.isDestroyed())await dialog.showMessageBox(owner,{
        type:'error',title:'项目登记失败',message:'无法安全保存项目登记。既有登记文件未被重置。',
        buttons:['关闭']
      });
    }
  };
  async function enableNativeCore(approvedForSameConnect=false):Promise<{endpointUrl:string;port:number}>{
    if(mcpStartFlight)return mcpStartFlight;
    if(mcpService)return {endpointUrl:mcpService.endpointUrl,port:mcpService.port};
    const work=async()=>{
      // A native approval for the full Core connection also authorizes its
      // prerequisite local-only MCP listener. Don't ask the same user twice.
      if(!offline&&!approvedForSameConnect){
        if(owner.isDestroyed())throw Error('WEBFIRST_WINDOW_CLOSED');
        const consent=await dialog.showMessageBox(owner,{
          type:'warning',title:'启用本机 Core MCP 服务',
          message:'仅在此 Mac 启动一个受限 Core MCP 服务？',
          detail:'此步骤不会连接 ChatGPT 插件，也不会自动授权任何项目。\n'
            +'普通只读操作可按项目记住授权；每次代码修改都须另行批准。\n'
            +'仅有上限的单次文本替换可获批准；不允许任意终端命令或未授权的自动任务。',
          buttons:['取消','启用本地服务'],defaultId:0,cancelId:0,noLink:true
        });
        if(consent.response!==1)throw Error('WEBFIRST_CORE_NOT_APPROVED');
      }
      const authority=new WebFirstReadAuthority(projects,approveScopedRead);
      const created=await createWebFirstCoreLoopback(authority,journal,taskTools,writeAuthority,planTools);
      if(owner.isDestroyed()){
        await created.close();throw Error('WEBFIRST_WINDOW_CLOSED');
      }
      mcpService=created;mcpState='LOCAL_ONLY';
      await refreshSidebar();
      return {endpointUrl:created.endpointUrl,port:created.port};
    };
    mcpStartFlight=work().finally(()=>{mcpStartFlight=null;});
    return mcpStartFlight;
  }
  async function disconnectRemoteCore():Promise<void>{
    recoverApproved=false;
    if(remoteConnectionFlight)await remoteConnectionFlight.catch(()=>undefined);
    if(!coreTunnel)return;
    const target=coreTunnel;
    // A disappeared broker is not a still-running owned connection. Before
    // releasing the stale handle, prove no orphaned tunnel client exists.
    if(!target.alive){
      if(await existingTunnelOwnerPresent()){
        mcpState='HOLD';await refreshSidebar();
        throw Error('CORE_TUNNEL_ORPHAN_OWNER_UNVERIFIED');
      }
      coreTunnel=null;mcpState='LOCAL_ONLY';await refreshSidebar();return;
    }
    const proven=await target.stopWithProof();
    if(!proven){mcpState='HOLD';await refreshSidebar();
      throw Error('CORE_TUNNEL_SHUTDOWN_UNVERIFIED');}
    coreTunnel=null;mcpState='LOCAL_ONLY';
    await refreshSidebar();
  }
  let coreConnectUiPending=false;
  async function connectRemoteCore(recovery=false):Promise<void>{
    if(offline)throw Error('NO_REMOTE_IN_OFFLINE_SMOKE');
    if(coreConnectUiPending)return;
    coreConnectUiPending=true;
    try{
    if(coreTunnel&&!coreTunnel.alive){
      // Drop a dead local handle only if the tunnel-client owner check passes
      // in connectWebFirstImportedCore. An orphan will block the new launch.
      coreTunnel=null;
    }
    if(coreTunnel||remoteConnectionFlight)return;
    if(recovery&&!mcpService)return;
    if(!recovery){
      const consent=await dialog.showMessageBox(owner,{
        type:'warning',title:'连接现有 ChatGPT Core Tunnel',
        message:'从原有 Next 加密配置连接 ChatGPT Core？',
        detail:'本次批准同时启用本机 Core MCP，并只读复用旧 Next Keychain；不会复制凭证、调用模型或升级项目权限。\n'
          +'本次批准后，若 Broker 意外退出，将有限次数自动重连，无需反复弹窗。\n'
          +'你可以随时通过“断开 ChatGPT Core Tunnel”关闭自动重连。',
        buttons:['取消','连接并允许有限自愈'],defaultId:0,cancelId:0,noLink:true
      });
      if(consent.response!==1)return;
      recoverApproved=true;recoverAttempts=0;recoverDueAt=0;
    }
    // The one native consent above covers both safe local listener startup
    // and reusing the existing Core tunnel. Automatic retries use that grant.
    const local=await enableNativeCore(true);
    if(owner.isDestroyed())throw Error('WEBFIRST_WINDOW_CLOSED');
    remoteConnectionFlight=(async()=>{
      mcpState='REMOTE_CONNECTING';await refreshSidebar();
      try{
        const target=await connectWebFirstImportedCore({appData:options.appDataDir,
          localUrl:local.endpointUrl,onChange:(state:CoreTunnelState)=>{
            if(state==='CONNECTED')mcpState='REMOTE_CONNECTED';
            else if(state==='HOLD')mcpState='HOLD';
            else if(state==='OFFLINE')mcpState='REMOTE_CONNECTING';
            void refreshSidebar();
          }});
        coreTunnel=target;
        const ok=await target.connected;
        if(!ok){
          const proven=await target.stopWithProof();
          if(!proven)throw Error('CORE_TUNNEL_SHUTDOWN_UNVERIFIED');
          coreTunnel=null;mcpState='HOLD';await refreshSidebar();
          throw Error('CORE_TUNNEL_NOT_READY');
        }
        mcpState='REMOTE_CONNECTED';lastConnectedAt=Date.now();
        if(!recovery){recoverAttempts=0;recoverDueAt=0;}
        await refreshSidebar();
      }catch(error){
        mcpState='HOLD';await refreshSidebar();throw error;
      }
    })();
    try{await remoteConnectionFlight;}
    catch(error){
      if(!recovery&&!owner.isDestroyed())await dialog.showMessageBox(owner,{
        type:'warning',title:'Core 连接尚未通过验收',
        message:'无法确认当前 Core Tunnel 完成了真实握手。',
        detail:'既有凭证和 Classic 配置未被复制或清空。\n原因：'+
          (error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:'连接条件不满足'),
        buttons:['关闭']
      });
    }finally{remoteConnectionFlight=null;}
    }finally{coreConnectUiPending=false;}
  }
  async function disableNativeCore():Promise<void>{
    await disconnectRemoteCore();
    if(mcpStartFlight)await mcpStartFlight.catch(()=>undefined);
    const current=mcpService;
    mcpService=null;mcpState='UNCONNECTED';
    if(current)await current.close();
    if(!owner.isDestroyed())await refreshSidebar();
  }
  let webDispatchInProgress=false;
  const continueTaskOneNativeTurn=async()=>{
    if(webDispatchInProgress||owner.isDestroyed())return;
    const conversationId=conversationFromUrl(view.webContents.getURL());
    if(!conversationId){await dialog.showMessageBox(owner,{type:'warning',
      message:'请先进入 ChatGPT 的具体对话，才可发送任务续接消息。',buttons:['关闭']});return;}
    try{
      // Never submit a new website model turn during provider backoff. A
      // timed-out cooldown still requires explicit human confirmation.
      await throttle.requireManualModelAvailable();
      const tasks=(await taskLedger.list()).filter(t=>t.phase==='active').slice(-4).reverse();
      if(!tasks.length){await dialog.showMessageBox(owner,{type:'info',
        message:'当前没有已经启动并授权的活动任务。请先通过 Core task_begin 创建任务。',
        buttons:['关闭']});return;}
      const chosen=await dialog.showMessageBox(owner,{
        type:'question',title:'选择一次 Web-First 续接任务',
        message:'此操作将使用已登录的 ChatGPT 网页发送一条普通消息',
        detail:'它不使用 Codex CLI 或 API 模型，但仍计入 ChatGPT 网站的正常使用限额。',
        buttons:['取消',...tasks.map(t=>t.goal.slice(0,65))],defaultId:0,cancelId:0,noLink:true
      });
      const task=tasks[chosen.response-1];
      if(!task||conversationFromUrl(view.webContents.getURL())!==conversationId)return;
      const prompt='继续当前已授权的项目任务（CoS 本地任务 ID：'+task.id+
        '）。请依照当前对话和项目实际状态推进尚未完成的步骤。'
        +'如果需要等待，请使用 task_wait；完成时使用 task_finish_request 请求本地审核。';
      if(prompt.length>2000)throw Error('WEB_INPUT_PROMPT_INVALID');
      const previous=(await webOutbox.list()).filter(x=>x.taskId===task.id&&x.conversationId===conversationId);
      if(previous.some(x=>x.state==='uncertain'||x.state==='queued'||x.state==='dispatching'))
        throw Error('WEB_INPUT_PREVIOUS_DELIVERY_UNCERTAIN');
      if(previous.length>=5)throw Error('WEB_INPUT_TASK_TURN_BUDGET_EXHAUSTED');
      const confirmed=await dialog.showMessageBox(owner,{
        type:'warning',title:'确认向 ChatGPT 网页发送一次续接',
        message:'确认发送以下一次性任务续接指令？',
        detail:prompt+'\n\n如果网页是否已接收不能确认，会保留不确定收据而不自动重发。',
        buttons:['取消','确认发送这一次'],defaultId:0,cancelId:0,noLink:true
      });
      if(confirmed.response!==1||owner.isDestroyed()||
        conversationFromUrl(view.webContents.getURL())!==conversationId)return;
      // Revalidate after the native approval: a 429 may have arrived while
      // the user was reading the dialog.
      await throttle.requireManualModelAvailable();
      webDispatchInProgress=true;
      const queued=await webOutbox.enqueue({taskId:task.id,conversationId,text:prompt,nonce:randomUUID()});
      await webOutbox.transition(queued.id,'queued','dispatching');
      let proof:string|null=null;
      try{
        const sent=await sendNativeWebFirstMessage(view.webContents,conversationId,prompt);
        if(sent.proved)proof=sent.proof;
      }finally{
        await webOutbox.transition(queued.id,'dispatching',proof?'delivered':'uncertain',proof);
      }
      if(!owner.isDestroyed())await dialog.showMessageBox(owner,{
        type:proof?'info':'warning',
        message:proof?'网页已出现匹配的用户消息，发送收据已保存。':
          '网页发送结果不确定，CoS 不会自动重发。',
        buttons:['关闭']
      });
    }catch{
      if(!owner.isDestroyed())await dialog.showMessageBox(owner,{type:'warning',
        message:'续接发送被安全门禁阻止，或无法可靠确认网页收据。',
        detail:'请检查当前对话是否有未发送草稿、模型是否仍在生成，以及本地操作收据。',
        buttons:['关闭']});
    }finally{webDispatchInProgress=false;}
  };
  const toggleReplyCapture=async()=>{
    if(recordingChat){
      stopReplyCapture();
      if(!owner.isDestroyed())await dialog.showMessageBox(owner,{
        type:'info',message:'已停止记录内嵌网页回复。',buttons:['关闭']});
      return;
    }
    const id=conversationFromUrl(view.webContents.getURL());
    if(!id||owner.isDestroyed()){
      if(!owner.isDestroyed())await dialog.showMessageBox(owner,{
        type:'warning',message:'请先打开一个 ChatGPT 具体对话，再开启回复记录。',buttons:['关闭']});
      return;
    }
    const accepted=await dialog.showMessageBox(owner,{
      type:'question',title:'开启当前 ChatGPT 对话的本地回复记录',
      message:'允许 CoS 只读取当前对话在网页上已显示的助手回复吗？',
      detail:'回复文本仅写入此 Mac 的独立 0600 本地记录，不读取 Cookie、密钥或其他标签页。'
        +'切换对话将自动停止；不自动发送新消息，也不额外调用模型。',
      buttons:['取消','开启当前对话记录'],defaultId:0,cancelId:0,noLink:true
    });
    if(accepted.response!==1||owner.isDestroyed()||
      conversationFromUrl(view.webContents.getURL())!==id)return;
    recordingChat=id;replyTracker.reset();
    replyTimer=setInterval(()=>{void captureVisibleReply();},2500);
    replyTimer.unref();void captureVisibleReply();
  };
  const inspectCapturedReplies=async()=>{
    if(owner.isDestroyed())return;
    try{
      const latest=(await webReplies.last(12)).at(-1);
      await dialog.showMessageBox(owner,{
        type:'info',title:'CoS 本地网页回复记录（仅本机）',
        message:latest?'最新记录：'+new Date(latest.at).toLocaleString():'尚无已经稳定捕获的助手回复',
        detail:latest?latest.text.slice(0,1800):
          '开启记录后仅观察当前 ChatGPT 对话。网页回复需要稳定显示一段时间才被接收。',
        buttons:['关闭']
      });
    }catch{if(!owner.isDestroyed())await dialog.showMessageBox(owner,{
      type:'error',message:'本地回复记录不安全或已损坏，读取已拒绝。',buttons:['关闭']});}
  };
  // P3 continuity mode is an opt-in OBSERVATION lease only. It cannot
  // schedule chat sends while caller identity / provider completion is not
  // verified. The one-shot send menu keeps its independent native approval.
  let continuityLease:ContinuityLease|null=null;
  let continuationReply:VisibleWebReply|null=null;
  let continuationReplyAt:number|null=null;
  const continuationTracker=new WebReplySettleTracker();
  let continuationTimer:NodeJS.Timeout|null=null;
  const clearContinuityObservation=()=>{
    continuityLease=null;continuationReply=null;continuationReplyAt=null;continuationTracker.reset();
    if(continuationTimer){clearInterval(continuationTimer);continuationTimer=null;}
  };
  owner.on('closed',clearContinuityObservation);
  const sampleContinuity=async()=>{
    if(!continuityLease||owner.isDestroyed())return;
    const current=conversationFromUrl(view.webContents.getURL());
    if(Date.now()>continuityLease.expiresAt){clearContinuityObservation();return;}
    if(current!==continuityLease.conversationId){clearContinuityObservation();return;}
    const snapshot=await snapshotVisibleAssistant();
    const settled=continuationTracker.observe(snapshot);
    if(settled){continuationReply=settled;continuationReplyAt=Date.now();}
  };
  const armContinuityObservation=async()=>{
    if(continuityLease){clearContinuityObservation();
      if(!owner.isDestroyed())await dialog.showMessageBox(owner,{type:'info',
        message:'当前连续工作观察已停止，不会自动发送消息。',buttons:['关闭']});
      return;
    }
    const conversationId=conversationFromUrl(view.webContents.getURL());
    if(!conversationId||owner.isDestroyed()){
      if(!owner.isDestroyed())await dialog.showMessageBox(owner,{type:'warning',
        message:'请先打开需要长期工作的 ChatGPT 具体对话。',buttons:['关闭']});
      return;
    }
    const active=(await taskLedger.list()).filter(t=>t.phase==='active').slice(-4).reverse();
    if(!active.length){await dialog.showMessageBox(owner,{type:'warning',
      message:'没有可绑定的 ACTIVE 项目任务。等待中的任务需先由你批准恢复。',
      buttons:['关闭']});return;}
    const chosen=await dialog.showMessageBox(owner,{
      type:'question',title:'绑定当前网页与本地任务（只读观察）',
      message:'请选择一个当前 ACTIVE 的持久任务',
      detail:'绑定仅在本次运行有效。最多观察 3 次续接，15 分钟后自动失效。'
        +'不会自动点击“发送”、不会修改本地文件，不使用额外 Codex/API 模型调用。',
      buttons:['取消',...active.map(t=>t.goal.slice(0,60))],defaultId:0,cancelId:0,noLink:true
    });
    const task=active[chosen.response-1];
    if(!task||owner.isDestroyed()||conversationFromUrl(view.webContents.getURL())!==conversationId)return;
    const baseline=await snapshotVisibleAssistant();
    continuityLease=createContinuityLease({taskId:task.id,conversationId,now:Date.now(),
      maxTurns:3,maxMinutes:15,baselineAssistantMessage:baseline?.messageId??null});
    continuationTracker.reset();continuationReply=null;continuationReplyAt=null;
    continuationTimer=setInterval(()=>{void sampleContinuity().catch(()=>{
      // DOM errors are non-evidence. Never promote the session to auto-send.
    });},2500);
    continuationTimer.unref();void sampleContinuity();
  };
  const inspectContinuity=async()=>{
    if(owner.isDestroyed())return;
    const lease=continuityLease;
    let task=null;
    try{if(lease)task=await taskLedger.get(lease.taskId);}catch{/* fail closed */}
    let outbox=[] as Awaited<ReturnType<typeof webOutbox.list>>;
    let outboxReadFailed=false;
    try{outbox=await webOutbox.list();}catch{outboxReadFailed=true;}
    const result=assessContinuity({lease,now:Date.now(),
      currentUrl:view.webContents.getURL(),task,outbox,
      latestReply:continuationReply,replySettled:continuationReply!==null,
      replyObservedAt:continuationReplyAt});
    if(outboxReadFailed){result.manualNextTurnReady=false;result.reason='OUTBOX_AMBIGUOUS';}
    try{
      if((await throttle.status()).model!=='clear'){
        result.manualNextTurnReady=false;
      }
    }catch{result.manualNextTurnReady=false;}
    await dialog.showMessageBox(owner,{type:'info',
      title:'P3 连续工作准备度 · 安全核对',
      message:result.manualNextTurnReady?'可申请一次人工批准的网页续接':'当前不应继续发送网页消息',
      detail:'状态：'+(result.reason??'NO_BLOCKER')+'\n'
        +'当前续接：'+result.sentTurns+'/'+result.maxTurns+'\n'
        +'无人值守自动续接：关闭（平台会话身份及完成证据仍未验证）\n'
        +'当前 App 不会自行向 ChatGPT 发送消息。',
      buttons:['关闭']
    });
  };
  let goalWindow:BrowserWindow|null=null;
  let goalFormBusy=false;
  const openGoalWorkbench=async():Promise<void>=>{
    if(owner.isDestroyed())return;
    if(goalWindow&&!goalWindow.isDestroyed()){
      goalWindow.show();goalWindow.focus();return;
    }
    const goalUi=new BrowserWindow({parent:owner,title:'CoS Next · Goal / 计划工作台',
      width:1040,height:820,minWidth:650,minHeight:520,show:true,
      backgroundColor:'#0b1220',webPreferences:{nodeIntegration:false,
        contextIsolation:true,sandbox:true,webSecurity:true,javascript:false,webviewTag:false}});
    goalWindow=goalUi;
    goalUi.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    goalUi.webContents.on('will-attach-webview',event=>event.preventDefault());
    goalUi.webContents.on('will-redirect',event=>event.preventDefault());
    const render=async(message='')=>{
      if(goalUi.isDestroyed())return;
      const [projectList,taskList,planList,limit,jobState]=await Promise.all([
        projects.list(),taskLedger.list(),planLedger.list(),
        throttle.status().catch(()=>null),
        localJobs.list().then(jobs=>({jobs,error:false})).catch(()=>({jobs:[],error:true}))]);
      if(goalUi.isDestroyed())return;
      const html=renderGoalWorkbench({projects:projectList,tasks:taskList,plans:planList,jobs:jobState.jobs,jobError:jobState.error,message,limit});
      await goalUi.webContents.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(html));
    };
    goalUi.webContents.on('will-navigate',(event,url)=>{
      // All navigation is rejected; the native main process validates one
      // exact local action and handles it without ever touching the network.
      event.preventDefault();
      if(offline)process.stdout.write('WEB_FIRST_OFFLINE_GOAL_FORM_NAV_EVENT\n');
      if(goalFormBusy||goalUi.isDestroyed())return;
      goalFormBusy=true;
      void (async()=>{
        try{
          const command=parseWorkbenchAction(url);
          if(command.kind==='refresh'){await render('已刷新');return;}
          if(command.kind==='create'){
            const steps=parsePlanLines(command.lines);
            const project=(await projects.list()).find(p=>p.id===command.projectId);
            if(!project)throw Error('GOAL_PROJECT_NOT_REGISTERED');
            const task=await taskLedger.begin({projectId:project.id,projectRoot:project.root,
              goal:command.goal.trim()});
            // An interrupted plan save must not silently delete the goal.
            if(steps.length)await planLedger.update({taskId:task.id,expectedRevision:0,
              nonce:randomUUID(),explanation:'由原生 Goal 工作台创建',steps});
            await render('目标已保存到本机。创建目标不会启动自动模型循环。');
            void refreshSidebar();return;
          }
          if(command.kind==='local-check'){
            const job=await localJobs.enqueue({taskId:command.taskId,
              taskRevision:command.taskRevision,planRevision:command.planRevision,
              kind:command.check,nonce:randomUUID()});
            await render('本地检查已批准并记录。只运行固定的只读检查，不调用模型。');
            // Work is owned by the native process and persists if the workbench
            // closes. Missing exit evidence becomes REVIEW on next app start.
            void localJobs.run(job.id).then(()=>{
              if(!goalUi.isDestroyed())void render('本地检查结束；请查看任务卡片的检查收据。').catch(()=>undefined);
            }).catch(()=>{
              if(!goalUi.isDestroyed())void render('检查收据需要复核；未自动重试。').catch(()=>undefined);
            });
            return;
          }
          if(command.kind==='advance'){
            const task=await taskLedger.get(command.taskId);
            if(task.revision!==command.taskRevision)throw Error('GOAL_TASK_STALE_REVISION');
            if(task.phase!=='active')throw Error('GOAL_TASK_NOT_ACTIVE');
            const plan=await planLedger.status(task.id);
            if(!plan||plan.revision!==command.planRevision)throw Error('PLAN_STALE_REVISION');
            const steps=completePlanStep(plan.steps,command.at);
            await planLedger.update({taskId:task.id,expectedRevision:plan.revision,
              nonce:randomUUID(),explanation:'用户手动确认完成一步，未运行模型',steps});
            await render('计划步骤已更新。目标仍需人工验收。');return;
          }
          if(command.kind==='update-plan'){
            const steps=parsePlanLines(command.lines);
            await planLedger.update({taskId:command.taskId,expectedRevision:command.revision,
              nonce:randomUUID(),explanation:'由原生工作台更新计划',steps});
            await render('计划已保存并更新版本；尚未自动执行步骤。');return;
          }
          const task=await taskLedger.get(command.taskId);
          if(task.revision!==command.revision)throw Error('GOAL_TASK_STALE_REVISION');
          if(command.decision==='complete'||command.decision==='cancel'){
            const sure=await dialog.showMessageBox(goalUi,{
              type:'warning',title:'确认更改任务状态',
              message:command.decision==='complete'?'确认为已验收完成？':'确认取消这个目标？',
              detail:task.goal.slice(0,500)+'\n\n不会删除已有记录，也不会触发新的模型消息。',
              buttons:['返回','确认'],defaultId:0,cancelId:0,noLink:true
            });
            if(sure.response!==1||goalUi.isDestroyed())return;
          }
          await taskLedger.nativeDecision(task.id,task.revision,command.decision);
          if(command.decision==='pause'||command.decision==='cancel')localJobs.stopTask(task.id);
          await render('任务状态已持久化。');void refreshSidebar();
        }catch(err){
          const reason=err instanceof Error&&/^[A-Z_]+$/.test(err.message)?err.message:'GOAL_ACTION_REJECTED';
          try{await render('未执行修改：'+reason+'；可刷新查看当前保存的任务。');}
          catch{/* corrupted ledger: preserve on-disk record */}
        }finally{goalFormBusy=false;}
      })();
    });
    goalUi.on('closed',()=>{if(goalWindow===goalUi)goalWindow=null;});
    try{await render();}catch{
      if(!goalUi.isDestroyed())await dialog.showMessageBox(goalUi,{type:'error',
        message:'本机目标或计划记录不可安全读取。未覆盖现有数据。',buttons:['关闭']});
    }
  };
  owner.on('closed',()=>{localJobs.stopActive();if(goalWindow&&!goalWindow.isDestroyed())goalWindow.close();});
  const manageDurableTasks=async()=>{
    if(owner.isDestroyed())return;
    try{
      const all=await taskLedger.list();
      const recent=all.slice(-10).reverse();
      const display=recent.map(t=>t.id.slice(0,8)+' · '+t.phase+' · rev '+t.revision+
        ' · '+t.goal.slice(0,72)).join('\n');
      const menu=await dialog.showMessageBox(owner,{
        type:'question',title:'Web-First 持久任务',
        message:all.length+' 个本地任务 · 未验证会话身份',
        detail:(display||'当前没有任务。')+'\n\n重启后中断的任务必须先由你确认恢复；此处不会自动发送 ChatGPT Prompt。',
        buttons:['关闭','管理最近一项任务'],defaultId:0,cancelId:0,noLink:true
      });
      if(menu.response!==1||!recent.length||owner.isDestroyed())return;
      const task=recent[0]!;
      const next=await dialog.showMessageBox(owner,{
        type:'question',title:'任务状态检查与操作',
        message:task.goal.slice(0,140)+' · '+task.phase,
        detail:'最近事件：'+(task.events.at(-1)?.kind??'unknown')+
          '\n请不要把模型报告等同于经验证的成功。',
        buttons:['返回','批准恢复','确认完成','取消任务'],defaultId:0,cancelId:0,noLink:true
      });
      const action=next.response===1?'resume':next.response===2?'complete':
        next.response===3?'cancel':null;
      if(action){
        const result=await taskLedger.nativeDecision(task.id,task.revision,action);
        if(!owner.isDestroyed())await dialog.showMessageBox(owner,{type:'info',
          message:'已保存任务状态：'+result.phase,buttons:['关闭']});
      }
    }catch{
      if(!owner.isDestroyed())await dialog.showMessageBox(owner,{type:'error',
        message:'任务状态或检查点验证失败。已拒绝改变任务，原记录保持不变。',buttons:['关闭']});
    }
  };
  // Native recovery timer never sends ChatGPT messages and never copies a
  // Keychain secret. Tunnel-owner conflict is a hard HOLD, not a retry loop.
  const recoveryTimer=setInterval(()=>{
    if(offline||recovering||!recoverApproved||!mcpService||owner.isDestroyed()||
      remoteConnectionFlight)return;
    if(coreTunnel?.alive){
      if(mcpState==='REMOTE_CONNECTED'&&Date.now()-lastConnectedAt>5*60_000)
        recoverAttempts=0;
      return;
    }
    recovering=true;
    void (async()=>{
      try{
        const conflict=await existingTunnelOwnerPresent();
        const choice=coreRecoveryDecision({requested:recoverApproved,
          brokerAlive:!!coreTunnel?.alive,ownerPresent:conflict,
          attempts:recoverAttempts,dueAt:recoverDueAt,now:Date.now()});
        if(choice==='hold'){
          recoverApproved=false;mcpState='HOLD';await refreshSidebar();return;
        }
        if(choice!=='retry')return;
        recoverAttempts++;
        recoverDueAt=Date.now()+Math.min(90_000,5000*2**(recoverAttempts-1));
        await connectRemoteCore(true);
      }catch{mcpState='HOLD';await refreshSidebar();}
      finally{recovering=false;}
    })();
  },5000);
  recoveryTimer.unref();
  owner.on('closed',()=>clearInterval(recoveryTimer));
  const showCoreCatalogue=async()=>{
    if(owner.isDestroyed())return;
    const local=mcpService;
    let message='本地 MCP 服务未启动。';
    if(local){
      try{
        const actual=await readWebFirstLocalToolList(local.endpointUrl);
        message='本机 MCP 已实际登记 '+actual.length+' 个工具：\n'+actual.join('、')+
          '\n\nChatGPT 当前获批的工具列表是独立快照。'
          +'本机 tools/list 成功不代表 ChatGPT 已更新或授予这些工具。';
      }catch{message='本机 MCP 工具列表无法验证；请检查连接状态。';}
    }
    if(!owner.isDestroyed())await dialog.showMessageBox(owner,{
      type:'info',title:'Core MCP 工具清单 · 两级验收',
      message:'Core Tunnel：'+(mcpState==='REMOTE_CONNECTED'?'控制平面已握手':mcpState)+
        '；ChatGPT 工具发布：未验证',
      detail:message+'\n\n目标清单：'+EXPECTED_READ_ONLY_CORE_TOOLS.join('、'),
      buttons:['关闭']
    });
  };
  const manageRateLimit=async()=>{
    if(owner.isDestroyed())return;
    try{
      const state=await throttle.status();
      const due=state.modelHoldUntil?new Date(state.modelHoldUntil).toLocaleString():'无';
      const response=await dialog.showMessageBox(owner,{
        type:'question',title:'CoS Next · 限流与持续工作恢复',
        message:state.model==='cooldown'?'模型请求冷却中':
          state.model==='review'?'冷却时间已到，等待你确认恢复':'模型续接未被本机限流门禁暂停',
        detail:'模型限流状态：'+state.model+'\n建议检查时间：'+due+'\n'
          +'历史列表：'+state.history+'（历史 429 不等于模型额度耗尽）\n\n'
          +'冷却期间，持久任务、已获授权的本机非模型工作与故障收据可继续；'
          +'不会自动重试模型消息、调用 Codex CLI 或绕过服务端额度。',
        buttons:['关闭','模型限流：暂停 30 分钟','我已确认模型额度恢复'],
        defaultId:0,cancelId:0,noLink:true
      });
      if(response.response===1){
        await throttle.pauseForModelLimit(30);
      }else if(response.response===2){
        const latest=await throttle.status();
        if(latest.model==='cooldown'){
          await dialog.showMessageBox(owner,{type:'warning',
            message:'仍在模型冷却期。CoS 不会提前重试被限流的网页请求。',buttons:['关闭']});
          return;
        }
        const accepted=await dialog.showMessageBox(owner,{
          type:'warning',title:'确认恢复模型请求',
          message:'你已经在 ChatGPT 官方网页确认额度恢复了吗？',
          detail:'仅清除本机冷却标记。不会自动开始 Loop、恢复等待任务或发送任何消息。',
          buttons:['取消','确认解除本机模型冷却'],defaultId:0,cancelId:0,noLink:true
        });
        if(accepted.response===1)await throttle.confirmRecovery();
      }
    }catch{
      if(!owner.isDestroyed())await dialog.showMessageBox(owner,{type:'error',
        message:'限流状态无法安全读取或变更；已经拒绝网页自动续接。',buttons:['关闭']});
    }
  };
  const showLocalProjectStatus=async()=>{
    let list:ReadonlyArray<WebFirstProject>;
    try{list=await projects.list();}
    catch{
      if(!owner.isDestroyed())await dialog.showMessageBox(owner,{type:'warning',
        message:'本地项目登记需要检查；已暂停添加和加载。',buttons:['关闭']});
      return;
    }
    if(!owner.isDestroyed())await dialog.showMessageBox(owner,{
      title:'CoS Next 本地项目与 MCP',
      message:list.length+' 个已登记项目 · '+(mcpState==='REMOTE_CONNECTED'?'Core 控制平面握手成功；权限仍需批准':mcpState==='LOCAL_ONLY'?'本机 MCP 已启动，ChatGPT 尚未连接':'Core MCP 未连接/未授权'),
      detail:'选择项目目录不会授予 ChatGPT 对文件和终端的访问。\n'
       +'必须通过另行验证的 Core 插件身份、权限和工具发布门禁后才能操作本地项目。',
      buttons:['关闭']
    });
  };
  const menus: MenuItemConstructorOptions[] = [
    {label:'CoS Next',submenu:[{role:'quit'}]},
    {label:'目标',submenu:[
      {label:'打开 Goal / 计划工作台',accelerator:'CmdOrCtrl+Shift+G',click:()=>{void openGoalWorkbench();}},
      {label:'管理任务与恢复',click:()=>{void manageDurableTasks();}},
      {type:'separator'},
      {label:'查看限流暂停与恢复',click:()=>{void manageRateLimit();}},
      {label:'检查连续工作准备状态',click:()=>{void inspectContinuity();}}
    ]},
    {label:'本地项目',submenu:[
      {label:'连接现有 ChatGPT Core Tunnel（需批准）',click:()=>{void connectRemoteCore();}},
      {label:'断开 ChatGPT Core Tunnel',click:()=>{void disconnectRemoteCore().catch(()=>undefined);}},
      {type:'separator'},
      {label:'启用本机 Core MCP（需批准）',click:()=>{
        void enableNativeCore().catch(()=>undefined);
      }},
      {label:'关闭本机 MCP',click:()=>{void disableNativeCore().catch(()=>undefined);}},
      {type:'separator'},
      {label:'添加项目目录（仅本地登记）',click:()=>{void addProjectFromNativePicker();}},
      {label:'查看登记与 Core MCP 状态',click:()=>{void showLocalProjectStatus();}},
      {label:'核对 MCP 工具清单（仅本地）',click:()=>{void showCoreCatalogue();}},
      {type:'separator'},
      {label:'管理/撤销只读授权',click:()=>{void manageReadGrants();}},
      {label:'撤销全部只读授权',click:()=>{void revokeAllReadGrants();}},
      {label:'查看本地操作收据',click:()=>{void showOperations();}},
      {label:'Goal / 计划工作台（创建、编辑、恢复）',click:()=>{void openGoalWorkbench();}},
      {label:'P3 持久任务与恢复',click:()=>{void manageDurableTasks();}},
      {label:'在当前 ChatGPT 网页续接任务一次（需确认）',click:()=>{void continueTaskOneNativeTurn();}},
      {label:'开始/停止当前对话连续工作观察（不自动发送）',click:()=>{void armContinuityObservation();}},
      {label:'检查连续工作安全门禁',click:()=>{void inspectContinuity();}},
      {label:'限流暂停与恢复（保留任务）',click:()=>{void manageRateLimit();}},
      {label:'开始/停止当前 ChatGPT 回复记录',click:()=>{void toggleReplyCapture();}},
      {label:'查看已接收的 ChatGPT 最新回复',click:()=>{void inspectCapturedReplies();}},
      {type:'separator'},
      {label:'显示/隐藏项目侧栏',accelerator:'CmdOrCtrl+Shift+P',click:()=>{
        sidebarVisible=!sidebarVisible;resize();
      }}
    ]},
    {label:'ChatGPT 网页',submenu:[
      {label:'检查网页健康状态',click:()=>{void showDiagnostics();}},
      {label:'重新加载网页',accelerator:'CmdOrCtrl+R',click:()=>{
        hideRecoveryOverlay();pageRecovery.navigate(Date.now());view.webContents.reload();
      }},
      {label:'安全重新加载网页（保留登录）',click:()=>{
        if(!view.webContents.isDestroyed()){
          hideRecoveryOverlay();pageRecovery.navigate(Date.now());
          view.webContents.reloadIgnoringCache();
        }
      }},
      {label:'返回',accelerator:'Alt+Left',click:()=>{if(view.webContents.navigationHistory.canGoBack())view.webContents.navigationHistory.goBack();}},
      {label:'前进',accelerator:'Alt+Right',click:()=>{if(view.webContents.navigationHistory.canGoForward())view.webContents.navigationHistory.goForward();}}
    ]}
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(menus));
  resize();
  const url=offline?'data:text/html;charset=utf-8,'+encodeURIComponent('<!doctype html><html><body><input id="native-smoke-input" contenteditable="true" style="position:fixed;left:40px;top:40px;height:30px;width:220px"><article data-message-author-role="assistant" data-message-id="offline-assistant-1">COS_WEBFIRST_OFFLINE_ASSISTANT_REPLY_OK</article><script>document.getElementById("native-smoke-input").addEventListener("keydown",function(event){if(event.key==="Enter"){event.preventDefault();let row=document.createElement("article");row.setAttribute("data-message-author-role","user");row.textContent=this.value;document.body.appendChild(row);this.value="";}});</script></body></html>'):CHATGPT_START_URL;
  void view.webContents.loadURL(url).catch(()=>{
    // 'did-fail-load' owns the error code; never log full URL or auth redirect.
    if(status.state!=='load-failed')status.state='load-failed';
  });
  const testGoalWorkbenchOffline=async():Promise<boolean>=>{
    if(!offline||owner.isDestroyed())throw Error('GOAL_SMOKE_ONLY_OFFLINE');
    await openGoalWorkbench();
    const window=goalWindow;
    if(!window||window.isDestroyed())return false;
    const before=await taskLedger.list();
    const fixtureProject=(await projects.list())[0];
    if(!fixtureProject)return false;
    // The native test drives the sandboxed JavaScript-disabled form. It does
    // not access the real ChatGPT page or any actual user workspace.
    const wc=window.webContents;
    let attached=false;
    try{
      wc.debugger.attach('1.3');attached=true;
      const root=(await wc.debugger.sendCommand('DOM.getDocument',{depth:-1})) as {
        root:{nodeId:number}};
      const point=async(selector:string)=>{
        const node=(await wc.debugger.sendCommand('DOM.querySelector',{
          nodeId:root.root.nodeId,selector})) as {nodeId:number};
        if(!node.nodeId)throw Error('GOAL_FORM_ELEMENT_MISSING');
        const box=(await wc.debugger.sendCommand('DOM.getBoxModel',{nodeId:node.nodeId})) as {
          model:{content:number[]}};
        const [x1,y1,x2,y2,x3,y3,x4,y4]=box.model.content;
        return {x:((x1??0)+(x2??0)+(x3??0)+(x4??0))/4,
          y:((y1??0)+(y2??0)+(y3??0)+(y4??0))/4};
      };
      const click=async(selector:string)=>{
        const {x,y}=await point(selector);
        await wc.debugger.sendCommand('Input.dispatchMouseEvent',{
          type:'mousePressed',x,y,button:'left',clickCount:1});
        await wc.debugger.sendCommand('Input.dispatchMouseEvent',{
          type:'mouseReleased',x,y,button:'left',clickCount:1});
      };
      await click('textarea[name="goal"]');
      await wc.debugger.sendCommand('Input.insertText',{text:'OFFLINE_NATIVE_GOAL_FORM_PASS'});
      await click('textarea[name="steps"]');
      await wc.debugger.sendCommand('Input.insertText',{
        text:'[>] Verify native goal\n[ ] Review checkpoint'});
      await click('form[action$="create"] button[type="submit"]');
    }catch{
      process.stderr.write('WEB_FIRST_OFFLINE_GOAL_NATIVE_INPUT_FAILED\n');return false;
    }finally{if(attached&&wc.debugger.isAttached())wc.debugger.detach();}
    let found=false;
    for(let i=0;i<18;i++){
      await new Promise(resolve=>setTimeout(resolve,150));
      const tasks=await taskLedger.list();
      const task=tasks.find(t=>t.goal==='OFFLINE_NATIVE_GOAL_FORM_PASS');
      if(task){const plan=await planLedger.status(task.id);
        found=tasks.length===before.length+1&&plan?.steps.length===2;
        if(found)break;
      }
    }
    if(!found)process.stderr.write('WEB_FIRST_OFFLINE_GOAL_FORM_DID_NOT_PERSIST\n');
    if(found){
      // A second real native click must update the persisted plan, without
      // executing a tool, invoking a model, or completing the parent task.
      let advanced=false,attachedAgain=false;
      try{
        wc.debugger.attach('1.3');attachedAgain=true;
        const root=(await wc.debugger.sendCommand('DOM.getDocument',{depth:-1})) as {
          root:{nodeId:number}};
        const target=(await wc.debugger.sendCommand('DOM.querySelector',{
          nodeId:root.root.nodeId,selector:'form[action$="advance"] button'})) as {nodeId:number};
        if(!target.nodeId)throw Error('GOAL_ADVANCE_BUTTON_NOT_RENDERED');
        await wc.debugger.sendCommand('DOM.scrollIntoViewIfNeeded',{nodeId:target.nodeId});
        const rect=(await wc.debugger.sendCommand('DOM.getBoxModel',{nodeId:target.nodeId})) as {
          model:{content:number[]}};
        const points=rect.model.content;
        const x=((points[0]??0)+(points[2]??0)+(points[4]??0)+(points[6]??0))/4;
        const y=((points[1]??0)+(points[3]??0)+(points[5]??0)+(points[7]??0))/4;
        await wc.debugger.sendCommand('Input.dispatchMouseEvent',{
          type:'mousePressed',x,y,button:'left',clickCount:1});
        await wc.debugger.sendCommand('Input.dispatchMouseEvent',{
          type:'mouseReleased',x,y,button:'left',clickCount:1});
        for(let i=0;i<18;i++){
          await new Promise(resolve=>setTimeout(resolve,120));
          const task=(await taskLedger.list()).find(t=>t.goal==='OFFLINE_NATIVE_GOAL_FORM_PASS');
          if(!task)continue;
          const plan=await planLedger.status(task.id);
          if(plan?.steps[0]?.status==='completed'&&plan.steps[1]?.status==='in_progress'&&
            task.phase==='active') {advanced=true;break;}
        }
      }catch{process.stderr.write('WEB_FIRST_OFFLINE_GOAL_ADVANCE_NATIVE_INPUT_FAILED\n');}
      finally{if(attachedAgain&&wc.debugger.isAttached())wc.debugger.detach();}
      if(!advanced)found=false;
      else process.stdout.write('WEB_FIRST_OFFLINE_GOAL_STEP_ADVANCE_PASS\n');
    }
    if(found){
      // P3.4 native fixture: click actual no-JavaScript diagnostic approval form
      // and verify the persisted local completion receipt, not a model claim.
      let checked=false,attachedCheck=false;
      try{
        await new Promise(resolve=>setTimeout(resolve,250));
        wc.debugger.attach('1.3');attachedCheck=true;
        const root=(await wc.debugger.sendCommand('DOM.getDocument',{depth:-1})) as {
          root:{nodeId:number}};
        const target=(await wc.debugger.sendCommand('DOM.querySelector',{
          nodeId:root.root.nodeId,selector:'form[action$="local-check"] button[value="root-check"]'})) as {nodeId:number};
        if(!target.nodeId)throw Error('LOCAL_JOB_BUTTON_MISSING');
        await wc.debugger.sendCommand('DOM.scrollIntoViewIfNeeded',{nodeId:target.nodeId});
        const bounds=(await wc.debugger.sendCommand('DOM.getBoxModel',{nodeId:target.nodeId})) as {
          model:{content:number[]}};
        const pts=bounds.model.content;
        const x=((pts[0]??0)+(pts[2]??0)+(pts[4]??0)+(pts[6]??0))/4;
        const y=((pts[1]??0)+(pts[3]??0)+(pts[5]??0)+(pts[7]??0))/4;
        await wc.debugger.sendCommand('Input.dispatchMouseEvent',{
          type:'mousePressed',x,y,button:'left',clickCount:1});
        await wc.debugger.sendCommand('Input.dispatchMouseEvent',{
          type:'mouseReleased',x,y,button:'left',clickCount:1});
        for(let i=0;i<24;i++){
          await new Promise(resolve=>setTimeout(resolve,125));
          const job=(await localJobs.list()).find(j=>j.kind==='root-check'&&j.state==='succeeded');
          if(job){
            const task=await taskLedger.get(job.taskId);
            if(task.goal==='OFFLINE_NATIVE_GOAL_FORM_PASS'&&task.phase==='active'&&
              job.outputDigest&&job.exitCode===0){checked=true;break;}
          }
        }
      }catch{process.stderr.write('WEB_FIRST_OFFLINE_LOCAL_JOB_NATIVE_INPUT_FAILED\n');}
      finally{if(attachedCheck&&wc.debugger.isAttached())wc.debugger.detach();}
      if(!checked)found=false;
      else process.stdout.write('WEB_FIRST_OFFLINE_LOCAL_JOB_APPROVED_EXECUTED_PASS\n');
    }
    if(!window.isDestroyed())window.close();
    return found;
  };
  const testRecoveryOverlayOffline=async():Promise<boolean>=>{
    if(!offline||owner.isDestroyed())throw Error('RECOVERY_TEST_ONLY_OFFLINE');
    pageRecovery.renderFailure(-105);
    showRecoveryOverlay();
    await new Promise(resolve=>setTimeout(resolve,350));
    const ok=!!recoveryOverlay&&!recoveryOverlay.webContents.isDestroyed()&&
      owner.contentView.children.includes(recoveryOverlay)&&
      recoveryOverlay.getBounds().width>100&&recoveryOverlay.getBounds().height>100;
    hideRecoveryOverlay();pageRecovery.clearIssue();
    return ok;
  };
  return {window:owner,status:()=>({...status}),reload:()=>view.webContents.reload(),diagnostics,
    nativeProjects:()=>projects.list(),enableNativeCore,disableNativeCore,
    getCorePosture:()=>mcpState,snapshotVisibleAssistant,
    ...(offline?{testRecoveryOverlayOffline,testGoalWorkbenchOffline}:{})};
}
