/** Recover ONLY browser-process IPC singleton links belonging to a
 * standard Chrome process spawned by this CoS instance, after an observed
 * child exit and while the exact CoS ProfileLease is still held.
 *
 * These links are not site cookies, tokens or Chrome login databases.
 * All recovered links are renamed into an evidence directory (not deleted).
 * Never reclaim an unidentified browser or CoS owner.
 */
import {promises as fs} from 'node:fs';
import {randomUUID} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export async function archiveExitedOwnedChromeSingleton(
  profile:string,childPid:number):Promise<string|null>{
  if(!path.isAbsolute(profile)||profile.includes('\0')||
    !Number.isSafeInteger(childPid)||childPid<1)
    throw Error('CHROME_SINGLETON_INPUT_INVALID');
  const root=await fs.lstat(profile);
  if(!root.isDirectory()||root.isSymbolicLink()||
    (root.mode&0o077)!==0||
    (process.getuid&&root.uid!==process.getuid()))
    throw Error('CHROME_SINGLETON_PROFILE_UNSAFE');
  try{process.kill(childPid,0);throw Error('CHROME_SINGLETON_PROCESS_STILL_RUNNING');}
  catch(e){
    if((e as NodeJS.ErrnoException).code!=='ESRCH')throw e;
  }
  const singleton=path.join(profile,'SingletonLock');
  const lock=await fs.lstat(singleton).catch(e=>{
    if((e as NodeJS.ErrnoException).code==='ENOENT')return null;
    throw e;
  });
  if(!lock)return null;
  if(!lock.isSymbolicLink()||
    (process.getuid&&lock.uid!==process.getuid()))
    throw Error('CHROME_SINGLETON_LOCK_UNSAFE');
  const expected=os.hostname()+'-'+childPid;
  if(await fs.readlink(singleton)!==expected)
    throw Error('CHROME_SINGLETON_FOREIGN_OWNER');
  const evidence=path.join(profile,'.cos-exited-chrome-'+childPid+'-'+randomUUID());
  await fs.mkdir(evidence,{mode:0o700});
  for(const file of ['SingletonLock','SingletonSocket','SingletonCookie']){
    const current=path.join(profile,file);
    const st=await fs.lstat(current).catch(e=>{
      if((e as NodeJS.ErrnoException).code==='ENOENT')return null;
      throw e;
    });
    if(!st)continue;
    if(!st.isSymbolicLink()||
      (process.getuid&&st.uid!==process.getuid()))
      throw Error('CHROME_SINGLETON_LINK_UNSAFE');
    if(file==='SingletonLock'&&await fs.readlink(current)!==expected)
      throw Error('CHROME_SINGLETON_RACED_OWNER');
    await fs.rename(current,path.join(evidence,file));
  }
  return evidence;
}
