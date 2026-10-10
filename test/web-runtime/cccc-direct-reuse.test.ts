import {describe,it,expect} from 'vitest';
import {JSDOM} from 'jsdom';
import {createHash} from 'node:crypto';
import {INSPECT_SUBMISSION_SCRIPT,SELECT_SEND_CONTROL_SCRIPT,REQUEST_SUBMIT_SCRIPT}
  from '../../src/main/web-runtime/vendor/cccc-webpage-probes.js';
import {MODERN_EXACT_USER_ECHO_SCRIPT,MARK_OWNED_COMPOSER_SCRIPT,oneShotSendScript}
  from '../../src/main/web-runtime/chatgpt-website-delivery.js';
const UUID='9b1a7740-0da3-46cd-a70c-06e004562d4b';
function env(){
  const dom=new JSDOM('<!doctype html><html><body>'+
    '<main><form><textarea id="prompt-textarea"></textarea>'+
    '<button id="composer-submit-button" data-testid="send-button" type="button">Send</button>'+
    '</form></main><section data-chatgpt-conversation-selection-target="true">'+
    '<div data-turn-key="u2"><div data-chatgpt-search-unit-key="turn2:user">'+
    '<div data-user-message-bubble></div></div></div></section>'+
    '</body></html>',{url:'https://chatgpt.com/c/'+UUID,
      runScripts:'outside-only',pretendToBeVisual:true});
  const win=dom.window as unknown as Window & typeof globalThis;
  Object.defineProperty(win.HTMLElement.prototype,'getBoundingClientRect',{
    configurable:true,value:()=>({left:40,top:40,width:180,height:40,
      right:220,bottom:80,x:40,y:40})});
  Object.defineProperty(win.document,'elementFromPoint',{value:()=>{
    return win.document.getElementById('composer-submit-button');}});
  return {dom,win,evalCode:(source:string)=>win.eval(source)};
}
describe('literal Apache 2.0 CCCC webpage JS reused in CoS',()=>{
  it('preserves exact upstream source hashes',()=>{
    expect(createHash('sha256').update(INSPECT_SUBMISSION_SCRIPT).digest('hex'))
      .toBe('8bf5df0c08f1e7fd2b3eb744c9738ffed1f3017014e72c35b2ac747584ef4744');
    expect(createHash('sha256').update(SELECT_SEND_CONTROL_SCRIPT).digest('hex'))
      .toBe('7242819f5a483bae79bfb856ac65c6997623d8c9a5db8a156d470860ccbbcbff');
    expect(createHash('sha256').update(REQUEST_SUBMIT_SCRIPT).digest('hex'))
      .toBe('075b024ef36b7b3df6f233626d211d0c8a4e78e0a43eb50994cb7287dfa48431');
  });
  it('direct CCCC script inspects bound draft and locates real send control',()=>{
    const {dom,win,evalCode}=env();
    const marker='[cos-web delivery:825f11d9-f78b-41c2-9ed7-a94586a4b30e]';
    const prompt=marker+'\nPlease respond.';
    const marked=evalCode('('+MARK_OWNED_COMPOSER_SCRIPT+')()') as {ready:boolean};
    expect(marked.ready).toBe(true);
    (win.document.getElementById('prompt-textarea') as HTMLTextAreaElement).value=prompt;
    const probe=evalCode('('+INSPECT_SUBMISSION_SCRIPT+')('+JSON.stringify({
      prompt,needles:[marker]})+')') as {composer_exact:boolean;echo_found:boolean};
    expect(probe.composer_exact).toBe(true);
    expect(probe.echo_found).toBe(false);
    const send=evalCode('('+SELECT_SEND_CONTROL_SCRIPT+')()') as {selector:string};
    expect(send.selector).toContain('data-cccc-web-model-send');
    let clicks=0;
    win.document.getElementById('composer-submit-button')?.addEventListener('click',()=>{clicks++;});
    const event=evalCode(oneShotSendScript({prompt,marker,url:win.location.href})) as
      {invoked:boolean};
    expect(event.invoked).toBe(true);
    expect(clicks).toBe(1);
    dom.window.close();
  });
  it('2026 user bubble is allowed to prove receipt, assistant quote never is',()=>{
    const {dom,win,evalCode}=env();
    const marker='[cos-web delivery:825f11d9-f78b-41c2-9ed7-a94586a4b30e]';
    const prompt=marker+'\nPlease respond.';
    const bubble=win.document.querySelector('[data-user-message-bubble]')!;
    const assistant=win.document.createElement('p');
    assistant.textContent=prompt;
    win.document.body.append(assistant);
    const run=()=>evalCode('('+MODERN_EXACT_USER_ECHO_SCRIPT+')('+
      JSON.stringify({completePrompt:prompt,marker})+')');
    expect(run()).toBe(false);
    bubble.textContent=prompt;
    expect(run()).toBe(true);
    bubble.textContent='Other user text';
    expect(run()).toBe(false);
    dom.window.close();
  });
  it('upstream probe cannot confuse assistant-quoted marker with user receipt',()=>{
    const {dom,win,evalCode}=env();
    const marker='[cos-web delivery:825f11d9-f78b-41c2-9ed7-a94586a4b30e]';
    const assistant=win.document.createElement('div');
    assistant.setAttribute('data-message-author-role','assistant');
    assistant.textContent=marker;
    win.document.body.append(assistant);
    const run=()=>evalCode('('+INSPECT_SUBMISSION_SCRIPT+')('+
      JSON.stringify({prompt:'',needles:[marker]})+')') as {echo_found:boolean};
    expect(run().echo_found).toBe(false);
    const user=win.document.createElement('div');
    user.setAttribute('data-message-author-role','user');
    user.textContent=marker;
    win.document.body.append(user);
    expect(run().echo_found).toBe(true);
    dom.window.close();
  });
});
