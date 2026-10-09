import {describe,it,expect} from 'vitest';
import {parseBrokerSignal} from '../../src/main/next/web-first/core-broker.js';
import path from 'node:path';
import {importedProfile,validateImportedTunnelConfiguration,webFirstBundledTunnelBinary,coreRecoveryDecision,coreRecoveryEligible} from '../../src/main/next/web-first/core-transport.js';
describe('Web-First existing Core adoption preflight only (no network / credential)',()=>{
  it('does not auto-retry on healthy owner, orphan or revoked approval; caps attempts',()=>{
    const basic={requested:true,brokerAlive:false,ownerPresent:false,attempts:0,dueAt:100,now:100};
    expect(coreRecoveryDecision(basic)).toBe('retry');
    expect(coreRecoveryDecision({...basic,now:99})).toBe('idle');
    expect(coreRecoveryDecision({...basic,requested:false})).toBe('idle');
    expect(coreRecoveryDecision({...basic,brokerAlive:true})).toBe('idle');
    expect(coreRecoveryDecision({...basic,ownerPresent:true})).toBe('hold');
    expect(coreRecoveryDecision({...basic,attempts:4})).toBe('hold');
  });

  it('fences recovery during close/quit and after async connection-flight changes',()=>{
    const good={offline:false,closing:false,quitting:false,requested:true,
      localService:true,windowAlive:true,recovering:false,connectionInFlight:false};
    expect(coreRecoveryEligible(good)).toBe(true);
    for(const key of ['offline','closing','quitting','recovering','connectionInFlight'] as const){
      expect(coreRecoveryEligible({...good,[key]:true})).toBe(false);
    }
    for(const key of ['requested','localService','windowAlive'] as const){
      expect(coreRecoveryEligible({...good,[key]:false})).toBe(false);
    }
  });
  it('accepts only exact control-plane broker signals, not untrusted log text',()=>{
    expect(parseBrokerSignal('WEBFIRST_CORE_BROKER_READY')).toBe('READY');
    expect(parseBrokerSignal('WEBFIRST_CORE_BROKER_CONNECTED')).toBe('CONNECTED');
    expect(parseBrokerSignal('WEBFIRST_CORE_BROKER_STOPPED_PROVEN')).toBe('STOPPED_PROVEN');
    expect(parseBrokerSignal('WEBFIRST_CORE_BROKER_CONNECTED extra')).toBeNull();
    expect(parseBrokerSignal('WEBFIRST_CORE_BROKER_SECRET_LEAK')).toBeNull();
    expect(parseBrokerSignal('READY')).toBeNull();
  });
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
