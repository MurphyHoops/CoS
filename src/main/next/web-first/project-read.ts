/** A single approval authorizes a single bounded read, never a project-wide capability. */
import path from 'node:path';
import { promises as fs, constants } from 'node:fs';
import type { WebFirstProjectRegistry, WebFirstProject } from './project-registry.js';

export type ReadAction='project_list'|'project_ls'|'project_read';
export type NativeReadApproval=(description:{
  readonly action:ReadAction;
  readonly projectName?:string;
  readonly projectId?:string;
  readonly projectRoot?:string;
  readonly target?:string;
})=>Promise<boolean>;
const MAX_FILE=32*1024;
const MAX_LIST=120;

export class WebFirstReadAuthority {
  constructor(private readonly store:WebFirstProjectRegistry,
    private readonly approve:NativeReadApproval){}
  private async project(id:string):Promise<WebFirstProject>{
    const projects=await this.store.list();
    const found=projects.find(p=>p.id===id);
    if(!found)throw Error('PROJECT_NOT_REGISTERED');
    if(await fs.realpath(found.root)!==found.root)throw Error('PROJECT_ROOT_CHANGED');
    const st=await fs.lstat(found.root);
    if(!st.isDirectory()||st.isSymbolicLink())throw Error('PROJECT_ROOT_UNSAFE');
    return found;
  }
  private async target(root:string,relative:string,type:'file'|'directory'){
    if(typeof relative!=='string'||relative.length>2000||relative.includes('\\')||relative.includes('\0')||
      path.posix.isAbsolute(relative))throw Error('RELATIVE_PATH_INVALID');
    const segments=(relative===''||relative==='.')?[]:relative.split('/');
    if(segments.some(s=>!s||s==='.'||s==='..'))throw Error('RELATIVE_PATH_INVALID');
    // Refuse symlinks even if they happen to resolve back into the project.
    let current=root;
    for(const part of segments){
      current=path.join(current,part);
      const metadata=await fs.lstat(current);
      if(metadata.isSymbolicLink())throw Error('SYMLINK_DENIED');
    }
    const canonical=await fs.realpath(current);
    if(canonical!==root&&!canonical.startsWith(root+path.sep))throw Error('PROJECT_PATH_OUTSIDE_ROOT');
    const st=await fs.lstat(canonical);
    if(type==='file'&&(!st.isFile()||st.size>MAX_FILE||st.size<0))throw Error('FILE_TYPE_OR_SIZE_DENIED');
    if(type==='directory'&&!st.isDirectory())throw Error('NOT_DIRECTORY');
    return {canonical,stat:st};
  }
  async listProjects(){
    if(!await this.approve({action:'project_list'}))throw Error('NATIVE_APPROVAL_DENIED');
    const projects=await this.store.list();
    return projects.map(({id,name})=>({id,name})); // no canonical paths disclosed
  }
  async listDirectory(projectId:string,relativePath:string){
    const project=await this.project(projectId);
    const {canonical,stat}=await this.target(project.root,relativePath,'directory');
    if(!await this.approve({action:'project_ls',projectName:project.name,projectId:project.id,projectRoot:project.root,target:canonical}))
      throw Error('NATIVE_APPROVAL_DENIED');
    const checked=await this.target(project.root,relativePath,'directory');
    if(checked.canonical!==canonical||checked.stat.dev!==stat.dev||checked.stat.ino!==stat.ino)
      throw Error('DIRECTORY_CHANGED_DURING_APPROVAL');
    const items=await fs.readdir(canonical,{withFileTypes:true});
    const after=await this.target(project.root,relativePath,'directory');
    if(after.canonical!==canonical||after.stat.dev!==stat.dev||after.stat.ino!==stat.ino)
      throw Error('DIRECTORY_CHANGED_DURING_READ');
    // Dirents provide the types without following child symlinks or reading files.
    const shown=items.filter(d=>d.name!=='.DS_Store').slice(0,MAX_LIST);
    const entries=shown.map(d=>({name:d.name,
      type:d.isSymbolicLink()?'other':d.isDirectory()?'directory':d.isFile()?'file':'other'}));
    return {projectId,relativePath,entries,truncated:items.length>MAX_LIST};
  }
  async readFile(projectId:string,relativePath:string){
    const project=await this.project(projectId);
    const {canonical,stat}=await this.target(project.root,relativePath,'file');
    if(!await this.approve({action:'project_read',projectName:project.name,projectId:project.id,projectRoot:project.root,target:canonical}))
      throw Error('NATIVE_APPROVAL_DENIED');
    // Re-check path and file identity AFTER the operator dialog (TOCTOU fence).
    const checked=await this.target(project.root,relativePath,'file');
    if(checked.canonical!==canonical||checked.stat.dev!==stat.dev||checked.stat.ino!==stat.ino)
      throw Error('FILE_CHANGED_DURING_APPROVAL');
    const fh=await fs.open(canonical,constants.O_RDONLY|constants.O_NOFOLLOW);
    try{
      const current=await fh.stat();
      if(!current.isFile()||current.size>MAX_FILE||current.dev!==stat.dev||current.ino!==stat.ino)
        throw Error('FILE_CHANGED_DURING_APPROVAL');
      const data=await fh.readFile();
      if(data.includes(0))throw Error('BINARY_FILE_DENIED');
      return {projectId,relativePath,text:new TextDecoder('utf-8',{fatal:true}).decode(data)};
    }finally{await fh.close();}
  }
}
