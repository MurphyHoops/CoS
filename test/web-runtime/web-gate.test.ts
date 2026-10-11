import {describe,it,expect} from 'vitest';
import {classifyRealWebGate} from '../../src/main/web-runtime/web-gate.js';
const base={
  official:true as const,composer:'EMPTY_OR_HIDDEN' as const,
  loginVisible:false,interstitial:false,documentStatus:200
};
describe('real ChatGPT webpage gate; fail closed without message side effects',()=>{
  it('recognizes a successful authenticated composer',()=>{
    expect(classifyRealWebGate({...base,composer:'READY'})).toBe('EDITOR_READY');
  });
  it('never mistakes a security verification page for login expiry',()=>{
    expect(classifyRealWebGate({...base,interstitial:true,documentStatus:403}))
      .toBe('SECURITY_CHECK_REQUIRED');
    expect(classifyRealWebGate({...base,interstitial:true,loginVisible:true}))
      .toBe('SECURITY_CHECK_REQUIRED');
  });
  it('distinguishes login, denied site, and still loading',()=>{
    expect(classifyRealWebGate({...base,loginVisible:true})).toBe('LOGIN_REQUIRED');
    expect(classifyRealWebGate({...base,documentStatus:403})).toBe('HTTP_BLOCKED');
    expect(classifyRealWebGate({...base,documentStatus:null})).toBe('PAGE_LOADING');
    expect(classifyRealWebGate({...base,official:false})).toBe('OTHER_SITE');
  });
  it('does not send into an existing draft or an active generation',()=>{
    expect(classifyRealWebGate({...base,composer:'DRAFT_PRESENT'}))
      .toBe('COMPOSER_OCCUPIED');
    expect(classifyRealWebGate({...base,composer:'GENERATING'}))
      .toBe('COMPOSER_OCCUPIED');
  });
});
