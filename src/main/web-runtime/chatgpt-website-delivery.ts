/**
 * Directly USES Apache-2.0 CCCC browser probes, adapted to CoS-owned Electron.
 * Does NOT copy CCCC's mission scheduler or pull in a different model runtime.
 *
 * Danger boundary: queued/claimed/staged are pre-send; SEND_ATTEMPTED is
 * durably committed BEFORE invoking any document send control. Anything after
 * this fence is accepted-by-proof or ambiguous; NEVER blindly replay.
 */
import {createHash} from 'node:crypto';
import type {BackgroundWebComputer} from './browser-driver-electron.js';
import {assertTurnEnvelope} from './contracts.js';
import type {TurnEnvelope} from './contracts.js';
import type {ActorPageRegistry} from './page-registry.js';
import type {DeliveryJournal} from './delivery-journal.js';
import type {DeliveryEvent} from './delivery-state.js';
import {INSPECT_SUBMISSION_SCRIPT,SELECT_SEND_CONTROL_SCRIPT}
  from './vendor/cccc-webpage-probes.js';

export interface WebSubmissionReceipt {
  deliveryId:string;
  phase:'ACCEPTED'|'AMBIGUOUS'|'FAILED_PRE_SEND';
  evidence:'EXACT_USER_ECHO'|'SUBMISSION_UNCERTAIN'|'PRE_SEND_ERROR';
  messageDigest:string;
}
type Probe={url:string;echo_found:boolean;composer_exact:boolean;
  composer_chars:number;stop_visible:boolean;running:boolean;
  user_message_count:number;send_enabled_count:number};
const wait=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
function conversationMatches(url:string,conversationId:string):boolean{
  try{
    const u=new URL(url);
    return u.protocol==='https:'&&u.hostname==='chatgpt.com'&&
      u.pathname==='/c/'+conversationId&&!u.search&&!u.hash;
  }catch{return false;}
}
/** Modern 2026 DOM structural role selector from Classic, separate from CCCC's
 * immutable 2026-10-09 vendor source (which knows older role markup).
 */
export const MODERN_EXACT_USER_ECHO_SCRIPT=`payload => {
  const normalize = text => String(text||'').replace(/\\u00a0/g,' ').replace(/\\s+/g,' ').trim();
  const nodes = document.querySelectorAll(
    '[data-chatgpt-conversation-selection-target="true"] [data-turn-key] '+
    '[data-chatgpt-search-unit-key$=":user"] [data-user-message-bubble], '+
    '[data-turn-key] [data-chatgpt-search-unit-key$=":user"] [data-user-message-bubble]');
  return Array.from(nodes).some(node => {
    const actual=normalize(node.innerText || node.textContent);
    return actual.includes(normalize(payload.marker)) &&
      actual.includes(normalize(payload.completePrompt));
  });
}`;
/** Finds ONE editable composer and tags it for the unchanged CCCC probes.
 * Refuses drafts, multiple visible editors, disabled editors, unknown page.
 */
export const MARK_OWNED_COMPOSER_SCRIPT=`() => {
  const nodes=[...document.querySelectorAll(
    '#prompt-textarea, [data-testid="composer-rich-text-input"], '+
    '[data-composer-body] [contenteditable="true"][role="textbox"], '+
    '[contenteditable="true"][role="textbox"], textarea')];
  const visible=node=>{
    const r=node.getBoundingClientRect(),s=getComputedStyle(node);
    return r.width>4&&r.height>4&&s.display!=='none'&&
      s.visibility!=='hidden'&&
      !node.closest('[aria-hidden="true"],[inert]');
  };
  const unique=[...new Set(nodes)].filter(node=>{
    return visible(node)&&!node.disabled&&!node.readOnly;
  });
  // A ChatGPT composer can be nested inside another candidate; deduplicate
  // identical elements, but do not choose among separate visible editors.
  if(unique.length!==1)return {ready:false,reason:'editor_not_unique'};
  const node=unique[0],text=('value' in node?node.value:node.innerText)||'';
  if(String(text).trim())return {ready:false,reason:'draft_occupied'};
  node.setAttribute('data-cccc-web-model-composer','cccc-web-model-composer');
  node.focus();
  return {ready:true,reason:'',targetTag:node.tagName};
}`;
/** The click and target recheck execute as ONE Chromium JS task. The CCCC
 * selector and full draft+echo probe run immediately prior to the one click.
 */
