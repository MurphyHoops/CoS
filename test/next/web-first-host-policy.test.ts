import {describe,it,expect} from 'vitest';
import {CHATGPT_START_URL,WEB_FIRST_PARTITION,classifyWebFirstNavigation,
  isAllowedWebFirstNavigation,sanitizedNavigationLabel} from '../../src/main/next/web-first/host-policy.js';
describe('isolated Chrome-free WebContentsView P1 navigation policy',()=>{
  it('starts on official ChatGPT with its own persistent Electron partition',()=>{
    expect(CHATGPT_START_URL).toBe('https://chatgpt.com/');
    expect(WEB_FIRST_PARTITION).toMatch(/^persist:cos-next-web-first/);
    expect(classifyWebFirstNavigation('https://chatgpt.com/c/private-id?x=secret')).toBe('chatgpt');
    expect(classifyWebFirstNavigation('https://auth.openai.com/authorize?code=secret')).toBe('login');
  });
  it('rejects ordinary websites, subdomain confusion, insecure and credential-bearing URLs',()=>{
    for(const value of ['http://chatgpt.com','https://chatgpt.com.evil.test',
      'https://openai.com/','file:///etc/passwd','javascript:alert(1)',
      'data:text/html,hello','https://foo.chatgpt.com',
      'https://a:password@chatgpt.com/','https://chatgpt.com:8080/']){
      expect(isAllowedWebFirstNavigation(value),value).toBe(false);
    }
  });
  it('never returns query, path or authentication ticket in diagnostic labels',()=>{
    expect(sanitizedNavigationLabel('https://chatgpt.com/c/PRIVATE?ticket=SECRET')).toBe('chatgpt');
    expect(sanitizedNavigationLabel('https://accounts.google.com/?secret=XYZ')).toBe('login');
    expect(sanitizedNavigationLabel('https://other.example/a?key=PRIVATE')).toBe('blocked');
  });
});
