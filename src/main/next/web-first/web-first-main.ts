/** Standalone opt-in P1 preview. Does not import Classic Bridge, Chrome, Codex or inference. */
import {app,Menu} from 'electron';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {WebFirstProjectRegistry} from './project-registry.js';
import os from 'node:os';
import path from 'node:path';
import {launchNextWebFirstHost} from './native-host.js';
const offlineSmoke=process.env.COS_NEXT_WEBFIRST_OFFLINE_SMOKE==='1';
const httpsSmoke=process.env.COS_NEXT_WEBFIRST_HTTPS_SMOKE==='1';
// P1 uses an isolated app profile; never inherits old CoS/Next userData or cookies.
const smokeRoot=(offlineSmoke||httpsSmoke)?mkdtempSync(path.join(os.tmpdir(),'cos-next-webfirst-p1-')):null;
const profile=smokeRoot ?? path.join(app.getPath('appData'),'chat-on-steroids-next-webfirst-preview');
mkdirSync(profile,{recursive:true,mode:0o700});
app.setPath('userData',profile);
app.setName('CoS Next Web-First Preview');
if(!app.requestSingleInstanceLock())app.quit();
let quitting=false;
app.whenReady().then(async()=>{
  if(quitting)return;
  if(offlineSmoke && smokeRoot){
    // Native packaged regression: a synthetic project is registered only in
    // the disposable smoke root and never granted any MCP authority.
    const syntheticProject=path.join(smokeRoot,'offline-project');
    mkdirSync(syntheticProject,{mode:0o700});
    const store=new WebFirstProjectRegistry(profile);
    const project=await store.register(syntheticProject);
    await import('node:fs/promises').then(fs=>fs.writeFile(path.join(syntheticProject,'fixture.txt'),'WEBFIRST_LOCAL_MCP_READ_OK'));
    const restored=await new WebFirstProjectRegistry(profile).list();
    if(restored.length!==1 || restored[0]?.id!==project.id)
      throw new Error('WEBFIRST_OFFLINE_PROJECT_RESTORE_FAILED');
    process.stdout.write('WEB_FIRST_OFFLINE_PROJECT_RESTORED\n');
  }
  let httpsReported=false;
  const smokeTimeout=httpsSmoke?setTimeout(()=>{
    process.stdout.write('WEB_FIRST_HTTPS_TIMEOUT\n'); app.quit();
  },25000):null;
  const host=launchNextWebFirstHost({offlineSmoke,projectStoreDir:profile,appDataDir:app.getPath('appData'),onNavigationOutcome:state=>{
    if(!httpsSmoke||httpsReported)return;
    httpsReported=true;
    if(smokeTimeout)clearTimeout(smokeTimeout);
    process.stdout.write('WEB_FIRST_HTTPS_OUTCOME='+JSON.stringify(state)+'\n');
    setImmediate(()=>app.quit());
  },onOfflineLoaded:async contents=>{
    if(!offlineSmoke)return;
    try{
      // Real Chromium input dispatch into the offline WebContentsView, never a
      // ChatGPT document or a web account. No model turn is created.
      contents.debugger.attach('1.3');
      await new Promise(resolve=>setTimeout(resolve,150));
      await contents.debugger.sendCommand('Input.dispatchMouseEvent',{
        type:'mousePressed',x:75,y:55,button:'left',clickCount:1});
      await contents.debugger.sendCommand('Input.dispatchMouseEvent',{
        type:'mouseReleased',x:75,y:55,button:'left',clickCount:1});
      await contents.debugger.sendCommand('Input.insertText',{text:'COS_OFFLINE_NATIVE_INPUT'});
      const result=await contents.executeJavaScript(`document.querySelector('#native-smoke-input')?.value`);
      contents.debugger.detach();
      if(result!=='COS_OFFLINE_NATIVE_INPUT')throw Error('OFFLINE_NATIVE_INPUT_MISMATCH');
      if((await host.nativeProjects()).length!==1)
        throw Error('WEBFIRST_OFFLINE_PROJECT_UI_NOT_AVAILABLE');
      const menus=Menu.getApplicationMenu()?.items??[];
      const projectMenu=menus.find(item=>item.label==='本地项目');
      if(!projectMenu?.submenu || projectMenu.submenu.items.length<3 ||
         !projectMenu.submenu.items.some(item=>item.label.startsWith('添加项目目录')))
        throw Error('WEBFIRST_NATIVE_PROJECT_MENU_MISSING');
      const local=await host.enableNativeCore();
      const headers={'content-type':'application/json',accept:'application/json, text/event-stream',
        'MCP-Protocol-Version':'2026-07-28','Mcp-Method':'tools/call','Mcp-Name':'project_read'};
      const body={jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'project_read',
        arguments:{project_id:(await host.nativeProjects())[0]?.id,relative_path:'fixture.txt'},
        _meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28',
          'io.modelcontextprotocol/clientCapabilities':{}}}};
      const response=await fetch(local.endpointUrl,{method:'POST',headers,body:JSON.stringify(body)});
      const raw=await response.text();
      if(response.status!==200||!raw.includes('WEBFIRST_LOCAL_MCP_READ_OK'))
        throw Error('WEBFIRST_LOCAL_MCP_SMOKE_FAILED');
      await host.disableNativeCore();
      process.stdout.write('WEB_FIRST_OFFLINE_LOCAL_MCP_PASS\n');
      process.stdout.write('WEB_FIRST_OFFLINE_PROJECT_MENU_PASS\n');
      process.stdout.write('WEB_FIRST_OFFLINE_PROJECT_UI_PASS\n');
      process.stdout.write('WEB_FIRST_OFFLINE_INPUT_PASS\n');
      process.stdout.write('WEB_FIRST_OFFLINE_VIEW_READY\n');
      setImmediate(()=>app.quit());
    }catch{
      process.stderr.write('WEB_FIRST_OFFLINE_INPUT_FAILED\n');
      app.exit(3);
    }
  }});
  host.window.on('closed',()=>{if(!quitting)app.quit();});
  if(process.env.COS_NEXT_WEBFIRST_DIAG_ONCE==='1'){
    for(const delay of [6000,18000,32000]){
      setTimeout(()=>{
        void host.diagnostics().then(snapshot=>{
          // Includes only status tallies, button counts and standardized network errors.
          process.stdout.write('WEB_FIRST_SAFE_DIAG='+JSON.stringify({elapsedMs:delay, ...snapshot})+'\n');
        }).catch(()=>{process.stdout.write('WEB_FIRST_SAFE_DIAG_UNAVAILABLE\n');});
      },delay).unref();
    }
  }
  if(!offlineSmoke){
    // Readiness is merely navigation visibility; it does NOT prove ChatGPT
    // account sign-in, available models or any MCP tool registration.
    process.stdout.write('WEB_FIRST_NATIVE_VIEW_CREATED\n');
  }
}).catch(()=>{process.stderr.write('WEB_FIRST_STARTUP_FAILED\n');app.exit(1);});
app.on('before-quit',()=>{quitting=true;});
app.on('will-quit',()=>{if(smokeRoot)rmSync(smokeRoot,{recursive:true,force:true});});
