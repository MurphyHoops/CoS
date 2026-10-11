import {describe,it,expect,vi} from 'vitest';
import {existsSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
vi.mock('electron',()=>({BrowserWindow:class{},session:{}}));
import {ChromeWebRuntimeSupervisor,STANDARD_CHROME_BINARY}
  from '../../src/main/web-runtime/chrome-supervisor.js';

describe.skipIf(process.platform!=='darwin'||!existsSync(STANDARD_CHROME_BINARY))(
  'standard Chrome no-extension supervisor',()=>{
  it('holds one isolated profile and separates two native page targets across restart',async()=>{
    const root=mkdtempSync(path.join(tmpdir(),'cos-chrome-supervisor-'));
    const first=new ChromeWebRuntimeSupervisor(root);
    try{
      const a=await first.start();
      const b=await first.createPage();
      expect(a.webContents.id).not.toEqual(b.webContents.id);
      expect(await a.webContents.executeJavaScript('12+1')).toEqual(13);
      expect(await b.webContents.executeJavaScript('12+2')).toEqual(14);
      expect(first.listPageTargets()).toHaveLength(2);
      const other=new ChromeWebRuntimeSupervisor(root);
      await expect(other.start()).rejects.toThrow('WEB_PROFILE_ALREADY_OWNED');
      await first.closePage(b);
      await first.stop();
      const restarted=new ChromeWebRuntimeSupervisor(root);
      try{await restarted.start();
        expect(await restarted.requireComputer().webContents.executeJavaScript('14+1'))
          .toEqual(15);
      }finally{await restarted.stop();}
    }finally{if(first.running)await first.stop();rmSync(root,{recursive:true,force:true});}
  },45000);
});
