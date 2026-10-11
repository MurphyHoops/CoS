/** An owned no-extension Chromium surface behind one persistent Electron Session.
 *
 * UI/app upgrades replace code, NOT the profile directory. ProfileLease is
 * acquired BEFORE the native session is opened. Never owns global OS input.
 * This is an early single-surface transport substrate, not a model/agent owner.
 */
import {session,type Session} from 'electron';
import path from 'node:path';
import {ProfileLease} from './profile-owner.js';
import {createBackgroundWebComputer,type BackgroundWebComputer}
  from './browser-driver-electron.js';

export class ElectronWebRuntimeSupervisor {
  private owner:ProfileLease|null=null;
  private computer:BackgroundWebComputer|null=null;
  private readonly pages=new Set<BackgroundWebComputer>();
  private browserSession:Session|null=null;
  private busy=false;
  readonly profilePath:string;
  constructor(root:string,private readonly offlineFixture=false){
    if(!path.isAbsolute(root)||root.includes('\0'))throw Error('WEB_SUPERVISOR_ROOT_INVALID');
    this.profilePath=path.join(root,'profile');
  }
  get ownedSession():Session {
    if(!this.running||!this.browserSession)throw Error('WEB_SUPERVISOR_NOT_RUNNING');
    return this.browserSession;
  }
  get running():boolean{return this.owner!==null&&this.browserSession!==null&&this.pages.size>0;}
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
      this.owner=lease;
      this.browserSession=chromiumSession;
      this.computer=computer;
      this.pages.add(computer);
      return computer;
    }catch(e){
      for(const page of this.pages)page.close();
      this.pages.clear();
      if(this.computer){this.computer.close();this.computer=null;}
      this.browserSession=null;
      if(lease)await lease.release();
      this.owner=null;
      throw e;
    }finally{this.busy=false;}
  }
  /** Different Workers get different Page targets but share exactly one
   * verified browser owner/Profile. Neither page can take desktop focus.
   */
  createPage():BackgroundWebComputer {
    if(!this.running||this.busy||!this.browserSession)
      throw Error('WEB_SUPERVISOR_NOT_RUNNING');
    if(this.pages.size>=16)throw Error('WEB_SUPERVISOR_PAGE_LIMIT');
    const page=createBackgroundWebComputer({
      offlineFixture:this.offlineFixture,sharedSession:this.browserSession});
    if(!page.isHidden()){page.close();throw Error('WEB_SUPERVISOR_BACKGROUND_VISIBLE');}
    this.pages.add(page);
    return page;
  }
  /** Only retire pages created by this exact supervisor instance. */
  closePage(page:BackgroundWebComputer):void {
    if(!this.pages.has(page))throw Error('WEB_SUPERVISOR_FOREIGN_PAGE');
    this.pages.delete(page);
    page.close();
    if(this.computer===page)this.computer=null;
  }
  listPageTargets():number[] {
    return [...this.pages].map(page=>page.webContents.id);
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
      for(const page of this.pages)page.close();
      this.pages.clear();
      this.computer=null;this.browserSession=null;
      await owner.release();
      this.owner=null;
    }finally{this.busy=false;}
  }
}
