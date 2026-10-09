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
import {newWebHealthTracker, type WebHealthSnapshot} from './web-health.js';
import {allowedOAuthStoragePermission,allowedOAuthPopup} from './login-permissions.js';
import {WebFirstProjectRegistry, type WebFirstProject} from './project-registry.js';
import {renderProjectSidebar} from './project-sidebar.js';
import {WebFirstReadAuthority, type ReadAction, type NativeReadApproval} from './project-read.js';
import {WebFirstReadGrants,isSensitiveProjectPath} from './read-grants.js';
import {WebFirstOperationJournal} from './operation-journal.js';
import {WebFirstTaskLedger} from './task-ledger.js';
import {WebFirstTaskTools} from './task-tools.js';
import {conversationFromUrl,VISIBLE_REPLY_SCRIPT,WebReplySettleTracker,WebFirstReplyJournal,type VisibleWebReply} from './web-reply-observer.js';
import {createWebFirstCoreLoopback} from './core-loopback.js';
import {readWebFirstLocalToolList,EXPECTED_READ_ONLY_CORE_TOOLS} from './core-catalogue.js';
import {connectWebFirstImportedCore,type CoreTunnelState} from './core-transport.js';

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
  webSession.webRequest.onCompleted(details=>{if(details.webContentsId)health.completed(details.url,details.statusCode);});
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
  const taskLedger=new WebFirstTaskLedger(options.projectStoreDir);
  const webReplies=new WebFirstReplyJournal(options.projectStoreDir);
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
  let approvals:Promise<unknown>=Promise.resolve();
  let mcpService:Awaited<ReturnType<typeof createWebFirstCoreLoopback>>|null=null;
  let mcpStartFlight:Promise<{endpointUrl:string;port:number}>|null=null;
  let mcpState:'UNCONNECTED'|'LOCAL_ONLY'|'REMOTE_CONNECTING'|'REMOTE_CONNECTED'|'HOLD'='UNCONNECTED';
  let coreTunnel:Awaited<ReturnType<typeof connectWebFirstImportedCore>>|null=null;
  let remoteConnectionFlight:Promise<void>|null=null;
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
    if(closingForTunnelStop||owner.isDestroyed()||sidebar.webContents.isDestroyed())return;
    await sidebar.webContents.loadURL('data:text/html;charset=utf-8,'+
      encodeURIComponent(renderProjectSidebar(cachedProjects,state,registryError,grantSummary)));
  };
  const headerHeight = 48;
  const sidebarWidth=268;
  const resize = () => {
    if (owner.isDestroyed()) return;
    const size = owner.getContentSize();
    const w=size[0]??1, h=size[1]??1, x=sidebarVisible?sidebarWidth:0;
    sidebar.setBounds({x:0,y:headerHeight,width:sidebarVisible?sidebarWidth:0,height:Math.max(1,h-headerHeight)});
    view.setBounds({x,y:headerHeight,width:Math.max(1,w-x),height:Math.max(1,h-headerHeight)});
  };
  void refreshSidebar();
  owner.on('resize',resize);
  owner.on('enter-full-screen',resize);
  owner.on('leave-full-screen',resize);
  owner.once('ready-to-show',()=>{resize();if(!owner.isDestroyed())owner.show();});
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
    void disableNativeCore().catch(()=>undefined);
    // BaseWindow-based children must be explicitly closed; do not leave a web
    // renderer process keeping an authenticated session alive after its owner.
    if(!view.webContents.isDestroyed())view.webContents.close();
    if(!sidebar.webContents.isDestroyed())sidebar.webContents.close();
  });
  const toolbar = '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'">'+
    '<style>body{margin:0;background:#121820;color:#f1f5f9;font:13px system-ui;padding:14px 18px}strong{color:#9ad3ff}small{margin-left:12px;color:#b5bbc6}</style>'+
    '<strong>CoS Next · Web-First</strong><small>ChatGPT 官方网页 · 原生项目侧栏 · 独立 MCP · 不使用 Chrome 扩展</small>';
  void owner.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(toolbar));
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
    options.onNavigationOutcome?.({...status});
  });
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
    await dialog.showMessageBox(owner,{
      type:'info',title:'CoS Next · Web-First 安全诊断',
      message:'网页状态（不读取 Cookie 或聊天正文）',
      detail:JSON.stringify({navigation:status,...snap},null,2),
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
          project_read:'读取项目内文件正文（上限 32 KiB）'
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
  async function enableNativeCore():Promise<{endpointUrl:string;port:number}>{
    if(mcpStartFlight)return mcpStartFlight;
    if(mcpService)return {endpointUrl:mcpService.endpointUrl,port:mcpService.port};
    const work=async()=>{
      if(!offline){
        if(owner.isDestroyed())throw Error('WEBFIRST_WINDOW_CLOSED');
        const consent=await dialog.showMessageBox(owner,{
          type:'warning',title:'启用本机只读 MCP 服务',
          message:'仅在此 Mac 启动一个本地只读 MCP 服务？',
          detail:'此步骤不会连接 ChatGPT 插件，也不会自动授权任何项目。\n'
            +'项目列表、目录和文件读取仍需每次由你在 macOS 原生弹窗批准。\n'
            +'禁止写入、终端执行和自动任务。',
          buttons:['取消','启用本地服务'],defaultId:0,cancelId:0,noLink:true
        });
        if(consent.response!==1)throw Error('WEBFIRST_CORE_NOT_APPROVED');
      }
      const authority=new WebFirstReadAuthority(projects,approveScopedRead);
      const created=await createWebFirstCoreLoopback(authority,journal,taskTools);
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
    if(remoteConnectionFlight)await remoteConnectionFlight.catch(()=>undefined);
    if(!coreTunnel)return;
    const target=coreTunnel;
    const proven=await target.stopWithProof();
    if(!proven){mcpState='HOLD';await refreshSidebar();
      throw Error('CORE_TUNNEL_SHUTDOWN_UNVERIFIED');}
    coreTunnel=null;mcpState='LOCAL_ONLY';
    await refreshSidebar();
  }
  async function connectRemoteCore():Promise<void>{
    if(offline)throw Error('NO_REMOTE_IN_OFFLINE_SMOKE');
    if(coreTunnel||remoteConnectionFlight)return;
    const local=await enableNativeCore();
    if(owner.isDestroyed())throw Error('WEBFIRST_WINDOW_CLOSED');
    const consent=await dialog.showMessageBox(owner,{
      type:'warning',title:'连接现有 ChatGPT Core Tunnel',
      message:'从原有 Next 加密配置连接 ChatGPT Core？',
      detail:'这只复用现有 Next 的 Tunnel 登记与系统 Keychain，不复制凭证、不调用模型。\n'
        +'文件仍然每次单独请求 macOS 批准。\n'
        +'远端 ChatGPT 工具注册和会话身份必须另行验收；连接不等于授权。',
      buttons:['取消','连接 Core'],defaultId:0,cancelId:0,noLink:true
    });
    if(consent.response!==1)return;
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
        mcpState='REMOTE_CONNECTED';await refreshSidebar();
      }catch(error){
        mcpState='HOLD';await refreshSidebar();throw error;
      }
    })();
    try{await remoteConnectionFlight;}
    catch(error){
      if(!owner.isDestroyed())await dialog.showMessageBox(owner,{
        type:'warning',title:'Core 连接尚未通过验收',
        message:'无法确认当前 Core Tunnel 完成了真实握手。',
        detail:'既有凭证和 Classic 配置未被复制或清空。\n原因：'+
          (error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:'连接条件不满足'),
        buttons:['关闭']
      });
    }finally{remoteConnectionFlight=null;}
  }
  async function disableNativeCore():Promise<void>{
    await disconnectRemoteCore();
    if(mcpStartFlight)await mcpStartFlight.catch(()=>undefined);
    const current=mcpService;
    mcpService=null;mcpState='UNCONNECTED';
    if(current)await current.close();
    if(!owner.isDestroyed())await refreshSidebar();
  }
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
    {label:'本地项目',submenu:[
      {label:'连接现有 ChatGPT Core Tunnel（需批准）',click:()=>{void connectRemoteCore();}},
      {label:'断开 ChatGPT Core Tunnel',click:()=>{void disconnectRemoteCore().catch(()=>undefined);}},
      {type:'separator'},
      {label:'启用本机只读 MCP（需批准）',click:()=>{
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
      {label:'P3 持久任务与恢复',click:()=>{void manageDurableTasks();}},
      {label:'开始/停止当前 ChatGPT 回复记录',click:()=>{void toggleReplyCapture();}},
      {label:'查看已接收的 ChatGPT 最新回复',click:()=>{void inspectCapturedReplies();}},
      {type:'separator'},
      {label:'显示/隐藏项目侧栏',accelerator:'CmdOrCtrl+Shift+P',click:()=>{
        sidebarVisible=!sidebarVisible;resize();
      }}
    ]},
    {label:'ChatGPT 网页',submenu:[
      {label:'检查网页健康状态',click:()=>{void showDiagnostics();}},
      {label:'重新加载网页',accelerator:'CmdOrCtrl+R',click:()=>view.webContents.reload()},
      {label:'返回',accelerator:'Alt+Left',click:()=>{if(view.webContents.navigationHistory.canGoBack())view.webContents.navigationHistory.goBack();}},
      {label:'前进',accelerator:'Alt+Right',click:()=>{if(view.webContents.navigationHistory.canGoForward())view.webContents.navigationHistory.goForward();}}
    ]}
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(menus));
  resize();
  const url=offline?'data:text/html;charset=utf-8,'+encodeURIComponent('<!doctype html><html><body><input id="native-smoke-input" contenteditable="true" style="position:fixed;left:40px;top:40px;height:30px;width:220px"><article data-message-author-role="assistant" data-message-id="offline-assistant-1">COS_WEBFIRST_OFFLINE_ASSISTANT_REPLY_OK</article></body></html>'):CHATGPT_START_URL;
  void view.webContents.loadURL(url).catch(()=>{
    // 'did-fail-load' owns the error code; never log full URL or auth redirect.
    if(status.state!=='load-failed')status.state='load-failed';
  });
  return {window:owner,status:()=>({...status}),reload:()=>view.webContents.reload(),diagnostics,
    nativeProjects:()=>projects.list(),enableNativeCore,disableNativeCore,getCorePosture:()=>mcpState,snapshotVisibleAssistant};
}
