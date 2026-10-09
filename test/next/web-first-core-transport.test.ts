import {describe,it,expect} from 'vitest';
import path from 'node:path';
import {importedProfile,validateImportedTunnelConfiguration,webFirstBundledTunnelBinary} from '../../src/main/next/web-first/core-transport.js';
describe('Web-First existing Core adoption preflight only (no network / credential)',()=>{
  it('accepts strictly existing Next-owned tunnel registrations',()=>{
    const t=validateImportedTunnelConfiguration({tunnel:{kind:'openai',tunnelId:'tunnel_'+ 'a'.repeat(32)}});
    expect(t.kind).toBe('openai');
    expect(t.tunnelId).toBe('tunnel_'+ 'a'.repeat(32));
    expect('binaryPath' in t).toBe(false);
  });
  it('rejects malformed or alternate transport definitions without probing secrets',()=>{
    for(const value of [null,{}, {tunnel:{}},{tunnel:{kind:'manual'}},
      {tunnel:{kind:'cloudflared',tunnelId:'tunnel_'+ 'a'.repeat(32)}},
      {tunnel:{kind:'openai',tunnelId:'../../wrong'}},
      {tunnel:{kind:'openai',tunnelId:'tunnel_'+ 'g'.repeat(32)}}]){
      expect(()=>validateImportedTunnelConfiguration(value)).toThrow('TUNNEL_CONFIG_INVALID');
    }
  });
  it('points only to existing Next profile, never original v3 CoS or the Web-First preview',()=>{
    expect(webFirstBundledTunnelBinary('/Applications/Test.app/Contents/Resources')).toBe('/Applications/Test.app/Contents/Resources/tunnel/tunnel-client');
    expect(()=>webFirstBundledTunnelBinary(undefined)).toThrow('WEBFIRST_BUNDLED_TUNNEL_UNAVAILABLE');
    const original=(process as NodeJS.Process & {resourcesPath?:string}).resourcesPath;
    (process as NodeJS.Process & {resourcesPath?:string}).resourcesPath='/Applications/Test.app/Contents/Resources';
    const source=importedProfile('/Users/qa/Library/Application Support');
    if(original===undefined)Reflect.deleteProperty(process,'resourcesPath');
    else (process as NodeJS.Process & {resourcesPath?:string}).resourcesPath=original;
    expect(source.sourceUserData).toBe(path.join('/Users/qa/Library/Application Support','chat-on-steroids-next'));
    expect(source.configFile).toBe(path.join(source.sourceUserData,'config.json'));
    expect(()=>importedProfile('relative')).toThrow('WEBFIRST_APPDATA_INVALID');
  });
});
