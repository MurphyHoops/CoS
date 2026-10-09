import {describe,it,expect} from 'vitest';
import {JSDOM} from 'jsdom';
import {VISIBLE_REPLY_SCRIPT} from '../../src/main/next/web-first/web-reply-observer.js';
import {PAGE_CONTROLS_PROBE} from '../../src/main/next/web-first/web-page-controls.js';
import {MESSAGE_PROBE} from '../../src/main/next/web-first/native-web-input.js';
const uid='11111111-1111-4111-8111-111111111111';
const aid='22222222-2222-4222-8222-222222222222';
function modern(){
  const html='<div data-chatgpt-conversation-selection-target="true"><div data-turn-key="'+uid+'">'+
    '<div data-chatgpt-search-unit-key="fallback-turn-0:0:user" data-chatgpt-search-message-ids="'+uid+'">'+
    '<div data-user-message-bubble><div class="text-size-chat whitespace-pre-wrap">Check user prompt</div></div></div>'+
    '<div data-chatgpt-search-unit-key="fallback-turn-0:2:assistant" data-chatgpt-search-message-ids="'+aid+'">'+
    '<h4 data-conversation-role="assistant">ChatGPT</h4><div class="markdown">COS_NEXT_WEBPAGE_SMOKE_OK</div></div>'+
    '</div></div><div data-composer-body><div data-composer-markdown contenteditable="true" role="textbox"></div></div>';
  return new JSDOM('<!doctype html><html><body>'+html+'</body></html>',{runScripts:'outside-only'});
}
describe('2026 real Classic search-unit renderer in Web-First Electron',()=>{
  it('recognizes last assistant prose and stable native search-unit identity',()=>{
    const dom=modern(),result=dom.window.eval(VISIBLE_REPLY_SCRIPT);
    expect(result).toMatchObject({messageId:aid,text:'COS_NEXT_WEBPAGE_SMOKE_OK',
      editorReady:true,generating:false});
    dom.window.document.body.insertAdjacentHTML('beforeend',
      '<button data-testid="composer-stop-button"></button>');
    expect((dom.window.eval(VISIBLE_REPLY_SCRIPT) as {generating:boolean}).generating).toBe(true);
  });
  it('proves modern user message bubble exact source via native send probe',()=>{
    const dom=modern();
    const list=dom.window.eval(MESSAGE_PROBE) as string[];
    expect(list).toEqual(['Check user prompt']);
  });
  it('detects conversation count and editor readiness without old author-role fields',()=>{
    const dom=modern(),probe=dom.window.eval(PAGE_CONTROLS_PROBE);
    expect(probe).toMatchObject({visible:false,users:1,assistants:1,turns:1});
    expect(dom.window.document.querySelectorAll('[data-message-author-role]')).toHaveLength(0);
  });
});
