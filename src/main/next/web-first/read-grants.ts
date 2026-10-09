/** Operator-issued, project-specific read grants. Never trust model-supplied identity. */
import {promises as fs,constants} from 'node:fs';
import path from 'node:path';
import type {ReadAction} from './project-read.js';
export type GrantScope='catalog'|'project-read';
export interface DurableReadGrant {scope:GrantScope;projectId:string|null;root:string|null;dev:number;ino:number;createdAt:number;}
export type GrantDecision='deny'|'once'|'session'|'always';
const FILENAME='web-first-read-grants.json';
const MAX_GRANTS=65;
export function isSensitiveProjectPath(root:string,target:string):boolean {
  if(!path.isAbsolute(target))return true;
  const relative=path.relative(root,target);
  if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))return true;
  return relative.split(path.sep).some(part=>{
    const lower=part.toLowerCase();
    return lower==='.git'||lower==='.env'||lower.startsWith('.env.')||
      lower==='.ssh'||lower==='.aws'||lower==='.gnupg'||
      lower==='.npmrc'||lower==='.pypirc'||lower==='.netrc'||
      lower==='.docker'||lower==='.kube'||lower==='.secrets'||
      lower==='secrets.bin'||lower==='credentials.json'||
      lower==='id_rsa'||lower==='id_ed25519'||lower.endsWith('.pem')||
      lower.endsWith('.key')||lower==='node_modules';
  });
}
export class WebFirstReadGrants {
  private readonly session=new Map<string,DurableReadGrant>();
  private flight:Promise<unknown>=Promise.resolve();
  constructor(private readonly profile:string){if(!path.isAbsolute(profile))throw Error('GRANT_PROFILE_INVALID');}
  private filename(){return path.join(this.profile,FILENAME);}
  private key(scope:GrantScope,id:string|null){return scope+':'+(id??'*');}
  private async currentIdentity(root:string|null){
    if(root===null)return {dev:0,ino:0};
    const resolved=await fs.realpath(root);
    const st=await fs.lstat(root);
    if(resolved!==root||!st.isDirectory()||st.isSymbolicLink())
      throw Error('GRANT_ROOT_CHANGED');
    return {dev:st.dev,ino:st.ino};
  }
  async listPermanent():Promise<DurableReadGrant[]>{
    let stat;
    try{stat=await fs.lstat(this.filename());}
    catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return [];throw e;}
    if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||
      (process.getuid&&stat.uid!==process.getuid())||stat.size>64*1024)
      throw Error('GRANT_LEDGER_INTEGRITY_FAILED');
    const fd=await fs.open(this.filename(),constants.O_RDONLY|constants.O_NOFOLLOW);
    let raw:string;
    try{raw=await fd.readFile({encoding:'utf8'});}finally{await fd.close();}
    const parsed:unknown=JSON.parse(raw);
    if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw Error('GRANT_LEDGER_INVALID');
    const data=parsed as {version?:unknown;grants?:unknown};
    if(data.version!==1||!Array.isArray(data.grants)||data.grants.length>MAX_GRANTS)throw Error('GRANT_LEDGER_INVALID');
    const seen=new Set<string>();
    for(const candidate of data.grants){
      if(!candidate||typeof candidate!=='object'||Array.isArray(candidate))throw Error('GRANT_LEDGER_INVALID');
      const grant=candidate as DurableReadGrant;
      if(grant.scope!=='catalog'&&grant.scope!=='project-read')throw Error('GRANT_LEDGER_INVALID');
      if(grant.scope==='catalog'&&(grant.root!==null||grant.projectId!==null))throw Error('GRANT_LEDGER_INVALID');
      if(grant.scope==='project-read'&&(!grant.projectId?.startsWith('project-')||
        !grant.root||!path.isAbsolute(grant.root)||path.resolve(grant.root)!==grant.root))
        throw Error('GRANT_LEDGER_INVALID');
      if(!Number.isSafeInteger(grant.dev)||!Number.isSafeInteger(grant.ino)||
        (grant.scope==='catalog'&&(grant.dev!==0||grant.ino!==0))||
        !Number.isSafeInteger(grant.createdAt)||grant.createdAt<=0||
        seen.has(this.key(grant.scope,grant.projectId)))throw Error('GRANT_LEDGER_INVALID');
      seen.add(this.key(grant.scope,grant.projectId));
    }
    return data.grants.map((g:DurableReadGrant)=>({...g}));
  }
  private async persist(items:DurableReadGrant[]){
    const file=this.filename();
    await fs.mkdir(this.profile,{recursive:true,mode:0o700});
    const temp=path.join(this.profile,'.web-first-grants-'+crypto.randomUUID()+'.tmp');
    try{
      await fs.writeFile(temp,JSON.stringify({version:1,grants:items},null,2)+'\n',
        {encoding:'utf8',flag:'wx',mode:0o600});
      await fs.rename(temp,file);
    }finally{await fs.rm(temp,{force:true});}
  }
  private locked<T>(action:()=>Promise<T>):Promise<T>{
    const result=this.flight.then(action);
    this.flight=result.catch(()=>undefined);
    return result;
  }
  async allowed(scope:GrantScope,projectId:string|null,root:string|null,target:string|null,
    action:ReadAction):Promise<boolean>{
    if(scope==='catalog' && action!=='project_list')return false;
    if(scope==='project-read'){
      if(action==='project_list')return false;
      if(!projectId||!root)return false;
      // Even an enduring read grant NEVER auto-grants sensitive-path reads.
      if(!target||isSensitiveProjectPath(root,target))return false;
    }
    const key=this.key(scope,projectId);
    const identity=await this.currentIdentity(root);
    const match=(g:DurableReadGrant)=>this.key(g.scope,g.projectId)===key&&g.root===root&&
      g.dev===identity.dev&&g.ino===identity.ino;
    return [...this.session.values()].some(match)||(await this.listPermanent()).some(match);
  }
  async grant(scope:GrantScope,projectId:string|null,root:string|null,decision:GrantDecision){
    if(decision==='deny'||decision==='once')return;
    if(scope==='catalog'&&(projectId!==null||root!==null))throw Error('GRANT_SCOPE_INVALID');
    if(scope==='project-read'&&(!projectId?.startsWith('project-')||!root||!path.isAbsolute(root)))
      throw Error('GRANT_SCOPE_INVALID');
    const identity=await this.currentIdentity(root);
    const item:DurableReadGrant={scope,projectId,root,...identity,createdAt:Date.now()};
    if(decision==='session'){this.session.set(this.key(scope,projectId),item);return;}
    await this.locked(async()=>{
      const previous=await this.listPermanent();
      const next=[...previous.filter(g=>this.key(g.scope,g.projectId)!==this.key(scope,projectId)),item];
      if(next.length>MAX_GRANTS)throw Error('GRANT_LIMIT_EXCEEDED');
      await this.persist(next);
    });
  }
  async revoke(scope:GrantScope,projectId:string|null){
    const key=this.key(scope,projectId);
    this.session.delete(key);
    await this.locked(async()=>{
      const items=await this.listPermanent();
      const next=items.filter(g=>this.key(g.scope,g.projectId)!==key);
      if(next.length!==items.length)await this.persist(next);
    });
  }
  async revokeAll(){
    this.session.clear();
    await this.locked(async()=>{await this.listPermanent();await this.persist([]);});
  }
  async inspect(){return {session:[...this.session.values()].map(g=>({...g})),persistent:await this.listPermanent()};}
  clearSession(){this.session.clear();}
}
