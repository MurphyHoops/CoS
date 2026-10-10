import {afterEach,describe,it,expect,vi} from 'vitest';
import {BrowserControlBroker} from '../../src/main/browser-control.js';
import type {BrowserCommand,BrowserResult} from '../../src/shared/browser-control.js';
const id='b39c9f44-5b1a-476d-9ccc-6fded59b6e1a';
const brokers:BrowserControlBroker[]=[];
afterEach(()=>{brokers.splice(0).forEach(b=>b.reset());vi.useRealTimers();});
describe('CoS v3.1.16 original BrowserControlBroker native injection',()=>{
  it('keeps exact current tool registration while skipping Chrome Companion',async()=>{
    const broker=new BrowserControlBroker();brokers.push(broker);
    const observed:BrowserCommand[]=[];
    const dispose=broker.installNativeExecutor({
      id,name:'CoS Native Browser (no extension)',
      async execute(command,check):Promise<BrowserResult>{
        expect(await check()).toBe(true);
        observed.push(command);
        return {value:{accepted:true}};
      }
    });
    expect(broker.browsers()).toEqual([{id,name:'CoS Native Browser (no extension)',enabled:true}]);
    const result=await broker.execute('browser_tabs',{action:'list'},'session:actor-A',null,
      async()=>true);
    expect(result.value).toEqual({accepted:true});
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({tool:'browser_tabs',owner:'session:actor-A'});
    dispose();
    expect(broker.browsers()).toEqual([]);
    const offline=await broker.execute('browser_tabs',{action:'list'},'session:actor-A',null,
      async()=>true);
    expect(offline.value).toMatchObject({browsers:[],tabs:[]});
  });
  it('refuses a revoked project grant BEFORE delivering to native Chromium',async()=>{
    const broker=new BrowserControlBroker();brokers.push(broker);
    const send=vi.fn(async():Promise<BrowserResult>=>({value:{sent:true}}));
    broker.installNativeExecutor({id,name:'Native',execute:send});
    let allowed=false;
    const denied=await broker.execute('browser_tabs',{action:'new'},'session:A',null,
      async()=>allowed);
    expect(denied.error).toContain('PERMISSION_REVOKED');
    expect(send).not.toHaveBeenCalled();
    allowed=true;
    const allowedResult=await broker.execute('browser_tabs',{action:'list'},
      'session:A',null,async()=>allowed);
    expect(allowedResult).toMatchObject({value:{sent:true}});
    expect(send).toHaveBeenCalledOnce();
  });
  it('old registered Chrome stays explicitly selectable but never silently overrides native',async()=>{
    const broker=new BrowserControlBroker();brokers.push(broker);
    const calls=vi.fn(async():Promise<BrowserResult>=>({value:'native'}));
    broker.installNativeExecutor({id,name:'Native',execute:calls});
    const legacyId='11111111-1111-4111-8111-111111111111';
    broker.poll(legacyId,'Chrome Companion',true);
    const needsChoice=await broker.execute('browser_snapshot',{},'session:A',null,async()=>true);
    expect(needsChoice.error).toContain('BROWSER_REQUIRED');
    expect(calls).not.toHaveBeenCalled();
    const chosen=await broker.execute('browser_tabs',{action:'list',browserId:id},
      'session:A',null,async()=>true);
    expect(chosen.value).toBe('native');
  });
  it('an already dispatched failing executor yields UNCERTAIN rather than replay',async()=>{
    const broker=new BrowserControlBroker();brokers.push(broker);
    const spy=vi.fn(async()=>{throw Error('unconfirmed browser event');});
    broker.installNativeExecutor({id,name:'Native',execute:spy});
    const out=await broker.execute('browser_action',{action:'click'},'session:A',null,
      async()=>true);
    expect(out.error).toContain('UNCONFIRMED');
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
