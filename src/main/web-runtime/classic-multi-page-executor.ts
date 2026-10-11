/** Multiple independently owned ChatGPT tabs under ONE original CoS 3.1.5
 * BrowserControlBroker identity. No Chrome Companion or OS-global input.
 */
import {randomUUID} from 'node:crypto';
import type {BrowserCommand,BrowserResult} from '../../shared/browser-control.js';
import type {NativeBrowserControlExecutor} from '../browser-control.js';
import type {BackgroundWebComputer} from './browser-driver-electron.js';
import type {NativeMultiPageSupervisor} from './chrome-supervisor.js';
import {NativeClassic316BrowserExecutor} from './classic316-browser-executor.js';

interface PageEntry {
  page:BackgroundWebComputer;
  executor:NativeClassic316BrowserExecutor;
}
export class NativeClassicMultiPageExecutor implements NativeBrowserControlExecutor {
  readonly id=randomUUID();
  readonly name='CoS Native ChatGPT Browser (no extension)';
  private pages=new Map<number,PageEntry>();
  private nextTabId=1;
  private retired=false;
  constructor(private readonly supervisor:NativeMultiPageSupervisor,
    private readonly offlineFixture=false){}
  private parseTabId(raw:unknown):number {
    // The ORIGINAL CoS Broker validates a UUID:index handle and converts
    // args.tabId to the NUMERIC tab index before dispatch to any transport.
    // Only this broker may be an authority; never infer a browser from active tab.
    if(typeof raw!=='number'||!Number.isSafeInteger(raw)||raw<1)
      throw Error('BROWSER_NATIVE_TAB_REQUIRED');
    const n=raw;
    if(!Number.isSafeInteger(n)||!this.pages.has(n))
      throw Error('BROWSER_NATIVE_TAB_UNKNOWN');
    return n;
  }
  private async list(command:BrowserCommand,
    check:()=>Promise<boolean>):Promise<BrowserResult> {
    if(!await check())throw Error('BROWSER_NATIVE_AUTH_REVOKED');
    const tabs:Record<string,unknown>[]=[];
    for(const page of this.pages.values()){
      const result=await page.executor.execute(
        {...command,args:{...command.args,action:'list'}},check);
      const row=result.value as {tabs?:Record<string,unknown>[]} | undefined;
      if(Array.isArray(row?.tabs))tabs.push(...row.tabs);
    }
    const offset=Number(command.args.offset??0),limit=Number(command.args.limit??100);
    const all=tabs.filter(tab=>{
      const filter=String(command.args.filter??'').toLowerCase();
      return !filter||String(tab.url??'').toLowerCase().includes(filter)||
        String(tab.title??'').toLowerCase().includes(filter);
    });
    const viewed=all.slice(offset,offset+limit);
    return {value:{browserId:this.id,tabs:viewed,total:all.length,
      truncated:offset+viewed.length<all.length,
      nextOffset:offset+viewed.length<all.length?offset+viewed.length:null}};
  }
  private async newTab(command:BrowserCommand,
    check:()=>Promise<boolean>):Promise<BrowserResult>{
    if(!await check())throw Error('BROWSER_NATIVE_AUTH_REVOKED');
    if(this.pages.size>=16)throw Error('BROWSER_NATIVE_TAB_LIMIT');
    const tabNumber=this.nextTabId++;
    const page=this.pages.size===0&&this.supervisor.listPageTargets().length===1
      ?this.supervisor.requireComputer():await this.supervisor.createPage();
    const executor=new NativeClassic316BrowserExecutor(
      page,this.offlineFixture,this.id,tabNumber);
    // Reserve one target per Actor BEFORE any browser navigation.
    this.pages.set(tabNumber,{page,executor});
    const result=await executor.execute(command,check);
    if(result.error)return result; // Unknown load result: do not auto retry.
    return result;
  }
  async execute(command:BrowserCommand,check:()=>Promise<boolean>):Promise<BrowserResult>{
    if(this.retired)return {error:'BROWSER_NATIVE_EXECUTOR_RETIRED'};
    try{
      if(command.tool==='browser_tabs'&&command.args.action==='list')
        return await this.list(command,check);
      if(command.tool==='browser_tabs'&&command.args.action==='new')
        return await this.newTab(command,check);
      const n=this.parseTabId(command.args.tabId);
      const entry=this.pages.get(n);
      if(!entry)throw Error('BROWSER_NATIVE_TAB_UNKNOWN');
      if(command.tool==='browser_tabs'&&command.args.action==='close'){
        if(!await check())throw Error('BROWSER_NATIVE_AUTH_REVOKED');
        // Closing requires the same exact owning Actor; release first.
        const released=await entry.executor.execute(
          {...command,args:{...command.args,action:'release'}},check);
        if(released.error)return released;
        this.pages.delete(n);
        await this.supervisor.closePage(entry.page);
        return {value:{tabId:this.id+':'+n,closed:true}};
      }
      return await entry.executor.execute(command,check);
    }catch(e){
      return {error:e instanceof Error?e.message.slice(0,360):
        'BROWSER_NATIVE_EXECUTION_UNKNOWN'};
    }
  }
  retire(){this.retired=true;this.pages.clear();}
}
