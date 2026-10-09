import {describe,it,expect} from 'vitest';
import {allowedOAuthStoragePermission,allowedOAuthPopup} from '../../src/main/next/web-first/login-permissions.js';
describe('web-first guarded OAuth UX',()=>{
  it('allows storage access only for trusted login origins or ChatGPT, never local machine capabilities',()=>{
    expect(allowedOAuthStoragePermission('storage-access','https://accounts.google.com','https://chatgpt.com')).toBe(true);
    expect(allowedOAuthStoragePermission('top-level-storage-access','https://auth.openai.com')).toBe(true);
    for(const permission of ['media','geolocation','fileSystem','notifications','openExternal','clipboard-read']){
      expect(allowedOAuthStoragePermission(permission,'https://chatgpt.com')).toBe(false);
    }
    expect(allowedOAuthStoragePermission('storage-access','https://accounts.google.com.evil.test','https://chatgpt.com')).toBe(false);
    expect(allowedOAuthStoragePermission('storage-access','https://accounts.google.com','https://evil.example')).toBe(false);
    expect(allowedOAuthStoragePermission('storage-access','http://chatgpt.com')).toBe(false);
  });
  it('permits only pinned HTTPS sign-in popups, never arbitrary pages or Javascript',()=>{
    expect(allowedOAuthPopup('https://accounts.google.com/signin/v2/identifier')).toBe(true);
    expect(allowedOAuthPopup('https://auth.openai.com/authorize')).toBe(true);
    expect(allowedOAuthPopup('https://chatgpt.com/api/auth/signin')).toBe(true);
    expect(allowedOAuthPopup('https://chatgpt.com/c/secret')).toBe(false);
    expect(allowedOAuthPopup('https://evil.example')).toBe(false);
    expect(allowedOAuthPopup('about:blank')).toBe(false);
    expect(allowedOAuthPopup('javascript:alert(1)')).toBe(false);
  });
});
