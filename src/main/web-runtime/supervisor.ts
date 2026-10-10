/** An owned no-extension Chromium surface behind one persistent Electron Session.
 *
 * UI/app upgrades replace code, NOT the profile directory. ProfileLease is
 * acquired BEFORE the native session is opened. Never owns global OS input.
 * This is an early single-surface transport substrate, not a model/agent owner.
 */
import {session} from 'electron';
import path from 'node:path';
import {ProfileLease} from './profile-owner.js';
import {createBackgroundWebComputer,type BackgroundWebComputer}
  from './browser-driver-electron.js';

export class ElectronWebRuntimeSupervisor {
  private owner:ProfileLease|null=null;
  private computer:BackgroundWebComputer|null=null;
  private busy=false;
  readonly profilePath:string;
  constructor(root:string,private readonly offlineFixture=false){
    if(!path.isAbsolute(root)||root.includes('\0'))throw Error('WEB_SUPERVISOR_ROOT_INVALID');
    this.profilePath=path.join(root,'profile');
  }
  get running():boolean{return this.owner!==null&&this.computer!==null;}
  async start():Promise<BackgroundWebComputer>{
    if(this.running||this.busy)throw Error('WEB_SUPERVISOR_ALREADY_RUNNING');
    this.busy=true;
    let lease:ProfileLease|null=null;
    try{
      lease=await ProfileLease.acquire(this.profilePath);
      // Electron 44's session.fromPath creates/recovers the same persistent
      // Chromium storage at this exact, already exclusive profile path.
      const chromiumSession=session.fromPath(this.profilePath);
      const computer=createBackgroundWebComputer({
        offlineFixture:this.offlineFixture,sharedSession:chromiumSession});
      if(!computer.isHidden())throw Error('WEB_SUPERVISOR_BACKGROUND_VISIBLE');
      this.owner=lease;this.computer=computer;return computer;
    }catch(e){
      if(this.computer){this.computer.close();this.computer=null;}
      if(lease)await lease.release();
      this.owner=null;
      throw e;
    }finally{this.busy=false;}
  }
  requireComputer():BackgroundWebComputer{
    if(!this.running||!this.computer)throw Error('WEB_SUPERVISOR_NOT_RUNNING');
    return this.computer;
  }
  async stop():Promise<void>{
    if(this.busy)throw Error('WEB_SUPERVISOR_BUSY');
    if(!this.owner)return;
    this.busy=true;
    const owner=this.owner;
    try{
      // The owned hidden browser must retire before releasing profile lock.
      this.computer?.close();this.computer=null;
      await owner.release();
      this.owner=null;
    }finally{this.busy=false;}
  }
}
