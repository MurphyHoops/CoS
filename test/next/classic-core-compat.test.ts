import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {createMcpHandler} from '@modelcontextprotocol/server';
import {buildServer, type ToolContext} from '../../src/main/mcp/tools.js';
import {DEFAULT_CAPABILITIES} from '../../src/shared/types.js';

const saved={
  next:process.env.COS_NEXT_CLASSIC_WORKFLOW,
  identity:process.env.COS_NEXT_IDENTITY_DIAGNOSTICS
};
const ctx:ToolContext={roots:[],caps:{...DEFAULT_CAPABILITIES,read:true},readOnly:true,sessionTools:false,agentTools:false};
async function method(name:string,params:Record<string,unknown>={}){
  const handler=createMcpHandler(()=>buildServer(ctx,'core'));
  try{
    const r=await handler.fetch(new Request('http://localhost/mcp',{
      method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream',
        'MCP-Protocol-Version':'2026-07-28','Mcp-Method':name,
        ...(typeof params.name==='string'?{'Mcp-Name':params.name}:{})},
      body:JSON.stringify({jsonrpc:'2.0',id:1,method:name,params:{...params,
        _meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28',
          'io.modelcontextprotocol/clientCapabilities':{}}}})
    }));
    const text=await r.text();
    return JSON.parse(text.startsWith('{')?text:[...text.matchAll(/^data: (.+)$/gm)].at(-1)![1]!);
  }finally{await handler.close();}
}
describe('Next Classic compatibility for cached v4 diagnostic names',()=>{
  beforeEach(()=>{process.env.COS_NEXT_CLASSIC_WORKFLOW='1';delete process.env.COS_NEXT_IDENTITY_DIAGNOSTICS;});
  afterEach(()=>{
    if(saved.next===undefined)delete process.env.COS_NEXT_CLASSIC_WORKFLOW;
    else process.env.COS_NEXT_CLASSIC_WORKFLOW=saved.next;
    if(saved.identity===undefined)delete process.env.COS_NEXT_IDENTITY_DIAGNOSTICS;
    else process.env.COS_NEXT_IDENTITY_DIAGNOSTICS=saved.identity;
  });
  it('advertises harmless cached names alongside the genuine Classic coding surface',async()=>{
    const r=await method('tools/list');
    const names=r.result.tools.map((tool:{name:string})=>tool.name);
    expect(names).toContain('runtime_health');
    expect(names).toContain('identity_diagnostics');
    expect(names).toContain('read');
    expect(names).not.toContain('mission');
  });
  it('returns a truthful no-authority runtime projection without connector secrets',async()=>{
    const r=await method('tools/call',{name:'runtime_health',arguments:{}});
    expect(r.result.structuredContent).toMatchObject({
      runtime:'NEXT_CLASSIC',identity_verified:false,mission_authorized:false,
      provider_reply_verified:false
    });
    expect(JSON.stringify(r)).not.toMatch(/tunnel_[a-f0-9]{32}|CONTROL_PLANE_API_KEY|mcp\/core\/[-_\w]{20,}/);
  });
  it('keeps host-identity inspection disabled rather than silently granting it',async()=>{
    const r=await method('tools/call',{name:'identity_diagnostics',arguments:{}});
    expect(r.result.structuredContent).toMatchObject({
      status:'IDENTITY_DIAGNOSTICS_DISABLED',identity_verified:false,mission_authorized:false
    });
  });
  it('leaves the original v3 Core surface and identity opt-in policy unchanged',async()=>{
    delete process.env.COS_NEXT_CLASSIC_WORKFLOW;
    const r=await method('tools/list');
    const names=r.result.tools.map((tool:{name:string})=>tool.name);
    expect(names).not.toContain('runtime_health');
    expect(names).not.toContain('identity_diagnostics');
    expect(names).toContain('read');
  });
});
