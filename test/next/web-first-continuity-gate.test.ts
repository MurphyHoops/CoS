import {describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {assessContinuity,createContinuityLease} from '../../src/main/next/web-first/continuity-gate.js';
import type {DurableTask} from '../../src/main/next/web-first/task-ledger.js';
import type {NativeWebSend} from '../../src/main/next/web-first/web-outbox.js';
const taskId=randomUUID(),conversationId=randomUUID(),now=1_800_000_000_000;
const lease=createContinuityLease({taskId,conversationId,now,maxTurns:3,
  maxMinutes:15,baselineAssistantMessage:'assistant-old'});
const task:DurableTask={id:taskId,projectId:'project-x',projectRoot:'/tmp/project-x',rootDev:1,rootIno:2,
  goal:'Test only',phase:'active',revision:2,createdAt:now-100,updatedAt:now+6000,
  waitUntil:null,events:[{revision:1,kind:'created',at:now-100,nonce:null,note:null},
    {revision:2,kind:'checkpoint',at:now+6000,nonce:'proof-1234',note:'progress'}]};
const prompt:NativeWebSend={id:randomUUID(),taskId,conversationId,text:'Continue',nonce:randomUUID(),
  state:'delivered',createdAt:now+1000,updatedAt:now+2000,proof:'dom:proof'};
const reply={conversationId,messageId:'assistant-new',text:'Work continued',editorReady:true,generating:false};
const currentUrl='https://chatgpt.com/c/'+conversationId;
const args={lease,now:now+7000,currentUrl,task,outbox:[prompt],latestReply:reply,replySettled:true,replyObservedAt:now+7000};
describe('Native Web-First continuation operator gate',()=>{
  it('blocks unbound tabs, expired grants, wrong tasks and non-active tasks',()=>{
    expect(assessContinuity({...args,lease:null}).reason).toBe('NO_NATIVE_LEASE');
    expect(assessContinuity({...args,now:now+16*60_000}).reason).toBe('LEASE_EXPIRED');
    expect(assessContinuity({...args,currentUrl:'https://evil.com/c/'+conversationId}).reason).toBe('CHAT_CHANGED');
    expect(assessContinuity({...args,task:null}).reason).toBe('TASK_CHANGED');
    expect(assessContinuity({...args,task:{...task,phase:'waiting'}}).reason).toBe('TASK_NOT_ACTIVE');
    expect(assessContinuity({...args,task:{...task,phase:'recovery-hold'}}).reason).toBe('TASK_NOT_ACTIVE');
  });
  it('refuses uncertain outbox, exhausted turn budget, stale assistant and missing checkpoint',()=>{
    expect(assessContinuity({...args,outbox:[{...prompt,state:'uncertain'}]}).reason).toBe('OUTBOX_AMBIGUOUS');
    expect(assessContinuity({...args,outbox:[prompt,prompt,prompt]}).reason).toBe('TURN_LIMIT');
    expect(assessContinuity({...args,replySettled:false}).reason).toBe('REPLY_NOT_SETTLED');
    expect(assessContinuity({...args,latestReply:{...reply,messageId:'assistant-old'}}).reason).toBe('OLD_ASSISTANT_REPLY');
    expect(assessContinuity({...args,replyObservedAt:now+1000}).reason).toBe('OLD_ASSISTANT_REPLY');
    expect(assessContinuity({...args,task:{...task,events:task.events.filter(e=>e.kind!=='checkpoint')}}).reason).toBe('CHECKPOINT_NOT_NEW');
  });
  it('never asserts autonomous readiness without a trusted provider completion signal',()=>{
    const passed=assessContinuity(args);
    expect(passed.manualNextTurnReady).toBe(true);
    expect(passed.autonomousNextTurnAllowed).toBe(false);
    expect(passed.reason).toBe('NO_PROVIDER_COMPLETION_PROOF');
  });
  it('enforces bounded 1–5 turns and <=60-minute session leases',()=>{
    expect(()=>createContinuityLease({...lease,now,maxTurns:100,maxMinutes:15})).toThrow('CONTINUITY_LEASE_INVALID');
    expect(()=>createContinuityLease({...lease,now,maxTurns:3,maxMinutes:100})).toThrow('CONTINUITY_LEASE_INVALID');
  });
});
