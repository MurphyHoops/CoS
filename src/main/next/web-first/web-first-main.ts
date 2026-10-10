/** Standalone opt-in P1 preview. Does not import Classic Bridge, Chrome, Codex or inference. */
import {app,Menu,BrowserWindow} from 'electron';
import {mkdtempSync,mkdirSync,rmSync,appendFileSync} from 'node:fs';
import {WebFirstProjectRegistry} from './project-registry.js';
import {WebFirstTaskLedger} from './task-ledger.js';
import {WebFirstPlanLedger} from './plan-ledger.js';
import {WebFirstLocalJobQueue} from './local-job-queue.js';
import {WebFirstReplyJournal} from './web-reply-observer.js';
import {WebFirstWebOutbox} from './web-outbox.js';
import {WebFirstRateLimitSupervisor} from './rate-limit-supervisor.js';
import {sendNativeWebFirstMessage} from './native-web-input.js';
import {runApprovedWebGoalLoop} from './approved-web-goal-loop.js';
import {ElectronWebRuntimeSupervisor} from '../../web-runtime/supervisor.js';
import {ActorPageRegistry} from '../../web-runtime/page-registry.js';
import {DeliveryJournal} from '../../web-runtime/delivery-journal.js';
import {ChatGPTWebsiteDelivery} from '../../web-runtime/chatgpt-website-delivery.js';
import {randomUUID,createHash} from 'node:crypto';
import {WebFirstReadGrants} from './read-grants.js';
import {WebFirstOperationJournal} from './operation-journal.js';
import {inspectExistingCredentialProfiles} from './credential-diagnostics.js';
import {runWebFirstCoreBroker} from './core-broker.js';
import os from 'node:os';
import path from 'node:path';
import {launchNextWebFirstHost} from './native-host.js';
const offlineSmoke=process.env.COS_NEXT_WEBFIRST_OFFLINE_SMOKE==='1';
const httpsSmoke=process.env.COS_NEXT_WEBFIRST_HTTPS_SMOKE==='1';
const alternateKeychainProbe=process.env.COS_NEXT_WEBFIRST_PROBE_NEXT_KEYCHAIN==='1';
const coreBroker=process.env.COS_NEXT_WEBFIRST_CORE_BROKER==='1';
// P1 uses an isolated app profile; never inherits old CoS/Next userData or cookies.
const smokeRoot=(offlineSmoke||httpsSmoke||coreBroker)?mkdtempSync(path.join(os.tmpdir(),'cos-next-webfirst-p1-')):null;
const profile=smokeRoot ?? path.join(app.getPath('appData'),'chat-on-steroids-next-webfirst-preview');
mkdirSync(profile,{recursive:true,mode:0o700});
app.setPath('userData',profile);
app.setName(alternateKeychainProbe||coreBroker?'Chat On Steroids Next':'CoS Next Web-First Preview');
if(!coreBroker&&!app.requestSingleInstanceLock())app.quit();
let quitting=false;
app.whenReady().then(async()=>{
  if(quitting)return;
  if(coreBroker){await runWebFirstCoreBroker(app.getPath('appData'));return;}
  if(process.env.COS_NEXT_WEBFIRST_KEYCHAIN_PROBE==='1'||alternateKeychainProbe){
    const result=await inspectExistingCredentialProfiles(app.getPath('appData'));
    process.stdout.write('WEBFIRST_KEYCHAIN_PRECHECK='+JSON.stringify(result)+'\n');
    app.quit();return;
  }
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
    const grants=new WebFirstReadGrants(profile);
    await grants.grant('project-read',project.id,project.root,'always');
    const verified=new WebFirstReadGrants(profile);
    if(!await verified.allowed('project-read',project.id,project.root,
      path.join(project.root,'fixture.txt'),'project_read'))
      throw Error('WEB_FIRST_OFFLINE_DURABLE_GRANT_INVALID');
    await grants.revoke('project-read',project.id);
    if(await verified.allowed('project-read',project.id,project.root,
      path.join(project.root,'fixture.txt'),'project_read'))
      throw Error('WEB_FIRST_OFFLINE_GRANT_REVOCATION_INVALID');
    process.stdout.write('WEB_FIRST_OFFLINE_GRANT_LIFECYCLE_PASS\n');
    process.stdout.write('WEB_FIRST_OFFLINE_PROJECT_RESTORED\n');
  }
  // Never auto-continue a task after a crash/restart. User reviews it in
  // 本地项目 → P3 持久任务与恢复. An invalid ledger fails closed for task tools.
  try{
    const held=await new WebFirstTaskLedger(profile).holdInterruptedTasks();
    if(offlineSmoke)process.stdout.write('WEB_FIRST_OFFLINE_RECOVERY_HOLD='+held+'\n');
  }catch{
    if(offlineSmoke)throw Error('WEBFIRST_TASK_RECOVERY_LEDGER_FAILED');
  }
  // Native diagnostics likewise cannot silently retry a possibly interrupted
  // child. Reconcile receipts before the UI is exposed, never auto-run queued.
  try{
    const taskStore=new WebFirstTaskLedger(profile);
    const planStore=new WebFirstPlanLedger(profile,taskStore);
    const jobStore=new WebFirstLocalJobQueue(profile,taskStore,planStore,async()=>false);
    const held=await jobStore.holdInterrupted();
    if(offlineSmoke)process.stdout.write('WEB_FIRST_OFFLINE_LOCAL_JOBS_HELD='+held+'\n');
  }catch{if(offlineSmoke)throw Error('WEBFIRST_LOCAL_JOB_RECOVERY_FAILED');}
  // If an earlier process died around a browser send, never re-submit it.
  try{
    const uncertain=await new WebFirstWebOutbox(profile).holdUncertain();
    if(offlineSmoke)process.stdout.write('WEB_FIRST_OFFLINE_OUTBOX_RECOVERY_HOLD='+uncertain+'\n');
  }catch{if(offlineSmoke)throw Error('WEBFIRST_OUTBOX_RECOVERY_FAILED');}
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
      if(!host.window.isVisible()){
        await new Promise(resolve=>setTimeout(resolve,2900));
      }
      if(!host.window.isVisible())throw Error('WEBFIRST_OFFLINE_MAIN_WINDOW_NOT_VISIBLE');
      if(!await host.testRecoveryOverlayOffline?.())
        throw Error('WEBFIRST_OFFLINE_RECOVERY_OVERLAY_FAILED');
      process.stdout.write('WEB_FIRST_OFFLINE_RECOVERY_OVERLAY_PASS\n');
      process.stdout.write('WEB_FIRST_OFFLINE_MAIN_WINDOW_VISIBLE_PASS\n');
      if(!decodeURIComponent(host.window.webContents.getURL()).includes('⌘ ⇧ G'))
        throw Error('WEBFIRST_NATIVE_TOPBAR_NOT_RENDERED');
      process.stdout.write('WEB_FIRST_OFFLINE_NATIVE_TOPBAR_PASS\n');
      if(!await host.testGoalWorkbenchOffline?.())
        throw Error('WEBFIRST_OFFLINE_NATIVE_GOAL_FORM_FAILED');
      process.stdout.write('WEB_FIRST_OFFLINE_NATIVE_GOAL_FORM_PASS\n');
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
      const taskPayload=(name:string,args:Record<string,unknown>,id:number)=>({
        jsonrpc:'2.0',id,method:'tools/call',params:{name,arguments:args,
          _meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28',
            'io.modelcontextprotocol/clientCapabilities':{}}}
      });
      const taskCall=async(name:string,args:Record<string,unknown>,id:number)=>{
        const result=await fetch(local.endpointUrl,{method:'POST',headers:{...headers,'Mcp-Name':name},
          body:JSON.stringify(taskPayload(name,args,id))});
        if(result.status!==200)throw Error('WEBFIRST_OFFLINE_TASK_RPC_HTTP_FAILED');
        const text=await result.text();
        const event=text.startsWith('{')?text:
          [...text.matchAll(/^data: (\{.*\})$/gm)].at(-1)?.[1];
        if(!event)throw Error('WEBFIRST_OFFLINE_TASK_RPC_MISSING');
        const parsed=JSON.parse(event) as {result?:{structuredContent?:{result?:unknown}}};
        return parsed.result?.structuredContent?.result as {task_id:string;phase:string;revision:number};
      };
      const sample='WEBFIRST_LOCAL_MCP_READ_OK';
      const projectId=(await host.nativeProjects())[0]?.id;
      const found=await taskCall('project_find',{
        project_id:projectId,relative_path:'.',query:sample},24) as unknown as {
        results:Array<{path:string;line:number;kind:string}>};
      if(!found.results?.some(item=>item.path==='fixture.txt'&&item.line===1&&item.kind==='content'))
        throw Error('WEBFIRST_OFFLINE_PROJECT_SEARCH_FAILED');
      process.stdout.write('WEB_FIRST_OFFLINE_PROJECT_FIND_PASS\n');
      const digest=createHash('sha256').update(sample).digest('hex');
      const changed=await taskCall('project_replace',{
        project_id:projectId,relative_path:'fixture.txt',expected_sha256:digest,
        old_text:sample,new_text:'WEBFIRST_LOCAL_MCP_REPLACED_OK'},25) as unknown as {newSha256:string};
      const fixture=await import('node:fs/promises').then(fs=>
        fs.readFile(path.join(profile,'offline-project','fixture.txt'),'utf8'));
      if(fixture!=='WEBFIRST_LOCAL_MCP_REPLACED_OK'||changed.newSha256!==
        createHash('sha256').update(fixture).digest('hex'))
        throw Error('WEBFIRST_OFFLINE_PROJECT_REPLACE_FAILED');
      process.stdout.write('WEB_FIRST_OFFLINE_PROJECT_REPLACE_PASS\n');
      const task=await taskCall('task_begin',{project_id:(await host.nativeProjects())[0]?.id,goal:'Offline task fixture only'},21);
      if(task.phase!=='active'||task.revision!==1)throw Error('WEBFIRST_OFFLINE_TASK_CREATE_FAILED');
      const saved=await taskCall('task_checkpoint',{task_id:task.task_id,revision:1,
        nonce:'smoke-checkpoint-1',note:'MCP fixture verified'},22);
      if(saved.revision!==2)throw Error('WEBFIRST_OFFLINE_TASK_CHECKPOINT_FAILED');
      const waiting=await taskCall('task_wait',{task_id:task.task_id,revision:2,
        nonce:'smoke-wait-0001',minutes:null},23);
      if(waiting.phase!=='waiting')throw Error('WEBFIRST_OFFLINE_TASK_WAIT_FAILED');
      if((await new WebFirstTaskLedger(profile).get(task.task_id)).phase!=='waiting')
        throw Error('WEBFIRST_OFFLINE_TASK_PERSIST_FAILED');
      const visible=await host.snapshotVisibleAssistant();
      if(visible?.text!=='COS_WEBFIRST_OFFLINE_ASSISTANT_REPLY_OK'||
        visible?.conversationId!=='offline-synthetic')
        throw Error('WEBFIRST_OFFLINE_ASSISTANT_RECEIVE_FAILED');
      await new WebFirstReplyJournal(profile).record(visible);
      if((await new WebFirstReplyJournal(profile).last(1))[0]?.text!==visible.text)
        throw Error('WEBFIRST_OFFLINE_ASSISTANT_PERSIST_FAILED');
      await contents.executeJavaScript('document.querySelector("#native-smoke-input").value=""');
      const syntheticOutbox=new WebFirstWebOutbox(profile);
      const delivery=await syntheticOutbox.enqueue({taskId:task.task_id,
        conversationId:randomUUID(),nonce:randomUUID(),text:'COS_WEBFIRST_OFFLINE_NATIVE_FOLLOWUP'});
      await syntheticOutbox.transition(delivery.id,'queued','dispatching');
      const sent=await sendNativeWebFirstMessage(contents,delivery.conversationId,delivery.text,true);
      if(!sent.proved||!sent.proof)throw Error('WEBFIRST_OFFLINE_NATIVE_BROWSER_SEND_NOT_PROVED');
      await syntheticOutbox.transition(delivery.id,'dispatching','delivered',sent.proof);
      const savedOutbox=(await new WebFirstWebOutbox(profile).list()).at(-1);
      if(savedOutbox?.state!=='delivered'||savedOutbox.proof!==sent.proof)
        throw Error('WEBFIRST_OFFLINE_BROWSER_SEND_RECEIPT_NOT_DURABLE');
      process.stdout.write('WEB_FIRST_OFFLINE_BROWSER_CONTINUATION_PASS\n');
      const limiter=new WebFirstRateLimitSupervisor(profile);
      const modelStatusBefore=await limiter.history429();
      if(modelStatusBefore.model!=='clear'||modelStatusBefore.history!=='degraded')
        throw Error('WEBFIRST_OFFLINE_HISTORY_429_FALSE_MODEL_LIMIT');
      const manualLimit=await limiter.pauseForModelLimit(30);
      if(manualLimit.model!=='cooldown')throw Error('WEBFIRST_OFFLINE_MODEL_LIMIT_NOT_HELD');
      try{await limiter.requireManualModelAvailable();
        throw Error('WEBFIRST_OFFLINE_MODEL_LIMIT_DID_NOT_BLOCK_SEND');
      }catch(error){
        if(error instanceof Error&&error.message!=='RATE_LIMIT_MODEL_HOLD')throw error;
      }
      const restartedLimiter=new WebFirstRateLimitSupervisor(profile);
      if((await restartedLimiter.status()).model!=='cooldown')
        throw Error('WEBFIRST_OFFLINE_MODEL_LIMIT_NOT_DURABLE');
      const cleared=await restartedLimiter.confirmRecovery(Date.now()+31*60_000);
      if(cleared.model!=='clear')throw Error('WEBFIRST_OFFLINE_MODEL_LIMIT_NOT_CLEARED');
      process.stdout.write('WEB_FIRST_OFFLINE_MODEL_COOLDOWN_PERSIST_PASS\n');
      process.stdout.write('WEB_FIRST_OFFLINE_ASSISTANT_RECEIVE_PASS\n');
      process.stdout.write('WEB_FIRST_OFFLINE_DURABLE_TASK_RPC_PASS\n');
      await host.disableNativeCore();
      process.stdout.write('WEB_FIRST_OFFLINE_LOCAL_MCP_PASS\n');
      if(!await host.testNativeAcceptanceOffline?.())
        throw Error('WEBFIRST_OFFLINE_NATIVE_ACCEPTANCE_SUMMARY_FAILED');
      process.stdout.write('WEB_FIRST_OFFLINE_NATIVE_ACCEPTANCE_SUMMARY_PASS\n');
      if(!await host.testNativePageControlsOffline?.())
        throw Error('WEBFIRST_OFFLINE_NATIVE_PAGE_CONTROL_PROBE_FAILED');
      process.stdout.write('WEB_FIRST_OFFLINE_NATIVE_PAGE_CONTROL_PASS\n');

      // Browser runtime G2: genuine Chromium CDP operation inside an OWNED,
      // hidden, non-focusable Electron window, using an isolated throwaway
      // session. Never touches user's Chrome, global keyboard, or profile.
      const frontmostBefore=BrowserWindow.getFocusedWindow()?.id??null;
      const supervisor=new ElectronWebRuntimeSupervisor(
        path.join(profile,'g2-background-runtime'),true);
      const webComputer=await supervisor.start();
      try{
        const html='<!doctype html><html><body style="background:#eee">'+
          '<input id="smoke" style="position:absolute;left:60px;top:55px;width:260px;height:40px">'+
          '<output id="result"></output>'+
          '<script>document.querySelector("#smoke").addEventListener("keydown",e=>{'+
          'if(e.key==="Enter")document.querySelector("#result").textContent='+
          'document.querySelector("#smoke").value;});</script>'+
          '</body></html>';
        await webComputer.open('data:text/html,'+encodeURIComponent(html));
        if(!webComputer.isHidden())throw Error('WEB_RUNTIME_BACKGROUND_FOCUS');
        const png=await webComputer.screenshot();
        if(png.length<256)throw Error('WEB_RUNTIME_SCREENSHOT_EMPTY');
        await webComputer.action({kind:'click',x:120,y:70});
        await webComputer.action({kind:'type',text:'COS_WEB_RUNTIME_G2_OK'});
        if((await webComputer.webContents.executeJavaScript(
            'document.querySelector("#smoke").value',true))!=='COS_WEB_RUNTIME_G2_OK')
          throw Error('WEB_RUNTIME_BACKGROUND_INPUT_MISSING');
        await webComputer.action({kind:'key',key:'Enter'});
        if((await webComputer.webContents.executeJavaScript(
            'document.querySelector("#result").textContent',true))!=='COS_WEB_RUNTIME_G2_OK')
          throw Error('WEB_RUNTIME_BACKGROUND_SUBMIT_MISSING');
        if(!webComputer.isHidden()||
          (BrowserWindow.getFocusedWindow()?.id??null)!==frontmostBefore)
          throw Error('WEB_RUNTIME_BACKGROUND_FOCUS_CHANGED');
        process.stdout.write('WEB_RUNTIME_G2_BACKGROUND_CDPSMOKE_PASS\n');
      }finally{await supervisor.stop();}
      if(supervisor.running)throw Error('WEB_RUNTIME_SUPERVISOR_STOP_INCOMPLETE');
      // A second start must be able to acquire the same Profile again, without
      // reusing a disposed Window or accidentally taking user application focus.
      const recycled=await supervisor.start();
      try{
        await recycled.open('data:text/html,'+encodeURIComponent(
          '<html><body><p>Profile Reuse Fixture</p></body></html>'));
        if(!recycled.isHidden()||
          (BrowserWindow.getFocusedWindow()?.id??null)!==frontmostBefore)
          throw Error('WEB_RUNTIME_SUPERVISOR_RESTART_FOCUS_CHANGED');
        process.stdout.write('WEB_RUNTIME_G2_OWNED_PROFILE_RESTART_PASS\n');
      }finally{await supervisor.stop();}

      // Direct upstream CCCC JavaScript (Apache-2.0), executed inside REAL
      // packaged Chromium via the new CoS adapter and durable delivery journal.
      // Synthetic ChatGPT DOM; absolutely no account, token or model request.
      const ccccSupervisor=new ElectronWebRuntimeSupervisor(
        path.join(profile,'g2-cccc-vendor'),true);
      const ccccComputer=await ccccSupervisor.start();
      try{
        const ccccHtml='<!doctype html><html><body>'+
          '<main><form><textarea id="prompt-textarea" '+
          'style="position:absolute;left:60px;top:55px;width:340px;height:55px"></textarea>'+
          '<button id="composer-submit-button" data-testid="send-button" type="button" '+
          'style="position:absolute;left:420px;top:55px;width:100px;height:55px">Send</button>'+
          '</form></main><section data-chatgpt-conversation-selection-target="true">'+
          '<div data-turn-key="fixture-user"><div data-chatgpt-search-unit-key="fixture:user">'+
          '<div data-user-message-bubble id="receipt"></div></div></div></section>'+
          '<script>document.querySelector("#composer-submit-button").addEventListener('+
          '"click",()=>{window.__coSsendCount=(window.__coSsendCount||0)+1;'+
          'document.querySelector("#receipt").textContent='+
          'document.querySelector("#prompt-textarea").value;'+
          'document.querySelector("#prompt-textarea").value="";});</script>'+
          '</body></html>';
        await ccccComputer.open('data:text/html,'+encodeURIComponent(ccccHtml));
        const ccccRegistry=new ActorPageRegistry();
        const ccccConversation=randomUUID();
        ccccRegistry.install({actorId:'builder-fixture',actorGeneration:1,
          bindingRevision:1,conversationId:ccccConversation,
          pageTargetId:'electron-'+ccccComputer.webContents.id,
          connectorIdentityDigest:'f'.repeat(64),verifiedAt:Date.now()});
        const ccccJournal=new DeliveryJournal(path.join(profile,'g2-cccc-delivery'));
        const ccccPrompt='CCCC direct copied JS verified in CoS';
        const ccccEnvelope={missionId:randomUUID(),actorId:'builder-fixture',
          actorGeneration:1,turnId:randomUUID(),deliveryId:randomUUID(),
          bindingRevision:1,conversationId:ccccConversation,
          payloadDigest:createHash('sha256').update(ccccPrompt).digest('hex'),
          payload:ccccPrompt,deadlineMs:Date.now()+120_000,
          capabilityScope:'read-only-fixture'};
        const ccccReceipt=await new ChatGPTWebsiteDelivery(
          ccccRegistry,ccccJournal).submit(ccccEnvelope,ccccComputer,
          {offlineFixture:true,maxProbeMs:4000});
        if(ccccReceipt.phase!=='ACCEPTED'||
          ccccReceipt.evidence!=='EXACT_USER_ECHO')
          throw Error('WEB_RUNTIME_CCCC_VENDOR_PROBE_FAILED_'+ccccReceipt.phase);
        const ccccRows=await new DeliveryJournal(
          path.join(profile,'g2-cccc-delivery')).list();
        if(ccccRows.length!==1||ccccRows[0]?.phase!=='ACCEPTED'||
          ccccRows[0]?.revision!==5)
          throw Error('WEB_RUNTIME_CCCC_DURABLE_RECEIPT_FAILED');
        // Replaying the same acknowledged delivery may *never* click Send
        // a second time; this is guaranteed by the journal's exact ID fence.
        let rejectedReplay=false;
        try{await new ChatGPTWebsiteDelivery(ccccRegistry,ccccJournal)
          .submit(ccccEnvelope,ccccComputer,{offlineFixture:true,maxProbeMs:100});}
        catch{rejectedReplay=true;}
        const afterReplayCount:unknown=await ccccComputer.webContents.executeJavaScript(
          'window.__coSsendCount',true);
        if(!rejectedReplay||afterReplayCount!==1)
          throw Error('WEB_RUNTIME_CCCC_DUPLICATE_SEND_ALLOWED');
        process.stdout.write('WEB_RUNTIME_CCCC_NO_REPLAY_PASS\n');
        // Browser click without a proved user-message echo is NOT success.
        // Use a new Actor on this owned target, so the original accepted
        // delivery stays immutable even under the next missing-ACK scenario.
        ccccRegistry.disconnect('builder-fixture',1,1);
        await ccccComputer.open('data:text/html,'+encodeURIComponent(
          ccccHtml.replace(
            'document.querySelector("#receipt").textContent='+
              'document.querySelector("#prompt-textarea").value;',
            'void 0;')));
        ccccRegistry.install({actorId:'auditor-fixture',actorGeneration:1,
          bindingRevision:1,conversationId:randomUUID(),
          pageTargetId:'electron-'+ccccComputer.webContents.id,
          connectorIdentityDigest:'f'.repeat(64),verifiedAt:Date.now()});
        const auditor=ccccRegistry.lookup('auditor-fixture');
        if(!auditor)throw Error('WEB_RUNTIME_CCCC_AUDITOR_BIND_FAILED');
        const ambiguousEnvelope={...ccccEnvelope,actorId:'auditor-fixture',
          conversationId:auditor.conversationId,deliveryId:randomUUID(),turnId:randomUUID()};
        const ambiguous=await new ChatGPTWebsiteDelivery(ccccRegistry,ccccJournal)
          .submit(ambiguousEnvelope,ccccComputer,{offlineFixture:true,maxProbeMs:200});
        if(ambiguous.phase!=='AMBIGUOUS'||(await ccccJournal.list())
          .find(row=>row.deliveryId===ambiguousEnvelope.deliveryId)?.phase!=='AMBIGUOUS')
          throw Error('WEB_RUNTIME_CCCC_MISSING_ECHO_NOT_HELD');
        process.stdout.write('WEB_RUNTIME_CCCC_AMBIGUOUS_HOLD_PASS\n');
        if(!ccccComputer.isHidden()||
          (BrowserWindow.getFocusedWindow()?.id??null)!==frontmostBefore)
          throw Error('WEB_RUNTIME_CCCC_BACKGROUND_FOCUS_CHANGED');
        process.stdout.write('WEB_RUNTIME_CCCC_UPSTREAM_REAL_CHROMIUM_PASS\n');
      }finally{await ccccSupervisor.stop();}

      // P3.6 packaged integration: true Electron CDP keyboard input into the
      // sandboxed offline browser + durable outbox + task checkpoint + stable
      // reply settle. No remote model, Codex or user account is involved.
      const loopLedger=new WebFirstTaskLedger(profile);
      const loopProject=(await host.nativeProjects())[0];
      if(!loopProject)throw Error('WEBFIRST_OFFLINE_LOOP_PROJECT_MISSING');
      const loopTask=await loopLedger.begin({projectId:loopProject.id,
        projectRoot:loopProject.root,goal:'Offline bounded web Goal/Loop smoke'});
      const loopChatId=randomUUID();
      const loopOutbox=new WebFirstWebOutbox(profile);
      let fakeNow=Date.now();
      const outcome=await runApprovedWebGoalLoop({
        taskId:loopTask.id,conversationId:loopChatId,maxTurns:1,
        deadline:fakeNow+180_000,signal:new AbortController().signal,
        now:()=>fakeNow,waitForReplyMs:50_000,
        services:{
          getUrl:()=> 'https://chatgpt.com/c/'+loopChatId,
          getTask:()=>loopLedger.get(loopTask.id),
          getOutbox:()=>loopOutbox.list(),
          enqueue:args=>loopOutbox.enqueue(args),
          transition:(id,from,to,proof)=>loopOutbox.transition(id,from,to,proof),
          modelAllowed:async()=>true,
          pageReady:async()=>true,
          snapshot:async()=>{
            const value=await host.snapshotVisibleAssistant();
            return value?{...value,conversationId:loopChatId}:null;
          },
          send:async(id,prompt)=>{
            const result=await sendNativeWebFirstMessage(contents,id,prompt,true);
            if(result.proved){
              const current=await loopLedger.get(loopTask.id);
              await loopLedger.checkpoint(loopTask.id,current.revision,randomUUID(),
                'Offline test: actual native input and persistent MCP checkpoint');
              await contents.executeJavaScript(
                "(() => {const row=document.createElement('article');"+
                "row.setAttribute('data-message-author-role','assistant');"+
                "row.setAttribute('data-message-id','offline-web-loop-answer');"+
                "row.textContent='Synthetic visible reply after real CDP browser input';"+
                "document.body.appendChild(row)})()");
            }
            return result;
          },
          sleep:async ms=>{fakeNow+=ms;await new Promise(resolve=>setTimeout(resolve,20));}
        }
      });
      process.stdout.write('WEB_FIRST_OFFLINE_LOOP_RESULT='+JSON.stringify({reason:outcome.reason,sent:outcome.sent,replies:outcome.replies})+'\n');
      if(outcome.reason!=='TURN_BUDGET'||outcome.sent!==1||outcome.replies!==1||
        (await loopOutbox.list()).filter(x=>x.taskId===loopTask.id)
          .some(x=>x.state!=='delivered'))
        throw Error('WEBFIRST_OFFLINE_APPROVED_WEB_LOOP_FAILED');
      process.stdout.write('WEB_FIRST_OFFLINE_APPROVED_WEB_GOAL_LOOP_PASS\n');
      const goalMenu=menus.find(m=>m.label==='目标');
      const requiredGoalActions=['新建 ChatGPT 对话并启动 Goal（需批准）',
        '启动当前网页 Goal/Loop（最多 3 轮，需批准）',
        '停止网页 Goal/Loop','查看网页 Goal/Loop 状态'];
      if(!goalMenu?.submenu||requiredGoalActions.some(action=>
        !goalMenu.submenu?.items.some(item=>item.label===action)))
        throw Error('WEBFIRST_OFFLINE_WEB_GOAL_MENU_MISSING');
      process.stdout.write('WEB_FIRST_OFFLINE_WEB_GOAL_MENU_PASS\n');


      if(!projectMenu?.submenu?.items.some(item=>item.label==='管理/撤销只读授权')||
         !projectMenu.submenu.items.some(item=>item.label==='查看本地操作收据'))
        throw Error('WEBFIRST_NATIVE_P3_GRANTS_MENU_MISSING');
      const receipts=await new WebFirstOperationJournal(profile).last();
      if(receipts.length<2||receipts.at(-2)?.stage!=='STARTED'||receipts.at(-1)?.stage!=='SUCCEEDED')
        throw Error('WEBFIRST_OFFLINE_OPERATION_RECEIPT_MISSING');
      process.stdout.write('WEB_FIRST_OFFLINE_RECEIPT_PASS\n');
      if(!menus.some(m=>m.label==='ChatGPT 网页'&&m.submenu?.items.some(x=>
        x.accelerator==='CmdOrCtrl+W'&&x.label==='安全关闭主窗口（停止 Core）')))
        throw Error('WEBFIRST_SAFE_WINDOW_CLOSE_MENU_MISSING');
      process.stdout.write('WEB_FIRST_OFFLINE_SAFE_CLOSE_MENU_PASS\n');
      process.stdout.write('WEB_FIRST_OFFLINE_PROJECT_MENU_PASS\n');
      process.stdout.write('WEB_FIRST_OFFLINE_PROJECT_UI_PASS\n');
      process.stdout.write('WEB_FIRST_OFFLINE_INPUT_PASS\n');
      process.stdout.write('WEB_FIRST_OFFLINE_VIEW_READY\n');
      setImmediate(()=>app.quit());
    }catch(error){
      const code=error instanceof Error&&/^[A-Z0-9_]+$/.test(error.message)?error.message:'UNKNOWN';
      process.stderr.write('WEB_FIRST_OFFLINE_ERROR_CODE='+code+'\n');
      process.stderr.write('WEB_FIRST_OFFLINE_INPUT_FAILED\n');
      app.exit(3);
    }
  }});
  // Application Quit and closing the last native window share ONE shutdown
  // coordinator. Make no second app.quit attempt after canceled macOS events:
  // only a proven Tunnel retirement + closed loopback unlocks app.exit.
  let appQuitInFlight=false;
  const quitTrace=(stage:string)=>{
    if(process.env.COS_NEXT_WEBFIRST_QUIT_TRACE==='1'){
      const line='WEBFIRST_QUIT_STAGE='+stage+'\n';
      process.stdout.write(line);
      try{appendFileSync(path.join(os.tmpdir(),'cos-next-quit-'+process.pid+'.log'),
        line,{mode:0o600});}catch{/* diagnostics are not authoritative */}
    }
  };
  app.on('before-quit',event=>{
    if(offlineSmoke||httpsSmoke)return;
    quitTrace('MAIN_BEFORE_QUIT');
    event.preventDefault();
    if(appQuitInFlight)return;
    appQuitInFlight=true;
    void host.shutdownForAppExit().then(()=>{
      quitTrace('MAIN_EXIT_APPROVED');
      app.exit(0);
    }).catch(()=>{
      quitTrace('MAIN_EXIT_BLOCKED');
      appQuitInFlight=false;
      if(!host.window.isDestroyed())host.window.show();
    });
  });
  host.window.on('closed',()=>{
    quitTrace('MAIN_WINDOW_CLOSED_CALLBACK');
    if(!quitting)app.quit();
  });
  app.on('window-all-closed',()=>quitTrace('MAIN_ALL_WINDOWS_CLOSED'));
  app.on('will-quit',()=>quitTrace('MAIN_WILL_QUIT'));
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
if(smokeRoot)process.once('exit',()=>{try{rmSync(smokeRoot,{recursive:true,force:true});}catch{/* OS temp cleanup best effort */}});
