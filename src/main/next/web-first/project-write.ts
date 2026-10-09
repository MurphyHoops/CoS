/** Bounded one-file exact replacement; approval never inherits from read grants. */
import {promises as fs,constants} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import {isSensitiveProjectPath} from './read-grants.js';
import type {WebFirstProjectRegistry} from './project-registry.js';
const LIMIT=32*1024;
export type NativeWriteApproval=(scope:{projectName:string;relativePath:string;target:string;
  before:string;after:string})=>Promise<boolean>;
const sha=(data:Buffer)=>createHash('sha256').update(data).digest('hex');
export class WebFirstProjectWriter {
  constructor(private readonly registry:WebFirstProjectRegistry,private readonly approve:NativeWriteApproval){}
  private async resolve(projectId:string,relativePath:string){
    const project=(await this.registry.list()).find(p=>p.id===projectId);
    if(!project)throw Error('PROJECT_NOT_REGISTERED');
    if(typeof relativePath!=='string'||!relativePath||relativePath.length>2000||
      relativePath.startsWith('/')||relativePath.includes('\\')||relativePath.includes('\0'))
      throw Error('WRITE_PATH_INVALID');
    const segments=relativePath.split('/');
    if(segments.some(part=>!part||part==='.'||part==='..'))throw Error('WRITE_PATH_INVALID');
    const root=project.root;
    const rootStat=await fs.lstat(root);
    if(!rootStat.isDirectory()||rootStat.isSymbolicLink()||await fs.realpath(root)!==root)
      throw Error('PROJECT_ROOT_CHANGED');
    let current=root;
    for(const part of segments){
      current=path.join(current,part);
      if(isSensitiveProjectPath(root,current))throw Error('WRITE_SENSITIVE_PATH_DENIED');
      const st=await fs.lstat(current);
      if(st.isSymbolicLink())throw Error('WRITE_SYMLINK_DENIED');
    }
    const target=await fs.realpath(current);
    if(target!==current||!target.startsWith(root+path.sep))throw Error('WRITE_PATH_OUTSIDE_PROJECT');
    const stat=await fs.lstat(target);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||
      stat.size>LIMIT||stat.size<1)throw Error('WRITE_FILE_INVALID');
    return {project,rootStat,target,stat};
  }
  private async read(target:string,stat:{dev:number;ino:number}){
    const fh=await fs.open(target,constants.O_RDONLY|constants.O_NOFOLLOW);
    try{
      const opened=await fh.stat();
      if(!opened.isFile()||opened.size>LIMIT||opened.dev!==stat.dev||
        opened.ino!==stat.ino||opened.nlink!==1)throw Error('WRITE_FILE_CHANGED');
      const raw=await fh.readFile();
      if(raw.includes(0))throw Error('WRITE_BINARY_DENIED');
      return {raw,text:new TextDecoder('utf-8',{fatal:true}).decode(raw)};
    }finally{await fh.close();}
  }
  async replace(args:{projectId:string;relativePath:string;expectedSha256:string;
    oldText:string;newText:string}){
    const {projectId,relativePath,expectedSha256,oldText,newText}=args;
    if(typeof oldText!=='string'||!oldText||oldText.length>4000||
      typeof newText!=='string'||newText.length>4000||
      typeof expectedSha256!=='string'||!/^[a-f0-9]{64}$/.test(expectedSha256))
      throw Error('WRITE_ARGUMENTS_INVALID');
    const before=await this.resolve(projectId,relativePath);
    const original=await this.read(before.target,before.stat);
    if(sha(original.raw)!==expectedSha256)throw Error('WRITE_HASH_MISMATCH');
    const first=original.text.indexOf(oldText);
    if(first<0||original.text.indexOf(oldText,first+oldText.length)>=0)
      throw Error('WRITE_OLD_TEXT_NOT_UNIQUE');
    const replaced=original.text.slice(0,first)+newText+original.text.slice(first+oldText.length);
    const contents=Buffer.from(replaced,'utf8');
    if(contents.length>LIMIT||contents.length===0)throw Error('WRITE_SIZE_LIMIT');
    if(!await this.approve({projectName:before.project.name,relativePath,
      target:before.target,before:oldText.slice(0,500),after:newText.slice(0,500)}))
      throw Error('NATIVE_WRITE_APPROVAL_DENIED');
    // Verify root, path, inode and content AFTER a native dialog, before rename.
    const after=await this.resolve(projectId,relativePath);
    if(after.target!==before.target||after.rootStat.dev!==before.rootStat.dev||
      after.rootStat.ino!==before.rootStat.ino||
      after.stat.dev!==before.stat.dev||after.stat.ino!==before.stat.ino)
      throw Error('WRITE_FILE_CHANGED');
    const checked=await this.read(after.target,after.stat);
    if(sha(checked.raw)!==expectedSha256)throw Error('WRITE_HASH_MISMATCH');
    const staged=path.join(path.dirname(after.target),'.cos-edit-'+randomUUID()+'.tmp');
    try{
      const fh=await fs.open(staged,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY,0o600);
      try{
        await fh.writeFile(contents);await fh.chmod(after.stat.mode&0o777);await fh.sync();
      }finally{await fh.close();}
      const latest=await this.resolve(projectId,relativePath);
      if(latest.stat.dev!==after.stat.dev||latest.stat.ino!==after.stat.ino)
        throw Error('WRITE_FILE_CHANGED');
      await fs.rename(staged,after.target);
      return {projectId,relativePath,oldSha256:expectedSha256,newSha256:sha(contents),bytes:contents.length};
    }finally{await fs.rm(staged,{force:true});}
  }
}
