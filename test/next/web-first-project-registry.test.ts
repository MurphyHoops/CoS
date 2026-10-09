import {mkdtemp,rm,mkdir,writeFile,symlink,stat,realpath} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterEach,describe,expect,it} from 'vitest';
import {WebFirstProjectRegistry} from '../../src/main/next/web-first/project-registry.js';
import {renderProjectSidebar} from '../../src/main/next/web-first/project-sidebar.js';
const roots:string[]=[];
async function fixture(){
  const temp=await mkdtemp(path.join(os.tmpdir(),'cos-webfirst-project-test-'));
  roots.push(temp);
  await mkdir(path.join(temp,'profile'));
  await mkdir(path.join(temp,'source-project'));
  return {temp,profile:path.join(temp,'profile'),project:path.join(temp,'source-project')};
}
afterEach(async()=>{for(const temp of roots.splice(0))await rm(temp,{force:true,recursive:true});});
describe('Web-First native-only project bookmarks',()=>{
  it('registers explicitly selected canonical directory atomically with no project read',async()=>{
    const f=await fixture(),store=new WebFirstProjectRegistry(f.profile);
    expect(await store.list()).toEqual([]);
    const registered=await store.register(f.project);
    expect(registered).toMatchObject({name:'source-project',root:await realpath(f.project)});
    expect((await store.list())[0]).toEqual(registered);
    expect((await store.register(f.project)).id).toBe(registered.id);
    expect((await store.list()).length).toBe(1);
    expect((await stat(path.join(f.profile,'web-first-projects.json'))).mode&0o077).toBe(0);
  });
  it('serializes concurrent registration and never claims anything about remote MCP',async()=>{
    const f=await fixture();await mkdir(path.join(f.temp,'project-two'));
    const store=new WebFirstProjectRegistry(f.profile);
    const out=await Promise.all([store.register(f.project),store.register(path.join(f.temp,'project-two'))]);
    expect(new Set(out.map(x=>x.id)).size).toBe(2);
    expect(await store.list()).toHaveLength(2);
  });
  it('fails closed on corrupted or symlinked registry rather than overwriting it',async()=>{
    const f=await fixture(),file=path.join(f.profile,'web-first-projects.json');
    await writeFile(file,'corrupted',{mode:0o600});
    const store=new WebFirstProjectRegistry(f.profile);
    await expect(store.list()).rejects.toThrow();
    await expect(store.register(f.project)).rejects.toThrow();
    await rm(file);await symlink(f.project,file);
    await expect(store.list()).rejects.toThrow('LEDGER_PERMISSIONS');
  });
  it('renders project names as escaped static HTML with no script, bridge or IPC',async()=>{
    const html=renderProjectSidebar([{id:'test',name:'<img src=x onerror=alert(1)>',root:'/tmp/<script>',registeredAt:1}],'UNCONNECTED');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script');
    expect(html).toContain('未连接／未授权');
    expect(renderProjectSidebar([],'LOCAL_ONLY',false,{permanent:2,session:1,error:false}))
      .toContain('永久 2 项 · 本次运行 1 项');
    expect(renderProjectSidebar([],'HOLD',false,{permanent:0,session:0,error:true}))
      .toContain('授权记录异常 · 自动放行已禁用');
    expect(html).not.toContain('nodeIntegration');
  });
});
