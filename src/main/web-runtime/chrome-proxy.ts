/** Chrome headless does not consistently inherit macOS system HTTP(S)
 * proxies. Use the operator's existing system proxy, never change system
 * network settings, synthesize credentials or override enterprise PAC.
 *
 * Returned CLI flags contain only a validated host and port, never secrets.
 */
import {spawnSync} from 'node:child_process';
import os from 'node:os';

export function chromeProxyArgsFromSystemSnapshot(snapshot:string):string[]{
  if(typeof snapshot!=='string'||snapshot.length>20_000)return [];
  const props=new Map<string,string>();
  for(const line of snapshot.split(/\r?\n/)){
    const match=line.match(/^\s*([A-Za-z]+)\s*:\s*(.*?)\s*$/);
    if(match?.[1]!==undefined&&match[2]!==undefined)
      props.set(match[1],match[2]);
  }
  if(props.get('ProxyAutoConfigEnable')==='1'||
    props.get('ProxyAutoDiscoveryEnable')==='1')return [];
  const configured=(prefix:'HTTP'|'HTTPS')=>{
    if(props.get(prefix+'Enable')!=='1')return null;
    const host=props.get(prefix+'Proxy');
    const port=Number(props.get(prefix+'Port'));
    // Only a system-declared local proxy can be passed as a Chrome argument.
    // No user-supplied shell, URL, credentials, PAC, or arbitrary remote host.
    if(!host||!['127.0.0.1','localhost','::1'].includes(host)||
      !Number.isSafeInteger(port)||port<1||port>65535)return null;
    return 'http://'+(host==='::1'?'[::1]':host)+':'+port;
  };
  const http=configured('HTTP'),https=configured('HTTPS');
  if(!http&&!https)return [];
  if(http&&https&&http!==https)
    return ['--proxy-server=http='+http+';https='+https];
  return ['--proxy-server='+(https??http)];
}
export function currentSystemChromeProxyArgs():string[]{
  if(os.platform()!=='darwin')return [];
  const output=spawnSync('/usr/sbin/scutil',['--proxy'],{
    encoding:'utf8',timeout:3000,maxBuffer:24_000
  });
  if(output.error||output.status!==0||typeof output.stdout!=='string')return [];
  return chromeProxyArgsFromSystemSnapshot(output.stdout);
}
