/**
 * EXPLICIT opt-in REAL ChatGPT website smoke. No API, Codex, Chrome extension,
 * credential access, or model text/tool execution.
 *
 * A one-shot operator launch mode calls this only after original Classic
 * App startup. Never used by ordinary automated Goal/Worker authority.
 */
import {randomUUID} from 'node:crypto';
import {app} from 'electron';
import path from 'node:path';
import {promises as fs} from 'node:fs';
import {inspectNativeChatGPTPage} from '../next/web-first/web-page-controls.js';
import {sendNativeWebFirstNewChat} from '../next/web-first/native-web-input.js';
import {
  VISIBLE_REPLY_SCRIPT,conversationFromUrl,WebReplySettleTracker
} from '../next/web-first/web-reply-observer.js';
import {DeliveryJournal} from './delivery-journal.js';
import {classifyRealWebGate,WEB_INTERSTITIAL_PROBE,
  type WebGateDecision} from './web-gate.js';
import {classicNativeWebHealth,getClassicNativeWebComputer} from './classic-native-runtime.js';

export type RealAccountSmokeStatus={
  phase:'AUTH_REQUIRED'|'SECURITY_CHECK_REQUIRED'|'EDITOR_READY'|'SEND_ACCEPTED'|'REPLY_VERIFIED'|
    'DELIVERY_AMBIGUOUS'|'REPLY_TIMEOUT'|'WEB_UNAVAILABLE';
  reason:string; conversation?:string;
};
const wait=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
export async function realAccountSmoke(mode:'probe'|'send'):
  Promise<RealAccountSmokeStatus>{
  if(!app.isPackaged||process.env.COS_NEXT_CLASSIC_WORKFLOW!=='1'||
    !['probe','send'].includes(mode))
    throw Error('REAL_ACCOUNT_SMOKE_NOT_AUTHORIZED');
  if(classicNativeWebHealth()!=='READY')
    return {phase:'WEB_UNAVAILABLE',reason:'native_browser_not_started'};
  const computer=getClassicNativeWebComputer();
  // Keep a valid existing homepage. Re-navigating after verification can
  // cause a fresh challenge and invalidate the previously READY composer.
  if(computer.webContents.getURL()!=='https://chatgpt.com/'){
    try{await computer.open('https://chatgpt.com/');}
    catch{return {phase:'WEB_UNAVAILABLE',reason:'homepage_navigation_failed'};}
  }
  let gate:WebGateDecision='PAGE_LOADING';
  let documentStatus:number|null=null;
  const preflightDeadline=Date.now()+30_000;
  do {
    try {
      const state=await inspectNativeChatGPTPage(computer.webContents);
      const interstitial=await computer.webContents.executeJavaScript(
        WEB_INTERSTITIAL_PROBE,true)===true;
      documentStatus=computer.documentHttpStatus?.()??null;
      gate=classifyRealWebGate({
        official:state.page==='CHATGPT',composer:state.composer,
        loginVisible:state.requiresLoginUI,interstitial,documentStatus
      });
    }catch{return {phase:'WEB_UNAVAILABLE',reason:'homepage_not_accessible'};}
    if(gate==='EDITOR_READY'||gate==='LOGIN_REQUIRED'||
       gate==='COMPOSER_OCCUPIED'||gate==='OTHER_SITE')break;
    // Do not interact with Cloudflare or CAPTCHA. Wait for normal page
    // readiness, then explicitly require user verification if still blocked.
    await wait(700);
  }while(Date.now()<preflightDeadline);
  if(gate==='SECURITY_CHECK_REQUIRED')
    return {phase:'SECURITY_CHECK_REQUIRED',reason:'website_verification_required'};
  if(gate==='HTTP_BLOCKED')
    return {phase:'WEB_UNAVAILABLE',reason:'website_http_'+documentStatus};
  if(gate==='LOGIN_REQUIRED')
    return {phase:'AUTH_REQUIRED',reason:'visible_login_control'};
  if(gate==='OTHER_SITE')
    return {phase:'WEB_UNAVAILABLE',reason:'not_official_chatgpt'};
  if(gate!=='EDITOR_READY')
    return {phase:'WEB_UNAVAILABLE',reason:'website_gate_'+gate.toLowerCase()};
  if(mode==='probe')return {phase:'EDITOR_READY',reason:'authenticated_page_composer_ready'};
  // One live smoke send, maximum, across process restarts. Claim survives a
  // crash and is never auto-replayed on uncertain website delivery. Further
  // real tasks use the original durable Goal/Agent outbox, not this smoke.
  const smokeRoot=path.join(app.getPath('userData'),'native-real-account-smoke');
  try{
    await fs.mkdir(smokeRoot,{recursive:true,mode:0o700});
    const claim=await fs.open(path.join(smokeRoot,'send-once.claim'),'wx',0o600);
    try{await claim.writeFile('claimed-before-model-send\n');await claim.sync();}
    finally{await claim.close();}
  }catch{
    return {phase:'WEB_UNAVAILABLE',reason:'smoke_send_once_already_claimed'};
  }
  // A distinct SHA-marked test conversation, never any existing user chat.
  const deliveryId=randomUUID();
  const token='COS_REAL_WEB_OK_'+deliveryId.replace(/-/g,'').slice(0,12);
  const prompt='CoS Next independent browser real-account connection test. '+
    'Please reply with exactly this marker and nothing else: '+token;
  const journal=new DeliveryJournal(path.join(app.getPath('userData'),
    'native-real-account-smoke'));
  let state=await journal.create({
    deliveryId,actorId:'real-web-smoke-'+deliveryId.slice(0,8),actorGeneration:1,
    turnId:randomUUID(),conversationId:randomUUID()});
  const advance=async(event:'CLAIM'|'STAGE'|'ATTEMPT_SEND'|'VERIFY_ECHO'|
    'MARK_AMBIGUOUS'|'REPLY_BEGIN'|'REPLY_SETTLE'|'COMPLETE')=>{
    state=await journal.transition(deliveryId,event,state.revision);
  };
  await advance('CLAIM');
  // The official page DOM is the only input surface; never use an API.
  await advance('STAGE');
  await advance('ATTEMPT_SEND'); // fsynced before any possible website send
  let delivered:{proved:boolean;conversationId:string|null;proof:string|null};
  try{delivered=await sendNativeWebFirstNewChat(computer.webContents,prompt);}
  catch{return await hold('delivery_unconfirmed_after_attempt');}
  if(!delivered.proved||!delivered.conversationId)
    return await hold('user_message_not_proved');
  await advance('VERIFY_ECHO');
  const conversationId=delivered.conversationId;
  const tracker=new WebReplySettleTracker();
  const deadline=Date.now()+65000;
  while(Date.now()<deadline){
    if(conversationFromUrl(computer.webContents.getURL())!==conversationId)
      return {phase:'SEND_ACCEPTED',reason:'conversation_changed_before_reply',
        conversation:conversationId};
    try{
      const candidate:unknown=await computer.webContents.executeJavaScript(
        VISIBLE_REPLY_SCRIPT,true);
      if(candidate&&typeof candidate==='object'){
        const r=candidate as {messageId?:string;text?:string;editorReady?:boolean;
          generating?:boolean};
        if(typeof r.messageId==='string'&&typeof r.text==='string'&&
          typeof r.editorReady==='boolean'&&typeof r.generating==='boolean'){
          const settled=tracker.observe({conversationId,messageId:r.messageId,
            text:r.text,editorReady:r.editorReady,generating:r.generating});
          if(settled){
            if(settled.text.trim()===token){
              await advance('REPLY_BEGIN');
              await advance('REPLY_SETTLE');
              await advance('COMPLETE');
              return {
                phase:'REPLY_VERIFIED',reason:'exact_assistant_marker',
                conversation:conversationId};
            }
            return {phase:'SEND_ACCEPTED',reason:'assistant_reply_not_exact_marker',
              conversation:conversationId};
          }
        }
      }
    }catch{return {phase:'SEND_ACCEPTED',reason:'reply_probe_failed',
      conversation:conversationId};}
    await wait(850);
  }
  return {phase:'REPLY_TIMEOUT',reason:'no_settled_assistant_response',
    conversation:conversationId};
  async function hold(reason:string):Promise<RealAccountSmokeStatus>{
    await advance('MARK_AMBIGUOUS');
    return {phase:'DELIVERY_AMBIGUOUS',reason};
  }
}
