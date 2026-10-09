/** Electron-owned, privacy-minimal native webpage control preflight.
 * No model/API requests, cookies, tokens or message content.
 */
import type {WebContents} from 'electron';
import {conversationFromUrl} from './web-reply-observer.js';
export type WebControlSnapshot={
  page:'CHATGPT'|'OFFLINE_FIXTURE'|'OTHER';conversation:boolean;
  composer:'READY'|'EMPTY_OR_HIDDEN'|'DRAFT_PRESENT'|'GENERATING';
  sendButtonVisible:boolean;userMessages:number;assistantMessages:number;
  canAttemptOneApprovedTurn:boolean;
};
export const PAGE_CONTROLS_PROBE=[
  '(() => {',
  'const el=document.querySelector("#prompt-textarea,[data-testid=\\"composer-rich-text-input\\"],[contenteditable=\\"true\\"][role=\\"textbox\\"],#native-smoke-input");',
  'const r=el?.getBoundingClientRect();',
  'const visible=!!r&&r.width>0&&r.height>0;',
  'const draft=!!el&&!!(("value" in el?el.value:el.innerText)||"").trim();',
  'const generating=!!document.querySelector("[data-testid=\\"stop-button\\"],button[aria-label=\\"Stop generating\\"],button[aria-label=\\"停止生成\\"]");',
  'const send=document.querySelector("[data-testid=\\"send-button\\"],button[aria-label=\\"Send message\\"],button[aria-label=\\"发送消息\\"]");',
  'const sr=send?.getBoundingClientRect();',
  'return {visible,draft,generating,send:!!sr&&sr.width>0&&sr.height>0,',
  'users:document.querySelectorAll("[data-message-author-role=\\"user\\"]").length,',
  'assistants:document.querySelectorAll("[data-message-author-role=\\"assistant\\"]").length};',
  '})()'
].join('\n');
export function classifyWebControls(url:string,value:unknown,offlineFixture=false):WebControlSnapshot{
  let page:WebControlSnapshot['page']='OTHER';
  if(offlineFixture&&url.startsWith('data:text/html'))page='OFFLINE_FIXTURE';
  else try{const u=new URL(url);if(u.protocol==='https:'&&u.hostname==='chatgpt.com')
    page='CHATGPT';}catch{/* no browser permission */}
  const safe=value&&typeof value==='object'&&!Array.isArray(value)?
    value as Record<string,unknown>:{};
  const bounded=(n:unknown)=>Number.isSafeInteger(n)&&Number(n)>=0&&Number(n)<=100_000?Number(n):0;
  const conversation=page==='CHATGPT'&&conversationFromUrl(url)!==null;
  const composer=safe.generating===true?'GENERATING':
    safe.draft===true?'DRAFT_PRESENT':
    safe.visible===true?'READY':'EMPTY_OR_HIDDEN';
  return {page,conversation,composer,sendButtonVisible:safe.send===true,
    userMessages:bounded(safe.users),assistantMessages:bounded(safe.assistants),
    canAttemptOneApprovedTurn:conversation&&composer==='READY'};
}
export async function inspectNativeChatGPTPage(contents:WebContents,offlineFixture=false):Promise<WebControlSnapshot>{
  if(contents.isDestroyed())throw Error('WEB_CONTROL_PAGE_DESTROYED');
  const before=contents.getURL();
  if(!offlineFixture){let u:URL;try{u=new URL(before);}catch{throw Error('WEB_CONTROL_PAGE_NOT_ALLOWED');}
    if(u.protocol!=='https:'||u.hostname!=='chatgpt.com')
      throw Error('WEB_CONTROL_PAGE_NOT_ALLOWED');
  }
  const result:unknown=await contents.executeJavaScript(PAGE_CONTROLS_PROBE,true);
  if(contents.getURL()!==before)throw Error('WEB_CONTROL_NAVIGATION_RACE');
  return classifyWebControls(before,result,offlineFixture);
}
