/**
 * Native-only project bookmarks. These are NOT capability grants: never
 * return these roots to the ChatGPT WebContents or publish an MCP tool.
 */
import {randomUUID} from 'node:crypto';
import {promises as fs} from 'node:fs';
import path from 'node:path';

export interface WebFirstProject {
  id:string;
  name:string;
  root:string;
  registeredAt:number;
}
const LIMIT=64;
const FILE='web-first-projects.json';
const ID=/^project-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export class WebFirstProjectRegistry {
  private operation:Promise<unknown>=Promise.resolve();
  constructor(private readonly profile:string) {
    if(!path.isAbsolute(profile))throw new Error('WEBFIRST_PROFILE_MUST_BE_ABSOLUTE');
  }
  private file():string{return path.join(this.profile,FILE);}
  async list():Promise<ReadonlyArray<WebFirstProject>> {
    const filename=this.file();
    let metadata;
    try{metadata=await fs.lstat(filename);}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error;}
    if(!metadata.isFile()||metadata.isSymbolicLink()||(metadata.mode&0o077)!==0 ||
        (process.getuid && metadata.uid!==process.getuid()))
      throw new Error('WEBFIRST_PROJECT_LEDGER_PERMISSIONS_INVALID');
    if(metadata.size>128*1024)throw new Error('WEBFIRST_PROJECT_LEDGER_TOO_LARGE');
    const decoded:unknown=JSON.parse(await fs.readFile(filename,'utf8'));
    if(!decoded||typeof decoded!=='object'||Array.isArray(decoded))throw new Error('WEBFIRST_PROJECT_LEDGER_INVALID');
    const ledger=decoded as {version?:unknown;projects?:unknown};
    if(ledger.version!==1||!Array.isArray(ledger.projects)||ledger.projects.length>LIMIT)
      throw new Error('WEBFIRST_PROJECT_LEDGER_VERSION_OR_SIZE_INVALID');
    const ids=new Set<string>(),roots=new Set<string>();
    for(const row of ledger.projects){
      if(!row||typeof row!=='object'||Array.isArray(row))throw new Error('WEBFIRST_PROJECT_ROW_INVALID');
      const p=row as Partial<WebFirstProject>;
      if(typeof p.id!=='string'||!ID.test(p.id)||typeof p.name!=='string'||
        p.name.length<1||p.name.length>256||typeof p.root!=='string'||
        p.root.length>4096||!path.isAbsolute(p.root)||p.root!==path.resolve(p.root)||
        !Number.isSafeInteger(p.registeredAt)||!p.registeredAt||
        ids.has(p.id)||roots.has(p.root))throw new Error('WEBFIRST_PROJECT_ROW_INVALID');
      ids.add(p.id);roots.add(p.root);
    }
    return ledger.projects.map((p:WebFirstProject)=>({...p}));
  }
  /** Explicit native folder picker + separately confirmed operator action only. */
  async register(chosenDirectory:string):Promise<WebFirstProject> {
    const execute=async():Promise<WebFirstProject>=>{
      if(!path.isAbsolute(chosenDirectory)||chosenDirectory.length>4096)
        throw new Error('WEBFIRST_PROJECT_DIRECTORY_INVALID');
      const resolved=await fs.realpath(chosenDirectory);
      const stat=await fs.stat(resolved);
      if(!stat.isDirectory())throw new Error('WEBFIRST_PROJECT_NOT_DIRECTORY');
      const current=[...await this.list()];
      const existing=current.find(p=>p.root===resolved);
      if(existing)return existing; // idempotent registration, no duplicate claims
      if(current.length>=LIMIT)throw new Error('WEBFIRST_PROJECT_REGISTRY_FULL');
      const project:WebFirstProject={id:'project-'+randomUUID(),name:path.basename(resolved)||resolved,
        root:resolved,registeredAt:Date.now()};
      const content=JSON.stringify({version:1,projects:[...current,project]},null,2)+'\n';
      await fs.mkdir(this.profile,{recursive:true,mode:0o700});
      const temporary=path.join(this.profile,'.web-first-projects-'+randomUUID()+'.tmp');
      try{
        await fs.writeFile(temporary,content,{encoding:'utf8',flag:'wx',mode:0o600});
        await fs.rename(temporary,this.file());
      }finally{await fs.rm(temporary,{force:true});}
      return project;
    };
    const result=this.operation.then(execute);
    this.operation=result.catch(()=>undefined);
    return result;
  }
}
