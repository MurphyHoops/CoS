/** Local protocol proof only: not the frozen platform-approved ChatGPT toolset. */
import {WEBFIRST_CORE_TOOLS} from './project-mcp.js';
export const EXPECTED_READ_ONLY_CORE_TOOLS=Object.freeze([...WEBFIRST_CORE_TOOLS].sort());
export async function readWebFirstLocalToolList(endpointUrl:string):Promise<ReadonlyArray<string>> {
  const address=new URL(endpointUrl);
  if(address.protocol!=='http:'||address.hostname!=='127.0.0.1'||
      !/^\/web-first\/[A-Za-z0-9_-]{30,96}\/mcp$/.test(address.pathname)||
      address.username||address.password||address.search||address.hash)
    throw Error('WEBFIRST_LOCAL_MCP_ENDPOINT_INVALID');
  const request={jsonrpc:'2.0',id:'local-tools-audit',method:'tools/list',
    params:{_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28',
      'io.modelcontextprotocol/clientCapabilities':{}}}};
  const response=await fetch(endpointUrl,{method:'POST',headers:{
    'content-type':'application/json',accept:'application/json, text/event-stream',
    'MCP-Protocol-Version':'2026-07-28','Mcp-Method':'tools/list'
  },body:JSON.stringify(request),signal:AbortSignal.timeout(4000)});
  if(!response.ok)throw Error('WEBFIRST_LOCAL_MCP_DISCOVERY_FAILED');
  const body=await response.text();
  if(body.length>64000)throw Error('WEBFIRST_LOCAL_MCP_DISCOVERY_OVERSIZE');
  const payload=body.startsWith('{')?body:
    [...body.matchAll(/^data: (\{.*\})$/gm)].at(-1)?.[1];
  if(!payload)throw Error('WEBFIRST_LOCAL_MCP_DISCOVERY_INVALID');
  const result:unknown=JSON.parse(payload);
  if(!result||typeof result!=='object'||Array.isArray(result))throw Error('WEBFIRST_LOCAL_MCP_DISCOVERY_INVALID');
  const tools=(result as {result?:{tools?:unknown}}).result?.tools;
  if(!Array.isArray(tools)||tools.length>32)throw Error('WEBFIRST_LOCAL_MCP_DISCOVERY_INVALID');
  const names=tools.map((t:unknown)=>{
    if(!t||typeof t!=='object'||typeof (t as {name?:unknown}).name!=='string')
      throw Error('WEBFIRST_LOCAL_MCP_DISCOVERY_INVALID');
    return (t as {name:string}).name;
  }).sort();
  if(new Set(names).size!==names.length||names.join('|')!==EXPECTED_READ_ONLY_CORE_TOOLS.join('|'))
    throw Error('WEBFIRST_LOCAL_MCP_TOOLSET_DRIFT');
  return names;
}
