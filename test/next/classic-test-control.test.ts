import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { classicControlPermitted, classicTestTransportDisabled } from '../../src/main/next/runtime/classic-test-control.js';

const base={
  isNext:true,packaged:true,home:'/private/tmp/cos-next-ctl-abcde',
  userData:'/private/tmp/cos-next-ctl-abcde/Library/Application Support/chat-on-steroids-next',
  socket:'/private/tmp/cos-next-ctl-abcde/control.sock',temporaryRoot:'/private/tmp'
};
describe('Next Classic test socket isolation policy',()=>{
  it('enables offline test transport guard only for the explicit disposable profile',()=>{
    const keys=['HOME','COS_NEXT_E2E_TEMP_PROFILE','COS_NEXT_CLASSIC_WORKFLOW','COS_NEXT_TEST_CONTROL_SOCKET'] as const;
    const saved=keys.map(key=>process.env[key]);
    const home=path.join(os.tmpdir(),'cos-next-ctl-test-only');
    try {
      process.env.HOME=home;
      process.env.COS_NEXT_E2E_TEMP_PROFILE='1';
      process.env.COS_NEXT_CLASSIC_WORKFLOW='1';
      process.env.COS_NEXT_TEST_CONTROL_SOCKET=path.join(home,'control.sock');
      expect(classicTestTransportDisabled()).toBe(true);
      process.env.COS_NEXT_TEST_CONTROL_SOCKET=path.join(home,'../../outside.sock');
      expect(classicTestTransportDisabled()).toBe(false);
      delete process.env.COS_NEXT_E2E_TEMP_PROFILE;
      expect(classicTestTransportDisabled()).toBe(false);
    } finally {
      keys.forEach((key,i)=>{if(saved[i]===undefined)delete process.env[key];else process.env[key]=saved[i];});
    }
  });
  it('allows only an explicitly isolated packaged Next test',()=>{
    expect(classicControlPermitted(base)).toBe(true);
  });
  it('refuses the real Next userData, old app and dev launch',()=>{
    expect(classicControlPermitted({...base,userData:'/Users/example/Library/Application Support/chat-on-steroids-next'})).toBe(false);
    expect(classicControlPermitted({...base,isNext:false})).toBe(false);
    expect(classicControlPermitted({...base,packaged:false})).toBe(false);
  });
  it('refuses a socket outside the private session or a sibling with prefix',()=>{
    expect(classicControlPermitted({...base,socket:'/tmp/public.sock'})).toBe(false);
    expect(classicControlPermitted({...base,home:'/private/tmp/cos-next-ctl-abcde/../other'})).toBe(false);
    expect(classicControlPermitted({...base,home:'/private/tmp/cos-next-ctl-abcde/subdir'})).toBe(false);
    expect(classicControlPermitted({...base,home:'/Users/example'})).toBe(false);
  });
});
