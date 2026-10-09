import {afterEach,describe,it,expect} from 'vitest';
import {mkdtemp,rm,chmod,symlink} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {conversationFromUrl,WebReplySettleTracker,WebFirstReplyJournal} from '../../src/main/next/web-first/web-reply-observer.js';
const ids:string[]=[];
afterEach(async()=>{for(const id of ids.splice(0))await rm(id,{recursive:true,force:true});});
const conv='11111111-2222-4333-8444-555555555555';
const message={conversationId:conv,messageId:'msg-1',text:'OFFLINE_ASSISTANT_TEST_REPLY',editorReady:true,generating:false};
describe('native Chromium visible web assistant reply tracking',()=>{
  it('accepts only an exact ChatGPT chat URL',()=>{
    expect(conversationFromUrl('https://chatgpt.com/c/'+conv)).toBe(conv);
    expect(conversationFromUrl('https://evil-chatgpt.com/c/'+conv)).toBeNull();
    expect(conversationFromUrl('https://chatgpt.com/settings')).toBeNull();
  });
  it('requires a settled unstreaming assistant and never duplicates unchanged DOM',()=>{
    const tracker=new WebReplySettleTracker();
    expect(tracker.observe({...message,generating:true},0)).toBeNull();
    expect(tracker.observe(message,1000)).toBeNull();
    expect(tracker.observe(message,3500)).toBeNull();
    expect(tracker.observe(message,5500)).toEqual(message);
    expect(tracker.observe(message,8000)).toBeNull();
    expect(tracker.observe({...message,text:'SECOND_REPLY'},9000)).toBeNull();
    expect(tracker.observe({...message,text:'SECOND_REPLY'},14500)?.text).toBe('SECOND_REPLY');
    expect(tracker.observe({...message,editorReady:false},20000)).toBeNull();
  });
  it('persisted opt-in replies are deduplicated and refuse untrusted ledgers',async()=>{
    const dir=await mkdtemp(path.join(os.tmpdir(),'cos-web-replies-'));ids.push(dir);
    const store=new WebFirstReplyJournal(dir);
    expect(await store.record(message)).not.toBeNull();
    expect(await new WebFirstReplyJournal(dir).record(message)).toBeNull();
    expect((await store.last()).map(x=>x.text)).toEqual(['OFFLINE_ASSISTANT_TEST_REPLY']);
    const file=path.join(dir,'web-first-replies.jsonl');
    await chmod(file,0o644);await expect(store.last()).rejects.toThrow('REPLY_JOURNAL_UNSAFE');
    await rm(file);await symlink(dir,file);
    await expect(store.record(message)).rejects.toThrow('REPLY_JOURNAL_UNSAFE');
  });
});
