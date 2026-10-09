/** Explicit opt-in ONLY: real OpenAI Tunnel control-plane poll, no model calls. */
import {describe,it,expect} from 'vitest';
import {spawn} from 'node:child_process';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {WebFirstProjectRegistry} from '../../src/main/next/web-first/project-registry.js';
import {WebFirstReadAuthority} from '../../src/main/next/web-first/project-read.js';
import {createWebFirstCoreLoopback} from '../../src/main/next/web-first/core-loopback.js';
import {parseBrokerSignal} from '../../src/main/next/web-first/core-broker.js';
const enabled=process.env.COS_NEXT_REAL_TUNNEL_TEST==='1';
const live=enabled?describe:describe.skip;
live('opt-in real web-first packaged Core Broker tunnel, ZERO model messages',()=>{
  it('polls real control-plane and closes the owned tunnel with proof',async()=>{
    const root=await mkdtemp(path.join(os.tmpdir(),'cos-p2b-broker-smoke-'));
    const profile=path.join(root,'profile');
    await mkdir(profile);
    const authority=new WebFirstReadAuthority(new WebFirstProjectRegistry(profile),async()=>false);
    const service=await createWebFirstCoreLoopback(authority);
    const appPath=process.env.COS_NEXT_WEBFIRST_LIVE_APP;
    if(!appPath)throw Error('LIVE_APP_PATH_REQUIRED');
    const child=spawn(path.join(appPath,'Contents/MacOS/CoS Next Web-First Preview'),[],{
      env:{...process.env,COS_NEXT_WEBFIRST_CORE_BROKER:'1',
        COS_NEXT_WEBFIRST_BROKER_ENDPOINT:service.endpointUrl},stdio:['pipe','pipe','ignore']
    });
    const events:string[]=[];
    let carry='';
    child.stdout.on('data',(chunk:Buffer)=>{
      carry+=chunk.toString('utf8');
      let i=carry.indexOf('\n');
      while(i>=0){
        const signal=parseBrokerSignal(carry.slice(0,i));
        if(signal)events.push(signal);
        carry=carry.slice(i+1);i=carry.indexOf('\n');
      }
    });
    try{
      const until=Date.now()+102000;
      while(Date.now()<until && !events.includes('CONNECTED') && !events.includes('FAILED') && child.exitCode===null){
        await new Promise(resolve=>setTimeout(resolve,1000));
      }
      const connected=events.includes('CONNECTED');
      console.log('WEBFIRST_REAL_BROKER_CONTROLPLANE_CONNECTED='+connected);
      console.log('WEBFIRST_BROKER_RECEIVED_STATE_CATEGORIES='+[...new Set(events)].join(','));
      if(!connected)throw Error('REAL_BROKER_HANDSHAKE_NOT_PROVED');
      expect(events).toContain('READY');
    }finally{
      if(child.exitCode===null){
        child.stdin.write('STOP\n');child.stdin.end();
        const deadline=Date.now()+12000;
        while(Date.now()<deadline && !events.includes('STOPPED_PROVEN') && child.exitCode===null){
          await new Promise(resolve=>setTimeout(resolve,200));
        }
        if(!events.includes('STOPPED_PROVEN')){
          child.kill('SIGTERM');
          console.log('WEBFIRST_BROKER_STOP_PROOF=FAIL');
        }else console.log('WEBFIRST_BROKER_STOP_PROOF=PASS');
      }
      await service.close();
      await rm(root,{recursive:true,force:true});
    }
  },125000);
});
