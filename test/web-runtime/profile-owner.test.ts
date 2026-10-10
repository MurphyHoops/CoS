import {describe,it,expect} from 'vitest';
import {mkdtemp,rm,lstat,symlink,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {ProfileLease} from '../../src/main/web-runtime/profile-owner.js';
describe('CoS owned browser profile without extension',()=>{
  it('keeps one exclusive owner; restart reuses same Profile data',async()=>{
    const tmp=await mkdtemp(path.join(tmpdir(),'cos-profile-test-'));
    try{
      const profile=path.join(tmp,'persistent-profile');
      const first=await ProfileLease.acquire(profile);
      expect(first.ownerPid).toBe(process.pid);
      await expect(ProfileLease.acquire(profile))
        .rejects.toThrow('WEB_PROFILE_ALREADY_OWNED_OR_STALE_REVIEW_REQUIRED');
      await writeFile(path.join(profile,'login-fixture-state'),'kept');
      await first.release();
      const second=await ProfileLease.acquire(profile);
      expect(await readFile(path.join(profile,'login-fixture-state'),'utf8')).toBe('kept');
      await second.release();await second.release();
      await expect(lstat(path.join(profile,'.cos-web-runtime-owner.lock')))
        .rejects.toMatchObject({code:'ENOENT'});
    }finally{await rm(tmp,{recursive:true,force:true});}
  });
  it('refuses symlinked profile and stale lock rather than deleting stranger data',async()=>{
    const tmp=await mkdtemp(path.join(tmpdir(),'cos-profile-test-'));
    try{
      const actual=path.join(tmp,'actual');
      const own=await ProfileLease.acquire(actual);
      const link=path.join(tmp,'alias');
      await symlink(actual,link);
      await expect(ProfileLease.acquire(link)).rejects.toThrow('WEB_PROFILE_SYMLINK_FORBIDDEN');
      await own.release();
      await writeFile(path.join(actual,'.cos-web-runtime-owner.lock'),
        JSON.stringify({nonce:'unknown',ownerPid:30001}));
      await expect(ProfileLease.acquire(actual))
        .rejects.toThrow('WEB_PROFILE_ALREADY_OWNED_OR_STALE_REVIEW_REQUIRED');
      expect(await readFile(path.join(actual,'.cos-web-runtime-owner.lock'),'utf8'))
        .toContain('unknown');
    }finally{await rm(tmp,{recursive:true,force:true});}
  });
  it('fails closed if lease file was swapped before release',async()=>{
    const tmp=await mkdtemp(path.join(tmpdir(),'cos-profile-test-'));
    try{
      const profile=path.join(tmp,'active');
      const lease=await ProfileLease.acquire(profile);
      const target=path.join(profile,'.cos-web-runtime-owner.lock');
      await rm(target);
      await writeFile(target,JSON.stringify({nonce:'someone-else'})+'\n');
      await expect(lease.release()).rejects.toThrow('WEB_PROFILE_OWNER_CHANGED');
      expect(await readFile(target,'utf8')).toContain('someone-else');
    }finally{await rm(tmp,{recursive:true,force:true});}
  });
});
