import {describe,it,expect} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync,readFileSync,
  readlinkSync,existsSync,readdirSync,rmSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {archiveExitedOwnedChromeSingleton}
  from '../../src/main/web-runtime/chrome-login-locks.js';

function disposable(test:(profile:string)=>Promise<void>):Promise<void>{
  const root=mkdtempSync(path.join(os.tmpdir(),'cos-chrome-lock-review-'));
  try{return test(root).finally(()=>rmSync(root,{recursive:true,force:true}));}
  catch(error){rmSync(root,{recursive:true,force:true});throw error;}
}
describe('verified standard Chrome child exit lease cleanup',()=>{
  it('archives only orphan IPC singleton links, leaves login/profile bytes intact',async()=>{
    await disposable(async profile=>{
      const deadPid=88_888_888;
      mkdirSync(path.join(profile,'Default'),{mode:0o700});
      writeFileSync(path.join(profile,'Default','Login Data'),'sentinel-auth-unchanged');
      symlinkSync(os.hostname()+'-'+deadPid,path.join(profile,'SingletonLock'));
      symlinkSync('/tmp/nonexistent-chrome-sock',path.join(profile,'SingletonSocket'));
      symlinkSync('ipc-sentinel-not-a-website-cookie',path.join(profile,'SingletonCookie'));
      const evidence=await archiveExitedOwnedChromeSingleton(profile,deadPid);
      expect(evidence).toBeTruthy();
      expect(existsSync(path.join(profile,'SingletonLock'))).toBe(false);
      expect(readlinkSync(path.join(evidence!,'SingletonLock')))
        .toBe(os.hostname()+'-'+deadPid);
      expect(readdirSync(evidence!)).toHaveLength(3);
      expect(readFileSync(path.join(profile,'Default','Login Data'),'utf8'))
        .toBe('sentinel-auth-unchanged');
      expect(await archiveExitedOwnedChromeSingleton(profile,deadPid)).toBeNull();
    });
  });
  it('does not touch foreign-owned or live-process singleton',async()=>{
    await disposable(async profile=>{
      symlinkSync(os.hostname()+'-'+process.pid,path.join(profile,'SingletonLock'));
      await expect(archiveExitedOwnedChromeSingleton(profile,process.pid))
        .rejects.toThrow('CHROME_SINGLETON_PROCESS_STILL_RUNNING');
      await expect(archiveExitedOwnedChromeSingleton(profile,88_888_888))
        .rejects.toThrow('CHROME_SINGLETON_FOREIGN_OWNER');
      expect(readlinkSync(path.join(profile,'SingletonLock')))
        .toBe(os.hostname()+'-'+process.pid);
    });
  });
});
