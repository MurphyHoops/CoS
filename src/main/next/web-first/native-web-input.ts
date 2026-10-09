/** Browser input owned by the Electron WebContentsView, never Chrome extension. */
import {createHash} from 'node:crypto';
import type {WebContents} from 'electron';
import {conversationFromUrl} from './web-reply-observer.js';
const EDITOR_PROBE=`(() => {
  const el=document.querySelector('#prompt-textarea,[data-composer-body] [data-composer-markdown][contenteditable="true"][role="textbox"],[data-testid="composer-rich-text-input"],[contenteditable="true"][role="textbox"],#native-smoke-input');
  if(!el)return null;
  const rect=el.getBoundingClientRect();
  const text=('value' in el?el.value:el.innerText)||'';
  const streaming=!!document.querySelector('[data-testid="stop-button"],[data-testid="composer-stop-button"],button[aria-label="Stop generating"],button[aria-label="停止生成"]');
  return {x:rect.left+rect.width/2,y:rect.top+rect.height/2,
    visible:rect.width>0&&rect.height>0,draft:text,streaming,
    userCount:document.querySelectorAll('[data-message-author-role="user"],[data-chatgpt-search-unit-key$=":user"] [data-user-message-bubble]').length};
})()`;
export const MESSAGE_PROBE=[
  '(() => {',
  'const legacy=[...document.querySelectorAll(\'[data-message-author-role="user"]\')];',
  'const modern=[...document.querySelectorAll(\'[data-chatgpt-conversation-selection-target="true"] [data-turn-key] [data-chatgpt-search-unit-key$=":user"] [data-user-message-bubble] .text-size-chat.whitespace-pre-wrap\')];',
  'return [...legacy,...modern].map(e=>(e.textContent||"").trim());',
  '})()'
].join('\n');
/** The 2026 ChatGPT page no longer reliably exposes old author-role nodes.
 * This read-only receipt counts exact text in the RENDERED page (not a
 * composer draft). Never logs/returns chat content, only a bounded count.
 */
async function renderedOccurrences(contents:WebContents,prompt:string):Promise<number>{
  const source='(() => {const target='+JSON.stringify(prompt.trim())+';'+
    'const composer=document.querySelector("#prompt-textarea,[data-testid=\\"composer-rich-text-input\\"],[contenteditable=\\"true\\"][role=\\"textbox\\"]");'+
    'const draft=composer?(("value" in composer?composer.value:composer.innerText)||"").trim():"";'+
    'if(draft===target)return 0;'+
    'const body=document.body?.innerText||"";'+
    'return Math.min(100,(body.split(target).length-1));})()';
  const count:unknown=await contents.executeJavaScript(source,true);
  return typeof count==='number'&&Number.isSafeInteger(count)&&count>=0&&count<=100?count:0;
}
/**
 * Each dispatch is AT MOST ONCE. Caller must fsync an outbox claim before it.
 * On failure caller records UNCERTAIN, never retries automatically.
 */
/** First Goal website turn from ChatGPT homepage; create the conversation using
 * the visible official composer. The resulting /c/ UUID is only a locator.
 * Never use it as caller authorization. Ambiguous submission never retries.
 */
