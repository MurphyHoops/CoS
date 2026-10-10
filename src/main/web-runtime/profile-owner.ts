/**
 * Dedicated profile lease for the extension-free CoS Web Runtime.
 * Conservative design: never reclaim/kill an unknown Chromium/Chrome owner.
 */
import {constants,promises as fs} from 'node:fs';
import type {FileHandle} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

interface OwnerStamp {
  version:1; nonce:string; ownerPid:number; ownerStartedAt:number;
  profile:string; createdAt:number;
}
const LOCK='.cos-web-runtime-owner.lock';
export class ProfileLease {
  private released=false;
  private constructor(readonly profile:string,private readonly file:FileHandle,
    private readonly stamp:OwnerStamp,private readonly device:number,
    private readonly inode:number){}
  static async acquire(profilePath:string):Promise<ProfileLease>{
    if(!path.isAbsolute(profilePath)||profilePath.includes('\0'))
      throw Error('WEB_PROFILE_PATH_INVALID');
    await fs.mkdir(profilePath,{recursive:true,mode:0o700});
    const stat=await fs.lstat(profilePath);
    if(stat.isSymbolicLink())throw Error('WEB_PROFILE_SYMLINK_FORBIDDEN');
    if(!stat.isDirectory()||(stat.mode&0o077)!==0||
      (process.getuid&&stat.uid!==process.getuid()))
      throw Error('WEB_PROFILE_DIR_UNSAFE');
    const profile=await fs.realpath(profilePath);
    // A symlinked profile root could make the browser touch a foreign account.
    const canonicalParent=await fs.realpath(path.dirname(profilePath));
    if(profile!==path.join(canonicalParent,path.basename(profilePath)))
      throw Error('WEB_PROFILE_SYMLINK_FORBIDDEN');
    const stamp:OwnerStamp={version:1,nonce:randomUUID(),ownerPid:process.pid,
      ownerStartedAt:Math.round(Date.now()-process.uptime()*1000),
      profile,createdAt:Date.now()};
    let file:FileHandle;
    try{
      file=await fs.open(path.join(profile,LOCK),
        constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    }catch(e){
      if((e as NodeJS.ErrnoException).code==='EEXIST')
        throw Error('WEB_PROFILE_ALREADY_OWNED_OR_STALE_REVIEW_REQUIRED');
      throw e;
    }
    try{
      await file.writeFile(JSON.stringify(stamp)+'\n','utf8');
      await file.sync();
      const lockStat=await file.stat();
      if(!lockStat.isFile()||(lockStat.mode&0o077)!==0)
        throw Error('WEB_PROFILE_LOCK_UNSAFE');
      const dir=await fs.open(profile,constants.O_RDONLY);
      try{await dir.sync();}finally{await dir.close();}
      return new ProfileLease(profile,file,stamp,lockStat.dev,lockStat.ino);
    }catch(e){
      await file.close();
      // Abort only our own freshly created lock path. Do not touch other owner.
      const existing=await fs.lstat(path.join(profile,LOCK)).catch(()=>null);
      const created=await file.stat().catch(()=>null);
      if(existing?.isFile()&&created&&existing.ino===created.ino&&
        existing.dev===created.dev)
        await fs.unlink(path.join(profile,LOCK)).catch(()=>undefined);
      throw e;
    }
  }
  get ownerPid(){return this.stamp.ownerPid;}
  get ownerNonce(){return this.stamp.nonce;}
  async release():Promise<void>{
    if(this.released)return;
    const lockPath=path.join(this.profile,LOCK);
    try{
      const info=await fs.lstat(lockPath);
      if(info.dev!==this.device||info.ino!==this.inode||
        !info.isFile()||info.isSymbolicLink())throw Error('WEB_PROFILE_OWNER_CHANGED');
      const text=await fs.readFile(lockPath,'utf8');
      const now=JSON.parse(text) as Partial<OwnerStamp>;
      if(now.nonce!==this.stamp.nonce||now.profile!==this.profile||
        now.ownerPid!==this.stamp.ownerPid||
        now.ownerStartedAt!==this.stamp.ownerStartedAt)
        throw Error('WEB_PROFILE_OWNER_CHANGED');
      await fs.unlink(lockPath);
      const dir=await fs.open(this.profile,constants.O_RDONLY);
      try{await dir.sync();}finally{await dir.close();}
      this.released=true;
    }finally{await this.file.close();}
  }
}
