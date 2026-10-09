import {describe,it,expect,afterEach} from 'vitest';
import {mkdtemp,readFile,rm,chmod,symlink} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {WebFirstOperationJournal} from '../../src/main/next/web-first/operation-journal.js';
const dirs:string[]=[];
afterEach(async()=>{for(const d of dirs.splice(0))await rm(d,{recursive:true,force:true});});
describe('P3 durable native operation receipts',()=>{
  it('durably pairs start/completion by UUID without storing content or paths',async()=>{
    const base=await mkdtemp(path.join(os.tmpdir(),'cos-p3-receipts-'));dirs.push(base);
    const journal=new WebFirstOperationJournal(base);
    const id=await journal.start('project_read','project-test');
    await journal.finish(id,'project_read','project-test',true);
    const saved=await new WebFirstOperationJournal(base).last(3);
    expect(saved).toHaveLength(2);
    expect(saved.map(x=>x.stage)).toEqual(['STARTED','SUCCEEDED']);
    expect(saved[0]?.id).toBe(saved[1]?.id);
    const content=await readFile(path.join(base,'web-first-operations.jsonl'),'utf8');
    expect(content).not.toContain('/Users');
  });
  it('refuses world-readable or symlink audit receipts instead of claiming success',async()=>{
    const base=await mkdtemp(path.join(os.tmpdir(),'cos-p3-receipts-'));dirs.push(base);
    const journal=new WebFirstOperationJournal(base);await journal.start('project_list');
    const file=path.join(base,'web-first-operations.jsonl');await chmod(file,0o644);
    await expect(journal.start('project_list')).rejects.toThrow('JOURNAL_FILE_UNSAFE_OR_FULL');
    await rm(file);await symlink(base,file);
    await expect(journal.last()).rejects.toThrow('JOURNAL_FILE_UNSAFE_OR_FULL');
  });
});
