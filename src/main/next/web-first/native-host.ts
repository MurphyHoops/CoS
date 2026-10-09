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
}
export function launchNextWebFirstHost(options: {
  /** Only a fixture launch may use data URLs; the production path is fixed. */
  offlineSmoke?: boolean;
  /** Entirely native and isolated from the ChatGPT partition. */
  projectStoreDir:string;
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
  let sidebarVisible=true;
  let cachedProjects:ReadonlyArray<WebFirstProject>=[];
  const refreshSidebar=async()=>{
    let state:'UNCONNECTED'|'HOLD'='UNCONNECTED';
    try{cachedProjects=await projects.list();}
    catch{state='HOLD';cachedProjects=[];}
    if(sidebar.webContents.isDestroyed())return;
    await sidebar.webContents.loadURL('data:text/html;charset=utf-8,'+
      encodeURIComponent(renderProjectSidebar(cachedProjects,state)));
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
  owner.on('closed',()=>{
    // BaseWindow-based children must be explicitly closed; do not leave a web
    // renderer process keeping an authenticated session alive after its owner.
    if(!view.webContents.isDestroyed())view.webContents.close();
    if(!sidebar.webContents.isDestroyed())sidebar.webContents.close();
  });
  const toolbar = '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'">'+
    '<style>body{margin:0;background:#121820;color:#f1f5f9;font:13px system-ui;padding:14px 18px}strong{color:#9ad3ff}small{margin-left:12px;color:#b5bbc6}</style>'+
    '<strong>CoS Next · Web-First</strong><small>ChatGPT 官方网页 · 独立登录空间 · 不加载 Chrome 扩展 · P1 预览</small>';
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
      message:list.length+' 个已登记项目 · Core MCP 未连接/未授权',
      detail:'选择项目目录不会授予 ChatGPT 对文件和终端的访问。\n'
       +'必须通过另行验证的 Core 插件身份、权限和工具发布门禁后才能操作本地项目。',
      buttons:['关闭']
    });
  };
  const menus: MenuItemConstructorOptions[] = [
    {label:'CoS Next',submenu:[{role:'quit'}]},
    {label:'本地项目',submenu:[
      {label:'添加项目目录（仅本地登记）',click:()=>{void addProjectFromNativePicker();}},
      {label:'查看登记与 Core MCP 状态',click:()=>{void showLocalProjectStatus();}},
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
  const url=offline?'data:text/html;charset=utf-8,'+encodeURIComponent('<!doctype html><html><body><input id="native-smoke-input" style="position:fixed;left:40px;top:40px;height:30px;width:220px"></body></html>'):CHATGPT_START_URL;
  void view.webContents.loadURL(url).catch(()=>{
    // 'did-fail-load' owns the error code; never log full URL or auth redirect.
    if(status.state!=='load-failed')status.state='load-failed';
  });
  return {window:owner,status:()=>({...status}),reload:()=>view.webContents.reload(),diagnostics,
    nativeProjects:()=>projects.list()};
}