export function oneShotSendScript(payload:{prompt:string;marker:string;url:string}):string{
  const data=JSON.stringify({prompt:payload.prompt,needles:[payload.marker],url:payload.url});
  return `(() => {
    const ctx=${data};
    const before=(${INSPECT_SUBMISSION_SCRIPT})(ctx);
    if(before.url!==ctx.url || before.echo_found || !before.composer_exact ||
      before.running || before.stop_visible)
      return {invoked:false,reason:'preflight_changed'};
    const chosen=(${SELECT_SEND_CONTROL_SCRIPT})();
    if(!chosen.selector || chosen.running || chosen.stop_visible)
      return {invoked:false,reason:'send_button_not_ready'};
    const button=document.querySelector(chosen.selector);
    if(!button || button.disabled || button.getAttribute('aria-disabled')==='true')
      return {invoked:false,reason:'send_button_changed'};
    const second=(${INSPECT_SUBMISSION_SCRIPT})(ctx);
    if(second.url!==ctx.url || second.echo_found || !second.composer_exact ||
      second.running || second.stop_visible)
      return {invoked:false,reason:'draft_changed'};
    try { button.click(); return {invoked:true,reason:'dom_click'}; }
    catch { return {invoked:true,reason:'dispatch_unknown'}; }
  })()`;
}
export async function vendorSnapshot(computer:BackgroundWebComputer,
  prompt:string,marker:string):Promise<Probe>{
  const source='('+INSPECT_SUBMISSION_SCRIPT+')('+
    JSON.stringify({prompt,needles:[marker]})+')';
  const result:unknown=await computer.webContents.executeJavaScript(source,true);
  if(!result||typeof result!=='object')throw Error('WEB_CCCC_PROBE_INVALID');
  const p=result as Partial<Probe>;
  if(typeof p.url!=='string'||typeof p.echo_found!=='boolean'||
    typeof p.composer_exact!=='boolean'||typeof p.composer_chars!=='number'||
    typeof p.running!=='boolean'||typeof p.stop_visible!=='boolean'||
    typeof p.send_enabled_count!=='number')throw Error('WEB_CCCC_PROBE_INVALID');
  return p as Probe;
}
async function modernEcho(computer:BackgroundWebComputer,
  prompt:string,marker:string):Promise<boolean>{
  const code='('+MODERN_EXACT_USER_ECHO_SCRIPT+')('+
    JSON.stringify({completePrompt:prompt,marker})+')';
  return (await computer.webContents.executeJavaScript(code,true))===true;
}
export class ChatGPTWebsiteDelivery {
  constructor(private readonly registry:ActorPageRegistry,
    private readonly journal:DeliveryJournal){}
  /** Receipt covers only webpage submission, NOT assistant reply or Goal success. */
  async submit(turn:TurnEnvelope,computer:BackgroundWebComputer,
    opts:{offlineFixture?:boolean;maxProbeMs?:number;signal?:AbortSignal}={}):
    Promise<WebSubmissionReceipt>{
    assertTurnEnvelope(turn);
    const binding=this.registry.requireForTurn(turn);
    if(binding.pageTargetId!==(computer.transportTargetId??
      'electron-'+computer.webContents.id))
      throw Error('WEB_SUBMIT_WRONG_TARGET_ID');
    const url=computer.webContents.getURL();
    const fixture=opts.offlineFixture===true;
    if(!(fixture?url.startsWith('data:text/html,'):conversationMatches(url,turn.conversationId)))
      throw Error('WEB_SUBMIT_WRONG_CONVERSATION');
    if(opts.signal?.aborted)throw Error('WEB_SUBMIT_STOPPED');
    const marker='[cos-web delivery:'+turn.deliveryId+']';
    const prompt=marker+'\n'+turn.payload;
    const digest=createHash('sha256').update(prompt).digest('hex');
    if(createHash('sha256').update(turn.payload).digest('hex')!==turn.payloadDigest)
      throw Error('WEB_SUBMIT_PAYLOAD_DIGEST_MISMATCH');
    let row=await this.journal.create({
      deliveryId:turn.deliveryId,actorId:turn.actorId,actorGeneration:turn.actorGeneration,
      turnId:turn.turnId,conversationId:turn.conversationId});
    const advance=async(event:DeliveryEvent)=>{
      row=await this.journal.transition(turn.deliveryId,event,row.revision);
    };
    const safe=()=>this.registry.requireForTurn(turn)&&
      (fixture?computer.webContents.getURL()===url:
        conversationMatches(computer.webContents.getURL(),turn.conversationId));
    try{
      await advance('CLAIM');
      if(!safe()||opts.signal?.aborted)throw Error('WEB_SUBMIT_PRE_SEND_STOP');
      const flagged:unknown=await computer.webContents.executeJavaScript(
        '('+MARK_OWNED_COMPOSER_SCRIPT+')()',true);
      if(!(flagged as {ready?:boolean}|null)?.ready)
        throw Error('WEB_SUBMIT_COMPOSER_NOT_READY');
      const baseline=await vendorSnapshot(computer,prompt,marker);
      if(baseline.url!==url||baseline.running||baseline.stop_visible||
        baseline.composer_chars!==0||baseline.echo_found||
        await modernEcho(computer,prompt,marker))
        throw Error('WEB_SUBMIT_PRE_SEND_BUSY');
      if(!safe()||opts.signal?.aborted)throw Error('WEB_SUBMIT_PRE_SEND_STOP');
      await computer.action({kind:'type',text:prompt});
      const staged=await vendorSnapshot(computer,prompt,marker);
      if(!safe()||!staged.composer_exact||staged.echo_found||
        staged.running||staged.stop_visible||opts.signal?.aborted)
        throw Error('WEB_SUBMIT_DRAFT_CHANGED');
      await advance('STAGE');
      if(!safe()||opts.signal?.aborted)throw Error('WEB_SUBMIT_PRE_SEND_STOP');
    }catch{
      // If browser mutation was limited to staging a draft, it is safe to
      // record pre-send failure. It must NEVER make a send attempt appear false.
      if(row.phase==='CLAIMED'||row.phase==='STAGED')
        await advance('PRE_SEND_FAILURE');
      return {deliveryId:turn.deliveryId,phase:'FAILED_PRE_SEND',
        evidence:'PRE_SEND_ERROR',messageDigest:digest};
    }
    // WARNING: durable send fence MUST precede any model-affecting DOM click.
    await advance('ATTEMPT_SEND');
    try{
      await computer.webContents.executeJavaScript(oneShotSendScript({prompt,marker,url}),true);
    }catch{/* potentially sent: no automatic retry */}
    const due=Date.now()+Math.min(12000,Math.max(100,opts.maxProbeMs??8000));
    while(Date.now()<due){
      if(opts.signal?.aborted)break;
      try{
        if(!safe())break;
        const snapshot=await vendorSnapshot(computer,prompt,marker);
        if(snapshot.url!==url)break;
        const modern=await modernEcho(computer,prompt,marker);
        if(snapshot.echo_found||modern){
          await advance('VERIFY_ECHO');
          return {deliveryId:turn.deliveryId,phase:'ACCEPTED',
            evidence:'EXACT_USER_ECHO',messageDigest:digest};
        }
      }catch{break;}
      await wait(150);
    }
    await advance('MARK_AMBIGUOUS');
    return {deliveryId:turn.deliveryId,phase:'AMBIGUOUS',
      evidence:'SUBMISSION_UNCERTAIN',messageDigest:digest};
  }
}
