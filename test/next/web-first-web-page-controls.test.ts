import {describe,it,expect} from 'vitest';
import {classifyWebControls,inspectNativeChatGPTPage} from '../../src/main/next/web-first/web-page-controls.js';
describe('Electron ChatGPT webpage computer-control preflight',()=>{
  const url='https://chatgpt.com/c/12345678-1234-4123-8123-123456789abc';
  it('detects a ready editor only for a pinned ChatGPT conversation',()=>{
    const page=classifyWebControls(url,
      {visible:true,draft:false,generating:false,send:true,users:12,assistants:10});
    expect(page).toMatchObject({page:'CHATGPT',conversation:true,composer:'READY',
      canAttemptOneApprovedTurn:true,sendButtonVisible:true});
    for(const u of ['https://evilchatgpt.com/c/12345678-1234-4123-8123-123456789abc',
      'http://chatgpt.com/c/12345678-1234-4123-8123-123456789abc','https://chatgpt.com/']){
      expect(classifyWebControls(u,{visible:true}).canAttemptOneApprovedTurn).toBe(false);
    }
  });
  it('detects occupied editor, generating replies, bad source and navigation race',async()=>{
    for(const fields of [{visible:true,draft:true},{visible:true,generating:true},{}]){
      expect(classifyWebControls(url,fields).canAttemptOneApprovedTurn).toBe(false);
    }
    const fake={isDestroyed:()=>false,getURL:()=>url,
      executeJavaScript:async()=>({visible:true,draft:false,users:3.6,assistants:Infinity})};
    const result=await inspectNativeChatGPTPage(fake as never);
    expect(result).toMatchObject({canAttemptOneApprovedTurn:true,userMessages:0,assistantMessages:0});
    const bad={...fake,getURL:()=> 'https://attacker.example/'};
    await expect(inspectNativeChatGPTPage(bad as never)).rejects.toThrow('WEB_CONTROL_PAGE_NOT_ALLOWED');
  });
  it('offline fixtures are never cleared for a real model turn',()=>{
    expect(classifyWebControls('data:text/html,offline',
      {visible:true,draft:false,generating:false,send:true,users:1,assistants:1},true))
      .toMatchObject({page:'OFFLINE_FIXTURE',canAttemptOneApprovedTurn:false});
  });
});
