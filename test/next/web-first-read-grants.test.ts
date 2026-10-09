import {afterEach,describe,it,expect} from 'vitest';
import {mkdtemp,mkdir,writeFile,rm,rename,symlink,chmod,realpath} from 'node:fs/promises';
import path from 'node:path';import os from 'node:os';
import {WebFirstReadGrants,isSensitiveProjectPath} from '../../src/main/next/web-first/read-grants.js';
const dirs:string[]=[];
afterEach(async()=>{for(const d of dirs.splice(0))await rm(d,{recursive:true,force:true});});
async function make(){const base=await realpath(await mkdtemp(path.join(os.tmpdir(),'cos-p3-grants-')));dirs.push(base);
 const root=path.join(base,'project');await mkdir(root);return {base,root,make:()=>new WebFirstReadGrants(base)};}
describe('scoped native P3 read authorizations',()=>{
 it('permanent persists across restart, session only in memory, and revoke immediately denies',async()=>{
   const x=await make(),a=x.make(),b=x.make(),t=path.join(x.root,'README.md');
   expect(await a.allowed('project-read','project-test',x.root,t,'project_read')).toBe(false);
   await a.grant('project-read','project-test',x.root,'session');
   expect(await a.allowed('project-read','project-test',x.root,t,'project_read')).toBe(true);
   expect(await b.allowed('project-read','project-test',x.root,t,'project_read')).toBe(false);
   a.clearSession();expect(await a.allowed('project-read','project-test',x.root,t,'project_read')).toBe(false);
   await a.grant('project-read','project-test',x.root,'always');
   expect(await b.allowed('project-read','project-test',x.root,t,'project_read')).toBe(true);
   await a.revoke('project-read','project-test');
   expect(await b.allowed('project-read','project-test',x.root,t,'project_read')).toBe(false);
 });
 it('never lets catalogue grant authorize project content; sensitive files still prompt',async()=>{
   const x=await make(),a=x.make();await a.grant('catalog',null,null,'always');
   expect(await a.allowed('catalog',null,null,null,'project_list')).toBe(true);
   expect(await a.allowed('project-read','project-test',x.root,path.join(x.root,'README.md'),'project_read')).toBe(false);
   await a.grant('project-read','project-test',x.root,'always');
   for(const name of ['.env','.env.production','.ssh/id_rsa','.git/config','credentials.json','lib/key.pem','.npmrc','.netrc','.docker/config.json']){
     expect(isSensitiveProjectPath(x.root,path.join(x.root,name))).toBe(true);
     expect(await a.allowed('project-read','project-test',x.root,path.join(x.root,name),'project_read')).toBe(false);
   }
 });
 it('directory replacement invalidates grants even when the path string remains the same',async()=>{
   const x=await make(),a=x.make();await a.grant('project-read','project-test',x.root,'always');
   await rename(x.root,x.root+'-old');await mkdir(x.root);
   expect(await a.allowed('project-read','project-test',x.root,path.join(x.root,'hello'),'project_read')).toBe(false);
 });
 it('malformed, world-readable or symlink ledgers fail closed',async()=>{
   const x=await make(),a=x.make(),file=path.join(x.base,'web-first-read-grants.json');
   await writeFile(file,'invalid',{mode:0o600});await expect(a.listPermanent()).rejects.toThrow();
   await rm(file);await symlink(x.root,file);
   await expect(a.listPermanent()).rejects.toThrow('GRANT_LEDGER_INTEGRITY_FAILED');
   await rm(file);await writeFile(file,'{"version":1,"grants":[]}',{mode:0o600});await chmod(file,0o644);
   await expect(a.listPermanent()).rejects.toThrow('GRANT_LEDGER_INTEGRITY_FAILED');
 });
});
