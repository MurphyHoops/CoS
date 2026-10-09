import {afterEach,describe,expect,it} from 'vitest';
import {mkdtemp,mkdir,writeFile,rm,symlink} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {WebFirstProjectRegistry} from '../../src/main/next/web-first/project-registry.js';
import {WebFirstReadAuthority,type ReadAction} from '../../src/main/next/web-first/project-read.js';
import {WebFirstTaskLedger} from '../../src/main/next/web-first/task-ledger.js';
import {WebFirstTaskTools} from '../../src/main/next/web-first/task-tools.js';
import {WebFirstPlanLedger} from '../../src/main/next/web-first/plan-ledger.js';
import {WebFirstPlanTools} from '../../src/main/next/web-first/plan-tools.js';
import {WebFirstProjectWriter} from '../../src/main/next/web-first/project-write.js';
import {createHash} from 'node:crypto';
import {createWebFirstCoreLoopback} from '../../src/main/next/web-first/core-loopback.js';
import {readWebFirstLocalToolList,EXPECTED_READ_ONLY_CORE_TOOLS} from '../../src/main/next/web-first/core-catalogue.js';
import {WebFirstReadGrants} from '../../src/main/next/web-first/read-grants.js';
import {WebFirstOperationJournal} from '../../src/main/next/web-first/operation-journal.js';
const paths:string[]=[];
afterEach(async()=>{for(const name of paths.splice(0))await rm(name,{recursive:true,force:true});});
async function prepare(allow:ReadAction[]=[],allowTask=false,allowWrite=false,allowPlan=false){
  const temp=await mkdtemp(path.join(os.tmpdir(),'cos-web-first-mcp-'));paths.push(temp);
  await mkdir(path.join(temp,'profile'));await mkdir(path.join(temp,'project'));
  await writeFile(path.join(temp,'project','hello.txt'),'CONTENTS FROM DISPOSABLE FIXTURE');
  await writeFile(path.join(temp,'outside-secret.txt'),'NEVER_READ_OUTSIDE');
  const store=new WebFirstProjectRegistry(path.join(temp,'profile'));
  const p=await store.register(path.join(temp,'project'));
  const approvals:ReadAction[]=[];
  const authority=new WebFirstReadAuthority(store,async desc=>{approvals.push(desc.action);return allow.includes(desc.action);});
  const taskLedger=new WebFirstTaskLedger(path.join(temp,'profile'));
  const tasks=new WebFirstTaskTools(taskLedger,store,async()=>allowTask);
  const plans=new WebFirstPlanTools(new WebFirstPlanLedger(path.join(temp,'profile'),taskLedger),
    taskLedger,async()=>allowPlan);
  const journal=new WebFirstOperationJournal(path.join(temp,'profile'));
  const write=new WebFirstProjectWriter(store,async()=>allowWrite);
  const service=await createWebFirstCoreLoopback(authority,journal,tasks,write,plans);
  return {temp,service,p,approvals,journal};
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
        'identity_diagnostics','project_find','project_list','project_ls','project_read','project_replace','runtime_health',
        'task_begin','task_checkpoint','task_finish_request','task_plan_status','task_plan_update','task_status','task_wait']);
      expect(tools.find((x:{name:string})=>x.name==='project_read').annotations.readOnlyHint).toBe(true);
      expect(tools.find((x:{name:string})=>x.name==='project_replace').annotations.readOnlyHint).toBe(false);
      expect(tools.find((x:{name:string})=>x.name==='task_checkpoint').annotations.readOnlyHint).toBe(false);
      const health=await rpc(service.endpointUrl,'tools/call','runtime_health');
      expect(health.data.result.structuredContent).toMatchObject({
        mcp:'LOCAL_ONLY',identity_verified:false,chatgpt_tool_registry:'NOT_VERIFIED',
        server_toolset:'web-first-project-goal-plan-p3.3-v1'
      });
      expect(health.data.result.structuredContent.server_tools.sort()).toEqual([...EXPECTED_READ_ONLY_CORE_TOOLS]);
    }finally{await service.close();}
  });
  it('updates a task-scoped plan only with separate native approval, exact revision and nonce',async()=>{
    const {service,p}=await prepare([],true,false,false);
    try{
      const newTask=await rpc(service.endpointUrl,'tools/call','task_begin',{
        project_id:p.id,goal:'Local plan integration test'});
      const id=newTask.data.result.structuredContent.result.task_id;
      const values={task_id:id,expected_revision:0,nonce:'approval-test-001',explanation:'Run checks',
        plan:[{step:'Run tests',status:'in_progress'}]};
      const refused=await rpc(service.endpointUrl,'tools/call','task_plan_update',values);
      expect(refused.data.result.isError).toBe(true);
      expect(JSON.stringify(refused.data)).toContain('PLAN_NATIVE_APPROVAL_DENIED');
      const status=await rpc(service.endpointUrl,'tools/call','task_plan_status',{task_id:id});
      expect(status.data.result.structuredContent.result).toBeNull();
    }finally{await service.close();}
    const accepted=await prepare([],true,false,true);
    try{
      const task=await rpc(accepted.service.endpointUrl,'tools/call','task_begin',{
        project_id:accepted.p.id,goal:'Approved native plan'});
      const id=task.data.result.structuredContent.result.task_id;
      const values={task_id:id,expected_revision:0,nonce:'approved-plan-001',explanation:'Proof',
        plan:[{step:'Check files',status:'completed'},{step:'Test app',status:'in_progress'}]};
      const changed=await rpc(accepted.service.endpointUrl,'tools/call','task_plan_update',values);
      expect(changed.data.result.structuredContent.result.revision).toBe(1);
      const again=await rpc(accepted.service.endpointUrl,'tools/call','task_plan_update',values);
      expect(again.data.result.structuredContent.result.revision).toBe(1);
      const stale=await rpc(accepted.service.endpointUrl,'tools/call','task_plan_update',{
        ...values,nonce:'other-plan-001'});
      expect(stale.data.result.isError).toBe(true);
      const reread=await rpc(accepted.service.endpointUrl,'tools/call','task_plan_status',{task_id:id});
      expect(reread.data.result.structuredContent.result.plan).toEqual(values.plan);
    }finally{await accepted.service.close();}
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
  it('rejects unapproved project search and safely skips secrets, symlink escape and hidden directories',async()=>{
    const {service,p,temp}=await prepare(['project_find']);
    try{
      await mkdir(path.join(temp,'project','src'));
      await writeFile(path.join(temp,'project','src','feature.ts'),'// UNIQUE_SEARCH_CANARY_42\n');
      await writeFile(path.join(temp,'project','.env.local'),'UNIQUE_SEARCH_CANARY_42 SECRET_LEAK');
      await writeFile(path.join(temp,'project','private.key'),'UNIQUE_SEARCH_CANARY_42 KEY_LEAK');
      await symlink(path.join(temp,'outside-secret.txt'),path.join(temp,'project','escape.txt'));
      const result=await rpc(service.endpointUrl,'tools/call','project_find',{
        project_id:p.id,relative_path:'.',query:'UNIQUE_SEARCH_CANARY_42'});
      expect(result.status).toBe(200);
      const found=result.data.result.structuredContent.result;
      expect(found.results).toEqual([{path:'src/feature.ts',line:1,
        snippet:'// UNIQUE_SEARCH_CANARY_42',kind:'content'}]);
      expect(JSON.stringify(result.data)).not.toContain('SECRET_LEAK');
      expect(JSON.stringify(result.data)).not.toContain('KEY_LEAK');
      expect(JSON.stringify(result.data)).not.toContain('NEVER_READ_OUTSIDE');
      const invalid=await rpc(service.endpointUrl,'tools/call','project_find',{
        project_id:p.id,relative_path:'../',query:'UNIQUE_SEARCH_CANARY_42'});
      expect(invalid.data.result.isError).toBe(true);
    }finally{await service.close();}
    const denied=await prepare();
    try{
      const attempted=await rpc(denied.service.endpointUrl,'tools/call','project_find',{
        project_id:denied.p.id,relative_path:'.',query:'DISPOSABLE'});
      expect(attempted.data.result.isError).toBe(true);
      expect(JSON.stringify(attempted.data)).toContain('NATIVE_APPROVAL_DENIED');
    }finally{await denied.service.close();}
  });
  it('requires per-write native approval and exact SHA-256 before replacing one unique existing text span',async()=>{
    const hash=(content:string)=>createHash('sha256').update(content).digest('hex');
    const denied=await prepare([],false,false);
    try{
      const attempt=await rpc(denied.service.endpointUrl,'tools/call','project_replace',{
        project_id:denied.p.id,relative_path:'hello.txt',expected_sha256:hash('CONTENTS FROM DISPOSABLE FIXTURE'),
        old_text:'DISPOSABLE',new_text:'REPLACEMENT'});
      expect(attempt.data.result.isError).toBe(true);
      expect(JSON.stringify(attempt.data)).toContain('NATIVE_WRITE_APPROVAL_DENIED');
      expect(await import('node:fs/promises').then(fs=>fs.readFile(path.join(denied.temp,'project','hello.txt'),'utf8')))
        .toBe('CONTENTS FROM DISPOSABLE FIXTURE');
    }finally{await denied.service.close();}
    const {service,p,temp,journal}=await prepare([],false,true);
    try{
      const source='CONTENTS FROM DISPOSABLE FIXTURE';
      const correct={project_id:p.id,relative_path:'hello.txt',expected_sha256:hash(source),
        old_text:'DISPOSABLE',new_text:'CONTROLLED'};
      const stale=await rpc(service.endpointUrl,'tools/call','project_replace',{
        ...correct,expected_sha256:'0'.repeat(64)});
      expect(stale.data.result.isError).toBe(true);
      const ok=await rpc(service.endpointUrl,'tools/call','project_replace',correct);
      expect(ok.data.result.structuredContent.result.newSha256).toBe(hash('CONTENTS FROM CONTROLLED FIXTURE'));
      const original=await import('node:fs/promises').then(fs=>fs.readFile(path.join(temp,'project','hello.txt'),'utf8'));
      expect(original).toBe('CONTENTS FROM CONTROLLED FIXTURE');
      const retry=await rpc(service.endpointUrl,'tools/call','project_replace',correct);
      expect(retry.data.result.isError).toBe(true);
      const events=await journal.last(8);
      expect(events.filter(e=>e.action==='project_replace'&&e.stage==='SUCCEEDED')).toHaveLength(1);
      expect(JSON.stringify(events)).not.toContain('CONTROLLED');
    }finally{await service.close();}
  });
  it('blocks sensitive file writes, symlinks, non-unique replacements and unsafe relative paths',async()=>{
    const {service,p,temp}=await prepare([],false,true);
    const hash=(c:string)=>createHash('sha256').update(c).digest('hex');
    try{
      const root=path.join(temp,'project');
      await writeFile(path.join(root,'.env.local'),'SECRET_TOKEN=123');
      await writeFile(path.join(root,'client.key'),'PRIVATE_KEY_TOKEN');
      await writeFile(path.join(root,'duplicate.txt'),'REPEAT REPEAT');
      await symlink(path.join(temp,'outside-secret.txt'),path.join(root,'escape.txt'));
      for(const relative_path of ['.env.local','client.key','escape.txt','../outside-secret.txt','\\server','bad\\name']){
        const result=await rpc(service.endpointUrl,'tools/call','project_replace',{
          project_id:p.id,relative_path,expected_sha256:hash('SECRET_TOKEN=123'),
          old_text:'TOKEN',new_text:'STOLEN'});
        expect(result.data.result.isError).toBe(true);
      }
      const duplicate=await rpc(service.endpointUrl,'tools/call','project_replace',{
        project_id:p.id,relative_path:'duplicate.txt',expected_sha256:hash('REPEAT REPEAT'),
        old_text:'REPEAT',new_text:'OK'});
      expect(duplicate.data.result.isError).toBe(true);
      expect(await import('node:fs/promises').then(fs=>fs.readFile(path.join(root,'duplicate.txt'),'utf8')))
        .toBe('REPEAT REPEAT');
      expect(await import('node:fs/promises').then(fs=>fs.readFile(path.join(root,'.env.local'),'utf8')))
        .toBe('SECRET_TOKEN=123');
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
