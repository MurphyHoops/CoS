/** A single approval authorizes a single bounded read, never a project-wide capability. */
import path from 'node:path';
import { promises as fs, constants } from 'node:fs';
import type { WebFirstProjectRegistry, WebFirstProject } from './project-registry.js';
import {isSensitiveProjectPath} from './read-grants.js';

export type ReadAction='project_list'|'project_ls'|'project_read'|'project_find';
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
  /** Bounded literal filename/text search under one user-approved directory. */
  async find(projectId:string,relativePath:string,query:string){
    if(typeof query!=='string'||query.trim().length<2||query.length>100||query.includes('\0'))
      throw Error('FIND_QUERY_INVALID');
    const project=await this.project(projectId);
    const before=await this.target(project.root,relativePath,'directory');
    if(!await this.approve({action:'project_find',projectName:project.name,projectId:project.id,
      projectRoot:project.root,target:before.canonical}))throw Error('NATIVE_APPROVAL_DENIED');
    const after=await this.target(project.root,relativePath,'directory');
    if(before.canonical!==after.canonical||before.stat.dev!==after.stat.dev||
      before.stat.ino!==after.stat.ino)throw Error('DIRECTORY_CHANGED_DURING_APPROVAL');
    const needle=query.toLocaleLowerCase();
    const results:{path:string;line:number;snippet:string;kind:'file'|'content'}[]=[];
    const stack:[string,number][]=[[before.canonical,0]];
    let scanned=0;
    const deadline=Date.now()+3000;
    const visited=new Set<string>();
    while(stack.length&&scanned<360&&results.length<24&&Date.now()<deadline){
      const [folder,depth]=stack.pop()!;
      if(visited.has(folder))continue;visited.add(folder);
      const status=await fs.lstat(folder);
      if(!status.isDirectory()||status.isSymbolicLink())continue;
      if(isSensitiveProjectPath(project.root,folder))continue;
      if(await fs.realpath(folder)!==folder)throw Error('FIND_DIRECTORY_CHANGED');
      const children=await fs.readdir(folder,{withFileTypes:true});
      const second=await fs.lstat(folder);
      if(second.dev!==status.dev||second.ino!==status.ino||
        second.isSymbolicLink()||await fs.realpath(folder)!==folder)
        throw Error('FIND_DIRECTORY_CHANGED');
      for(const item of children){
        if(scanned>=360||results.length>=24||Date.now()>=deadline)break;
        const filename=item.name;
        if(filename.startsWith('.')||filename==='node_modules'||filename==='dist'||
          filename==='build'||filename==='coverage')continue;
        const candidate=path.join(folder,filename),relative=path.relative(project.root,candidate);
        if(isSensitiveProjectPath(project.root,candidate)||item.isSymbolicLink())continue;
        scanned++;
        if(item.isDirectory()){
          if(depth<5)stack.push([candidate,depth+1]);
          continue;
        }
        if(!item.isFile())continue;
        const display=relative.split(path.sep).join('/');
        if(filename.toLocaleLowerCase().includes(needle)){
          results.push({path:display,line:0,snippet:'',kind:'file'});
          if(results.length>=24)break;
        }
        const metadata=await fs.lstat(candidate);
        if(!metadata.isFile()||metadata.isSymbolicLink()||metadata.size>32*1024)continue;
        const file=await fs.open(candidate,constants.O_RDONLY|constants.O_NOFOLLOW);
        try{
          const actual=await file.stat();
          if(!actual.isFile()||actual.size>32*1024||
            actual.dev!==metadata.dev||actual.ino!==metadata.ino)continue;
          const data=await file.readFile();
          if(data.includes(0))continue;
          let text:string;
          try{text=new TextDecoder('utf-8',{fatal:true}).decode(data);}catch{continue;}
          const lines=text.split('\n');
          for(let idx=0;idx<lines.length&&results.length<24;idx++){
            const line=lines[idx]!;
            if(line.toLocaleLowerCase().includes(needle)){
              results.push({path:display,line:idx+1,snippet:line.slice(0,180),kind:'content'});
            }
          }
        }finally{await file.close();}
      }
    }
    return {projectId,relativePath,query,results,scanned,
      truncated:!!stack.length||scanned>=360||results.length>=24||Date.now()>=deadline};
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
