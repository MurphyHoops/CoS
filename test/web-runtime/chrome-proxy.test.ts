import {describe,it,expect} from 'vitest';
import {chromeProxyArgsFromSystemSnapshot}
  from '../../src/main/web-runtime/chrome-proxy.js';

const system=(extra='')=>[
 '  HTTPEnable : 1','  HTTPProxy : 127.0.0.1','  HTTPPort : 1082',
 '  HTTPSEnable : 1','  HTTPSProxy : 127.0.0.1','  HTTPSPort : 1082',
 extra
].join('\n');

describe('headless standard Chrome uses existing macOS system proxy',()=>{
 it('uses the exact local HTTPS proxy without credentials or changing OS configuration',()=>{
   expect(chromeProxyArgsFromSystemSnapshot(system()))
     .toEqual(['--proxy-server=http://127.0.0.1:1082']);
 });
 it('leaves direct/no-proxy and PAC-only configurations untouched',()=>{
   expect(chromeProxyArgsFromSystemSnapshot('HTTPEnable : 0\nHTTPSEnable : 0'))
     .toEqual([]);
   expect(chromeProxyArgsFromSystemSnapshot(system('ProxyAutoConfigEnable : 1')))
     .toEqual([]);
 });
 it('rejects malformed or untrusted remote proxy arguments',()=>{
   expect(chromeProxyArgsFromSystemSnapshot(system().replaceAll(
     '127.0.0.1','attacker.example'))).toEqual([]);
   expect(chromeProxyArgsFromSystemSnapshot(system().replace(
     'HTTPSPort : 1082','HTTPSPort : 99999'))).toEqual(
       ['--proxy-server=http://127.0.0.1:1082']);
   expect(chromeProxyArgsFromSystemSnapshot(system().replaceAll(
     '127.0.0.1','bad;--no-sandbox'))).toEqual([]);
 });
 it('keeps independent local HTTP and HTTPS proxy ports',()=>{
   expect(chromeProxyArgsFromSystemSnapshot(system().replace(
     'HTTPSPort : 1082','HTTPSPort : 1083')))
     .toEqual(['--proxy-server=http=http://127.0.0.1:1082;https=http://127.0.0.1:1083']);
 });
});
