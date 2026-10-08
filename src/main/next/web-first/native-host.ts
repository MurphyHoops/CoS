/**
 * Electron-owned ChatGPT web surface, not a Chrome extension or an inference API.
 * P1 deliberately presents the real site; it neither inspects replies nor drives
 * the ChatGPT composer. P2 must use separately authenticated, approved MCP tools.
 */
import {
  BrowserWindow, Menu, WebContentsView, session,
  type MenuItemConstructorOptions
} from 'electron';
import {
  CHATGPT_START_URL, WEB_FIRST_PARTITION, isAllowedWebFirstNavigation,
  classifyWebFirstNavigation
} from './host-policy.js';

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
}
export function launchNextWebFirstHost(options: {
  /** Only a fixture launch may use data URLs; the production path is fixed. */
  offlineSmoke?: boolean;
  onOfflineLoaded?: () => void;
  /** HTTPS P1 smoke emits status categories only; never page content/cookies. */
  onNavigationOutcome?: (state: Readonly<NativeWebHostStatus>) => void;
} = {}): NativeWebHost {
  const offline = options.offlineSmoke === true;
  const webSession = session.fromPartition(WEB_FIRST_PARTITION);
  // Explicit denial instead of inheriting permissions from unrelated CoS tools.
  webSession.setPermissionRequestHandler((_webContents, _permission, done) => done(false));
  webSession.setPermissionCheckHandler(() => false);
  webSession.on('will-download', event => event.preventDefault());
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
  owner.contentView.addChildView(view);
  const headerHeight = 48;
  const resize = () => {
    if (owner.isDestroyed()) return;
    const size = owner.getContentSize();
    const w=size[0]??1, h=size[1]??1;
    view.setBounds({x:0,y:headerHeight,width:w,height:Math.max(1,h-headerHeight)});
  };
  owner.on('resize',resize);
  owner.on('enter-full-screen',resize);
  owner.on('leave-full-screen',resize);
  owner.once('ready-to-show',()=>{resize();if(!owner.isDestroyed())owner.show();});
  owner.on('closed',()=>{
    // BaseWindow-based children must be explicitly closed; do not leave a web
    // renderer process keeping an authenticated session alive after its owner.
    if(!view.webContents.isDestroyed())view.webContents.close();
  });
  const toolbar = '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'">'+
    '<style>body{margin:0;background:#121820;color:#f1f5f9;font:13px system-ui;padding:14px 18px}strong{color:#9ad3ff}small{margin-left:12px;color:#b5bbc6}</style>'+
    '<strong>CoS Next · Web-First</strong><small>ChatGPT 官方网页 · 独立登录空间 · 不加载 Chrome 扩展 · P1 预览</small>';
  void owner.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(toolbar));
  owner.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  owner.webContents.on('will-navigate',e=>e.preventDefault());
  owner.webContents.on('will-attach-webview',e=>e.preventDefault());

  view.webContents.setWindowOpenHandler(()=>({action:'deny'}));
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
    if(offline){status.location='offline-test';options.onOfflineLoaded?.();}
    else status.location=classifyWebFirstNavigation(view.webContents.getURL());
    options.onNavigationOutcome?.({...status});
  });
  view.webContents.on('did-fail-load',(_event,code,isMainFrame)=>{
    if(!isMainFrame || code===-3)return; // ordinary redirect cancellation
    status.state='load-failed'; status.lastErrorCode=code;
    options.onNavigationOutcome?.({...status});
  });
  const menus: MenuItemConstructorOptions[] = [
    {label:'CoS Next',submenu:[{role:'quit'}]},
    {label:'ChatGPT 网页',submenu:[
      {label:'重新加载网页',accelerator:'CmdOrCtrl+R',click:()=>view.webContents.reload()},
      {label:'返回',accelerator:'Alt+Left',click:()=>{if(view.webContents.navigationHistory.canGoBack())view.webContents.navigationHistory.goBack();}},
      {label:'前进',accelerator:'Alt+Right',click:()=>{if(view.webContents.navigationHistory.canGoForward())view.webContents.navigationHistory.goForward();}}
    ]}
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(menus));
  resize();
  const url=offline?'data:text/html,webfirst-offline':CHATGPT_START_URL;
  void view.webContents.loadURL(url).catch(()=>{
    // 'did-fail-load' owns the error code; never log full URL or auth redirect.
    if(status.state!=='load-failed')status.state='load-failed';
  });
  return {window:owner,status:()=>({...status}),reload:()=>view.webContents.reload()};
}
