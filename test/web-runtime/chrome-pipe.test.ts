import {describe,it,expect} from 'vitest';
import {existsSync,mkdtempSync,rmSync} from 'node:fs';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {AddressInfo} from 'node:net';
import {ChromePipe} from '../../src/main/web-runtime/chrome-pipe.js';

const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
describe.skipIf(process.platform!=='darwin'||!existsSync(CHROME))(
  'standard Chrome CDP pipe / isolated profile integration',()=>{
  it('two isolated targets, same-document route identity, durable profile restart',async()=>{
    const profile=mkdtempSync(path.join(tmpdir(),'cos-standard-chrome-'));
    const fixture=createServer((req,res)=>{
      res.writeHead(200,{'content-type':'text/html; charset=utf-8'});
      res.end('<!doctype html><title>'+(
        req.url?.startsWith('/a')?'cos-a':'cos-b')+'</title>');
    });
    await new Promise<void>(resolve=>fixture.listen(0,'127.0.0.1',resolve));
    const origin='http://127.0.0.1:'+(fixture.address() as AddressInfo).port;
    let pipe:ChromePipe|null=null;
    try{
      pipe=await ChromePipe.launch(profile,CHROME);
      const p1=await pipe.createPage();
      const p2=await pipe.createPage();
      // Operator can reveal an existing page for official verification and
      // return it offscreen without restarting Chrome or changing Profile.
      await p1.setOperatorVisible(true);
      await p1.setOperatorVisible(false);
      expect(p1.targetId).not.toEqual(p2.targetId);
      expect(await p1.executeJavaScript('1+2')).toBe(3);
      await p1.command('Page.navigate',{url:origin+'/a'});
      await p2.command('Page.navigate',{url:origin+'/b'});
      for(let i=0;i<40;i++){
        if((await p1.executeJavaScript('document.title'))==='cos-a'&&
          (await p2.executeJavaScript('document.title'))==='cos-b')break;
        await new Promise(resolve=>setTimeout(resolve,40));
      }
      expect(await p1.executeJavaScript('document.title')).toEqual('cos-a');
      expect(await p2.executeJavaScript('document.title')).toEqual('cos-b');
      await p1.executeJavaScript('history.pushState({},"","/a#cos-spa-route")');
      for(let i=0;i<35&&!p1.getURL().endsWith('#cos-spa-route');i++)
        await new Promise(resolve=>setTimeout(resolve,30));
      expect(p1.getURL()).toContain('#cos-spa-route');
      expect(p2.getURL()).not.toContain('#cos-spa-route');
      await pipe.closePage(p1);await pipe.closePage(p2);
      await pipe.close();pipe=null;
      pipe=await ChromePipe.launch(profile,CHROME);
      const p3=await pipe.createPage();
      expect(await p3.executeJavaScript('2+3')).toBe(5);
      await pipe.closePage(p3);
    }finally{
      if(pipe)await pipe.close();
      await new Promise<void>(resolve=>fixture.close(()=>resolve()));
      rmSync(profile,{recursive:true,force:true});
    }
  },45000);
});
