/** Browser input owned by the Electron WebContentsView, never Chrome extension. */
import {createHash} from 'node:crypto';
import type {WebContents} from 'electron';
import {conversationFromUrl} from './web-reply-observer.js';
const EDITOR_PROBE=`(() => {
  const el=document.querySelector('#prompt-textarea,[data-testid="composer-rich-text-input"],[contenteditable="true"][role="textbox"],#native-smoke-input');
  if(!el)return null;
  const rect=el.getBoundingClientRect();
  const text=('value' in el?el.value:el.innerText)||'';
  const streaming=!!document.querySelector('[data-testid="stop-button"],button[aria-label="Stop generating"],button[aria-label="停止生成"]');
  return {x:rect.left+rect.width/2,y:rect.top+rect.height/2,
    visible:rect.width>0&&rect.height>0,draft:text,streaming,
    userCount:document.querySelectorAll('[data-message-author-role="user"]').length};
})()`;
const MESSAGE_PROBE=`(() => [...document.querySelectorAll('[data-message-author-role="user"]')]
  .map(e=>(e.innerText||'').trim()))()`;
/**
 * Each dispatch is AT MOST ONCE. Caller must fsync an outbox claim before it.
 * On failure caller records UNCERTAIN, never retries automatically.
 */
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
    if(Array.isArray(text)&&text.length>initialCount&&
      text.slice(initialCount).some(t=>typeof t==='string'&&t.trim()===prompt.trim()))
      return {proved:true,proof:'dom:'+proof};
    await new Promise(resolve=>setTimeout(resolve,300));
  }
  return {proved:false,proof:null};
}
