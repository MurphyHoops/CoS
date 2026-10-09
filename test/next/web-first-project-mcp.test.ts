import {afterEach,describe,expect,it} from 'vitest';
import {mkdtemp,mkdir,writeFile,rm,symlink} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {WebFirstProjectRegistry} from '../../src/main/next/web-first/project-registry.js';
import {WebFirstReadAuthority,type ReadAction} from '../../src/main/next/web-first/project-read.js';
import {createWebFirstCoreLoopback} from '../../src/main/next/web-first/core-loopback.js';
import {readWebFirstLocalToolList,EXPECTED_READ_ONLY_CORE_TOOLS} from '../../src/main/next/web-first/core-catalogue.js';
const paths:string[]=[];
afterEach(async()=>{for(const name of paths.splice(0))await rm(name,{recursive:true,force:true});});
async function prepare(allow:ReadAction[]=[]){
  const temp=await mkdtemp(path.join(os.tmpdir(),'cos-web-first-mcp-'));paths.push(temp);
  await mkdir(path.join(temp,'profile'));await mkdir(path.join(temp,'project'));
  await writeFile(path.join(temp,'project','hello.txt'),'CONTENTS FROM DISPOSABLE FIXTURE');
  await writeFile(path.join(temp,'outside-secret.txt'),'NEVER_READ_OUTSIDE');
  const store=new WebFirstProjectRegistry(path.join(temp,'profile'));
  const p=await store.register(path.join(temp,'project'));
  const approvals:ReadAction[]=[];
  const authority=new WebFirstReadAuthority(store,async desc=>{approvals.push(desc.action);return allow.includes(desc.action);});
  const service=await createWebFirstCoreLoopback(authority);
  return {temp,service,p,approvals};
}
async function rpc(url:string,method:string,name?:string,args?:Record<string,unknown>,meta:Record<string,unknown>={}){
  const payload={jsonrpc:'2.0',id:5,method,params:{...(name?{name,arguments:args??{}}:{}),
    _meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28',
      'io.modelcontextprotocol/clientCapabilities':{},...meta}}};
  const res=await fetch(url,{method:'POST',headers:{'content-type':'application/json',
    accept:'application/json, text/event-stream','MCP-Protocol-Version':'2026-07-28',
    'Mcp-Method':method,...(name?{'Mcp-Name':name}:{})},body:JSON.stringify(payload)});
  const raw=await res.text();const json=JSON.parse(raw.startsWith('{')?raw:[...raw.matchAll(/^data: (.+)$/gm)].at(-1)?.[1]??'{}');
  return {status:res.status,data:json};
}
describe('Web-First read-only MCP over a real owner-controlled loopback socket',()=>{
  it('rejects discovery against any unapproved host, scheme, or route',async()=>{
    for(const value of ['https://127.0.0.1:443/web-first/'+ 'a'.repeat(43)+'/mcp',
      'http://localhost:9000/web-first/'+ 'a'.repeat(43)+'/mcp',
      'http://127.0.0.1:9000/not-an-mcp',
      'http://127.0.0.1:9000/web-first/'+ 'a'.repeat(43)+'/mcp?secret=1']){
      await expect(readWebFirstLocalToolList(value)).rejects.toThrow('WEBFIRST_LOCAL_MCP_ENDPOINT_INVALID');
    }
  });
  it('advertises only read-only diagnostics and per-request approved project tools',async()=>{
    const {service}=await prepare();try{
      const discovered=await readWebFirstLocalToolList(service.endpointUrl);
      expect(discovered).toEqual(EXPECTED_READ_ONLY_CORE_TOOLS);
      const r=await rpc(service.endpointUrl,'tools/list');
      const tools=r.data.result.tools;
      expect(r.status).toBe(200);
      expect(tools.map((x:{name:string})=>x.name).sort()).toEqual([
        'identity_diagnostics','project_list','project_ls','project_read','runtime_health']);
      expect(tools.every((x:{annotations:{readOnlyHint:boolean}})=>x.annotations.readOnlyHint)).toBe(true);
      const health=await rpc(service.endpointUrl,'tools/call','runtime_health');
      expect(health.data.result.structuredContent).toMatchObject({
        mcp:'LOCAL_ONLY',identity_verified:false,chatgpt_tool_registry:'NOT_VERIFIED',
        server_toolset:'web-first-readonly-p2b-v1'
      });
      expect(health.data.result.structuredContent.server_tools.sort()).toEqual([...EXPECTED_READ_ONLY_CORE_TOOLS]);
    }finally{await service.close();}
  });
  it('refuses project reads and forged host metadata without actual native approval',async()=>{
    const {service,p,approvals}=await prepare();try{
      const r=await rpc(service.endpointUrl,'tools/call','project_read',{
        project_id:p.id,relative_path:'hello.txt'}, {'openai/session':'FORGED_ADMIN'});
      expect(r.data.result.isError).toBe(true);
      expect(JSON.stringify(r.data)).toContain('NATIVE_APPROVAL_DENIED');
      expect(JSON.stringify(r.data)).not.toContain('CONTENTS FROM DISPOSABLE');
      expect(approvals).toEqual(['project_read']);
    }finally{await service.close();}
  });
  it('discloses only user-approved project IDs, directory names and bounded UTF-8 file contents',async()=>{
    const {service,p,temp}=await prepare(['project_list','project_ls','project_read']);try{
      const list=await rpc(service.endpointUrl,'tools/call','project_list');
      expect(JSON.stringify(list.data)).toContain(p.id);
      expect(JSON.stringify(list.data)).not.toContain(temp);
      const directory=await rpc(service.endpointUrl,'tools/call','project_ls',{
        project_id:p.id,relative_path:'.'});
      expect(JSON.stringify(directory.data)).toContain('hello.txt');
      const read=await rpc(service.endpointUrl,'tools/call','project_read',{
        project_id:p.id,relative_path:'hello.txt'});
      expect(JSON.stringify(read.data)).toContain('CONTENTS FROM DISPOSABLE FIXTURE');
    }finally{await service.close();}
  });
  it('never follows symlink escapes or ../ traversal, even if host approves',async()=>{
    const {service,p,temp}=await prepare(['project_read']);try{
      await symlink(path.join(temp,'outside-secret.txt'),path.join(temp,'project','escape.txt'));
      for(const relative of ['../outside-secret.txt','escape.txt','/etc/passwd']){
        const out=await rpc(service.endpointUrl,'tools/call','project_read',{
          project_id:p.id,relative_path:relative});
        expect(out.data.result.isError).toBe(true);
        expect(JSON.stringify(out.data)).not.toContain('NEVER_READ_OUTSIDE');
      }
    }finally{await service.close();}
  });
  it('rejects browser-origin requests, wrong paths, oversized bodies and script execution tools',async()=>{
    const {service}=await prepare();try{
      expect((await fetch(service.endpointUrl,{headers:{Origin:'https://chatgpt.com'}})).status).toBe(403);
      const origin=new URL(service.endpointUrl);
      expect((await fetch(origin.origin+'/bad')).status).toBe(404);
      const meta=origin.origin+'/.well-known/oauth-protected-resource'+origin.pathname;
      const discovered=await fetch(meta);
      expect(discovered.status).toBe(200);
      expect(await discovered.json()).toMatchObject({resource:service.endpointUrl,authorization_servers:[]});
      expect((await fetch(meta,{method:'POST'})).status).toBe(405);
      expect((await rpc(service.endpointUrl,'tools/call','exec_command',{command:'rm -rf /'})).data.result?.isError).toBeUndefined();
      expect((await fetch(service.endpointUrl,{method:'POST',headers:{'content-type':'application/json'},
        body:'X'.repeat(65560)})).status).toBe(413);
    }finally{await service.close();}
  });
});
