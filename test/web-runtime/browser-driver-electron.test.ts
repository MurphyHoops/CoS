import {describe,expect,it} from 'vitest';
import {isAllowedComputerNavigation,validateComputerAction} from '../../src/main/web-runtime/browser-driver-electron.js';
describe('native non-activating background website Computer Use contract',()=>{
  it('rejects all non-ChatGPT targets except isolated offline fixtures',()=>{
    expect(isAllowedComputerNavigation('https://chatgpt.com/c/123')).toBe(true);
    for(const address of ['https://chatgpt.com.attacker.example','http://chatgpt.com/',
      'file:///etc/passwd','javascript:alert(1)','https://auth.openai.com/',
      'https://user:pass@chatgpt.com/','data:text/html,offline']){
      expect(isAllowedComputerNavigation(address),address).toBe(false);
    }
    expect(isAllowedComputerNavigation('data:text/html,offline',true)).toBe(true);
  });
  it('rejects unbounded actions but admits safe per-page interactions',()=>{
    expect(()=>validateComputerAction({kind:'click',x:10,y:20})).not.toThrow();
    expect(()=>validateComputerAction({kind:'type',text:'website only'})).not.toThrow();
    expect(()=>validateComputerAction({kind:'key',key:'Enter'})).not.toThrow();
    for(const invalid of [{kind:'type',text:'x'.repeat(2001)},
      {kind:'click',x:-4,y:1},{kind:'scroll',x:20,y:3,deltaY:9999},
      {kind:'key',key:'Cmd+Tab'}, {kind:'quit-app'}, {kind:'global-keyboard'}]){
      expect(()=>validateComputerAction(invalid as never)).toThrow();
    }
  });
});