export async function sendNativeWebFirstNewChat(contents:WebContents,prompt:string):
  Promise<{proved:boolean;conversationId:string|null;proof:string|null}>{
  if(!prompt||prompt.length>2000)throw Error('WEB_INPUT_PROMPT_INVALID');
  const home=()=>{
    try{const u=new URL(contents.getURL());
      return u.protocol==='https:'&&u.hostname==='chatgpt.com'&&u.pathname==='/';
    }catch{return false;}
  };
  if(!home())throw Error('WEB_NEW_CHAT_HOME_REQUIRED');
  const state:unknown=await contents.executeJavaScript(EDITOR_PROBE,true);
  if(!state||typeof state!=='object')throw Error('WEB_INPUT_EDITOR_MISSING');
  const editor=state as {x?:number;y?:number;visible?:boolean;draft?:string;
    streaming?:boolean;userCount?:number};
  if(!editor.visible||!Number.isFinite(editor.x)||!Number.isFinite(editor.y)||
    typeof editor.draft!=='string'||editor.draft.trim()||editor.streaming||
    !Number.isSafeInteger(editor.userCount))throw Error('WEB_INPUT_NOT_READY_OR_DRAFT_PRESENT');
  if(!home())throw Error('WEB_NEW_CHAT_NAVIGATION_RACE');
  const initialMentions=await renderedOccurrences(contents,prompt);
  let attached=false;
  try{
    contents.debugger.attach('1.3');attached=true;
    await contents.debugger.sendCommand('Input.dispatchMouseEvent',{
      type:'mousePressed',x:editor.x,y:editor.y,button:'left',clickCount:1});
    await contents.debugger.sendCommand('Input.dispatchMouseEvent',{
      type:'mouseReleased',x:editor.x,y:editor.y,button:'left',clickCount:1});
    if(!home())throw Error('WEB_NEW_CHAT_NAVIGATION_RACE');
    await contents.debugger.sendCommand('Input.insertText',{text:prompt});
    if(!home())throw Error('WEB_NEW_CHAT_NAVIGATION_RACE');
    const inputProof:unknown=await contents.executeJavaScript(EDITOR_PROBE,true);
    if(!inputProof||typeof inputProof!=='object'||
      (inputProof as {draft?:unknown}).draft!==prompt)
      throw Error('WEB_INPUT_DRAFT_NOT_VERIFIED');
    await contents.debugger.sendCommand('Input.dispatchKeyEvent',{
      type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:36});
    await contents.debugger.sendCommand('Input.dispatchKeyEvent',{
      type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:36});
  }finally{if(attached&&contents.debugger.isAttached())contents.debugger.detach();}
  const deadline=Date.now()+20_000;
  while(Date.now()<deadline){
    const id=conversationFromUrl(contents.getURL());
    if(id){
      let text:unknown;
      try{text=await contents.executeJavaScript(MESSAGE_PROBE,true);}
      catch{return {proved:false,conversationId:id,proof:null};}
      const roleMatches=Array.isArray(text)&&text.some(v=>
        typeof v==='string'&&v.trim()===prompt.trim());
      if(roleMatches||(await renderedOccurrences(contents,prompt))>initialMentions){
        const digest=createHash('sha256').update(id+'|'+prompt).digest('hex');
        return {proved:true,conversationId:id,proof:'dom:'+digest};
      }
    }else if(!home())return {proved:false,conversationId:null,proof:null};
    await new Promise(resolve=>setTimeout(resolve,300));
  }
  return {proved:false,conversationId:conversationFromUrl(contents.getURL()),proof:null};
}
export async function sendNativeWebFirstMessage(contents:WebContents,conversationId:string,
  prompt:string,offlineFixture=false):Promise<{proved:boolean;proof:string|null}>{
  if(!prompt||prompt.length>2000)throw Error('WEB_INPUT_PROMPT_INVALID');
  const correctRoute=()=>offlineFixture ? contents.getURL().startsWith('data:text/html'):
    conversationFromUrl(contents.getURL())===conversationId;
  if(!correctRoute())throw Error('WEB_INPUT_CONVERSATION_MISMATCH');
  const state:unknown=await contents.executeJavaScript(EDITOR_PROBE,true);
  if(!state||typeof state!=='object')throw Error('WEB_INPUT_EDITOR_MISSING');
  const editor=state as {x?:number;y?:number;visible?:boolean;draft?:string;streaming?:boolean;userCount?:number};
  if(!editor.visible||typeof editor.x!=='number'||typeof editor.y!=='number'||
    typeof editor.draft!=='string'||editor.draft.trim()||editor.streaming||
    !Number.isSafeInteger(editor.userCount))throw Error('WEB_INPUT_NOT_READY_OR_DRAFT_PRESENT');
  if(!correctRoute())throw Error('WEB_INPUT_CONVERSATION_MISMATCH');
  const initialMentions=await renderedOccurrences(contents,prompt);
  let attached=false;
  try{
    contents.debugger.attach('1.3');attached=true;
    await contents.debugger.sendCommand('Input.dispatchMouseEvent',{
      type:'mousePressed',x:editor.x,y:editor.y,button:'left',clickCount:1});
    await contents.debugger.sendCommand('Input.dispatchMouseEvent',{
      type:'mouseReleased',x:editor.x,y:editor.y,button:'left',clickCount:1});
    if(!correctRoute())throw Error('WEB_INPUT_CONVERSATION_CHANGED');
    await contents.debugger.sendCommand('Input.insertText',{text:prompt});
    if(!correctRoute())throw Error('WEB_INPUT_CONVERSATION_CHANGED');
    const inputProof:unknown=await contents.executeJavaScript(EDITOR_PROBE,true);
    if(!inputProof||typeof inputProof!=='object'||
      (inputProof as {draft?:unknown}).draft!==prompt)
      throw Error('WEB_INPUT_DRAFT_NOT_VERIFIED');
    await contents.debugger.sendCommand('Input.dispatchKeyEvent',{
      type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:36});
    await contents.debugger.sendCommand('Input.dispatchKeyEvent',{
      type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:36});
  }finally{if(attached&&contents.debugger.isAttached())contents.debugger.detach();}
  const initialCount=editor.userCount!;
  const proof=createHash('sha256').update(conversationId+'|'+prompt).digest('hex');
  const due=Date.now()+8000;
  while(Date.now()<due){
    if(!correctRoute())return {proved:false,proof:null};
    let text:unknown;
    try{text=await contents.executeJavaScript(MESSAGE_PROBE,true);}catch{return {proved:false,proof:null};}
    const roleMatches=Array.isArray(text)&&text.length>initialCount&&
      text.slice(initialCount).some(t=>typeof t==='string'&&t.trim()===prompt.trim());
    if(roleMatches||(await renderedOccurrences(contents,prompt))>initialMentions)
      return {proved:true,proof:'dom:'+proof};
    await new Promise(resolve=>setTimeout(resolve,300));
  }
  return {proved:false,proof:null};
}
