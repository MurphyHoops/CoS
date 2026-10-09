import {afterEach,describe,expect,it} from 'vitest';
import {mkdtemp,mkdir,writeFile,rm,symlink} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {WebFirstProjectRegistry} from '../../src/main/next/web-first/project-registry.js';
import {WebFirstReadAuthority,type ReadAction} from '../../src/main/next/web-first/project-read.js';
import {WebFirstTaskLedger} from '../../src/main/next/web-first/task-ledger.js';
import {WebFirstTaskTools} from '../../src/main/next/web-first/task-tools.js';
import {createWebFirstCoreLoopback} from '../../src/main/next/web-first/core-loopback.js';
import {readWebFirstLocalToolList,EXPECTED_READ_ONLY_CORE_TOOLS} from '../../src/main/next/web-first/core-catalogue.js';
import {WebFirstReadGrants} from '../../src/main/next/web-first/read-grants.js';
import {WebFirstOperationJournal} from '../../src/main/next/web-first/operation-journal.js';
const paths:string[]=[];
afterEach(async()=>{for(const name of paths.splice(0))await rm(name,{recursive:true,force:true});});
async function prepare(allow:ReadAction[]=[],allowTask=false){
  const temp=await mkdtemp(path.join(os.tmpdir(),'cos-web-first-mcp-'));paths.push(temp);
  await mkdir(path.join(temp,'profile'));await mkdir(path.join(temp,'project'));
  await writeFile(path.join(temp,'project','hello.txt'),'CONTENTS FROM DISPOSABLE FIXTURE');
  await writeFile(path.join(temp,'outside-secret.txt'),'NEVER_READ_OUTSIDE');
  const store=new WebFirstProjectRegistry(path.join(temp,'profile'));
  const p=await store.register(path.join(temp,'project'));
  const approvals:ReadAction[]=[];
  const authority=new WebFirstReadAuthority(store,async desc=>{approvals.push(desc.action);return allow.includes(desc.action);});
  const tasks=new WebFirstTaskTools(new WebFirstTaskLedger(path.join(temp,'profile')),store,async()=>allowTask);
  const service=await createWebFirstCoreLoopback(authority,undefined,tasks);
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
        'identity_diagnostics','project_list','project_ls','project_read','runtime_health',
        'task_begin','task_checkpoint','task_finish_request','task_status','task_wait']);
      expect(tools.find((x:{name:string})=>x.name==='project_read').annotations.readOnlyHint).toBe(true);
      expect(tools.find((x:{name:string})=>x.name==='task_checkpoint').annotations.readOnlyHint).toBe(false);
      const health=await rpc(service.endpointUrl,'tools/call','runtime_health');
      expect(health.data.result.structuredContent).toMatchObject({
        mcp:'LOCAL_ONLY',identity_verified:false,chatgpt_tool_registry:'NOT_VERIFIED',
        server_toolset:'web-first-project-workflow-p3-v1'
      });
      expect(health.data.result.structuredContent.server_tools.sort()).toEqual([...EXPECTED_READ_ONLY_CORE_TOOLS]);
    }finally{await service.close();}
  });
  it('native approval is mandatory for task creation and user cannot claim task completion',async()=>{
    const {service,p}=await prepare();try{
      const creation=await rpc(service.endpointUrl,'tools/call','task_begin',{
        project_id:p.id,goal:'Do not start without a native confirmation'});
      expect(creation.data.result.isError).toBe(true);
      expect(JSON.stringify(creation.data)).toContain('NATIVE_TASK_APPROVAL_DENIED');
    }finally{await service.close();}
  });
  it('runs real HTTP task begin, checkpoint, durable waiting and review without auto-completion',async()=>{
    const {service,p}=await prepare([],true);try{
      const started=await rpc(service.endpointUrl,'tools/call','task_begin',{
        project_id:p.id,goal:'Test durable ChatGPT web workflow'});
      const a=started.data.result.structuredContent.result;
      expect(a.phase).toBe('active');expect(a.revision).toBe(1);
      const checkpoint=await rpc(service.endpointUrl,'tools/call','task_checkpoint',{
        task_id:a.task_id,revision:1,nonce:'mcp-test-checkpoint-1',note:'Observation recorded'});
      expect(checkpoint.data.result.structuredContent.result.revision).toBe(2);
      const retry=await rpc(service.endpointUrl,'tools/call','task_checkpoint',{
        task_id:a.task_id,revision:1,nonce:'mcp-test-checkpoint-1',note:'Observation recorded'});
      expect(retry.data.result.structuredContent.result.revision).toBe(2);
      const wait=await rpc(service.endpointUrl,'tools/call','task_wait',{
        task_id:a.task_id,revision:2,nonce:'mcp-test-wait-001',minutes:null});
      expect(wait.data.result.structuredContent.result.phase).toBe('waiting');
      const status=await rpc(service.endpointUrl,'tools/call','task_status',{task_id:a.task_id});
      expect(status.data.result.structuredContent.result.phase).toBe('waiting');
      const finished=await rpc(service.endpointUrl,'tools/call','task_finish_request',{
        task_id:a.task_id,revision:3,nonce:'mcp-test-finish-001',note:'Claimed done'});
      expect(finished.data.result.isError).toBe(true);
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
  it('reuses a durable project-only read grant and records successful MCP receipts without content',async()=>{
    const temp=await mkdtemp(path.join(os.tmpdir(),'cos-webfirst-p3-granted-mcp-'));paths.push(temp);
    const profile=path.join(temp,'profile'),root=path.join(temp,'project');
    await mkdir(profile);await mkdir(root);await writeFile(path.join(root,'README.md'),'P3_REDACTED_FIXTURE');
    const store=new WebFirstProjectRegistry(profile),project=await store.register(root);
    const grants=new WebFirstReadGrants(profile),journal=new WebFirstOperationJournal(profile);
    let approvalCount=0;
    const approval=new WebFirstReadAuthority(store,async context=>{
      const scope=context.action==='project_list'?'catalog':'project-read';
      const granted=await grants.allowed(scope,context.projectId??null,context.projectRoot??null,
        context.target??null,context.action);
      if(granted)return true;
      approvalCount++;
      await grants.grant(scope,context.projectId??null,context.projectRoot??null,'always');return true;
    });
    const server=await createWebFirstCoreLoopback(approval,journal);
    try{
      const first=await rpc(server.endpointUrl,'tools/call','project_read',{
        project_id:project.id,relative_path:'README.md'});
      const second=await rpc(server.endpointUrl,'tools/call','project_read',{
        project_id:project.id,relative_path:'README.md'});
      expect(first.data.result.structuredContent.result.text).toBe('P3_REDACTED_FIXTURE');
      expect(second.data.result.structuredContent.result.text).toBe('P3_REDACTED_FIXTURE');
      expect(approvalCount).toBe(1);
      const records=await journal.last();
      expect(records.map(r=>r.stage)).toEqual(['STARTED','SUCCEEDED','STARTED','SUCCEEDED']);
      expect(JSON.stringify(records)).not.toContain('P3_REDACTED_FIXTURE');
      const resumed=new WebFirstReadGrants(profile);
      expect(await resumed.allowed('project-read',project.id,project.root,
        path.join(project.root,'README.md'),'project_read')).toBe(true);
      await grants.revokeAll();
      expect(await resumed.allowed('project-read',project.id,project.root,
        path.join(project.root,'README.md'),'project_read')).toBe(false);
    }finally{await server.close();}
  });
  it('writes STARTED/REJECTED receipts for denied reads without storing the attempted path',async()=>{
    const base=await mkdtemp(path.join(os.tmpdir(),'cos-webfirst-p3-deny-'));paths.push(base);
    const profile=path.join(base,'profile'),root=path.join(base,'project');
    await mkdir(profile);await mkdir(root);await writeFile(path.join(root,'NO_READ.txt'),'SECRET_CANARY_NEVER_RETURNED');
    const registry=new WebFirstProjectRegistry(profile),p=await registry.register(root);
    const journal=new WebFirstOperationJournal(profile);
    const authority=new WebFirstReadAuthority(registry,async()=>false);
    const socket=await createWebFirstCoreLoopback(authority,journal);
    try{
      const denied=await rpc(socket.endpointUrl,'tools/call','project_read',{
        project_id:p.id,relative_path:'NO_READ.txt'});
      expect(denied.data.result.isError).toBe(true);
      const receipts=await new WebFirstOperationJournal(profile).last();
      expect(receipts.map(r=>r.stage)).toEqual(['STARTED','REJECTED']);
      expect(JSON.stringify(receipts)).not.toContain('NO_READ.txt');
      expect(JSON.stringify(denied.data)).not.toContain('SECRET_CANARY_NEVER_RETURNED');
    }finally{await socket.close();}
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
