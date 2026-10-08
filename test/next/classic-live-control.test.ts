import {describe,it,expect} from 'vitest';
import path from 'node:path';
import os from 'node:os';
import {liveControlPermitted} from '../../src/main/next/runtime/classic-live-control.js';
const tmp=os.tmpdir();
const home='/Users/example';
const dir=path.join(tmp,'cos-next-live-abcde');
const base={isNext:true,packaged:true,home,userData:path.join(home,'Library/Application Support/chat-on-steroids-next'),
  dir,socket:path.join(dir,'control.sock'),token:'a'.repeat(64)};
describe('operator-only actual Next control gate',()=>{
  it('requires a private named temporary socket and the exact normal Next profile',()=>{
    expect(liveControlPermitted(base)).toBe(true);
    expect(liveControlPermitted({...base,socket:path.join(tmp,'control.sock')})).toBe(false);
    expect(liveControlPermitted({...base,dir:path.join(home,'.config')})).toBe(false);
    expect(liveControlPermitted({...base,userData:path.join(home,'Library/Application Support/chat-on-steroids')})).toBe(false);
  });
  it('rejects old CoS, unpackaged/dev, a synthetic HOME and malformed tokens',()=>{
    expect(liveControlPermitted({...base,isNext:false})).toBe(false);
    expect(liveControlPermitted({...base,packaged:false})).toBe(false);
    const fakeHome=path.join(tmp,'cos-next-ctl-synthetic');
    expect(liveControlPermitted({...base,home:fakeHome,userData:path.join(fakeHome,'Library/Application Support/chat-on-steroids-next')})).toBe(false);
    expect(liveControlPermitted({...base,token:'x'.repeat(64)})).toBe(false);
  });
});
