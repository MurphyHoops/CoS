import {describe,it,expect} from 'vitest';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {tunnelHandshakeHealth} from '../../scripts/next-classic-live-doctor.mjs';
const tid='tunnel_'+'a'.repeat(32);
const hash=createHash('sha256').update(`core\0${tid}`).digest('hex').slice(0,24);
describe('real Tunnel handshake evidence',()=>{
  it('requires a PID owned by the live app and a fresh successful control-plane poll',async()=>{
    let last=Date.now();
    const http=createServer((req,res)=>{
      if(req.url!=='/metrics'){res.writeHead(404);res.end();return;}
      res.writeHead(200,{'Content-Type':'text/plain'});
      res.end(`commands_poll_last_successful_timestamp_seconds{scope="controlplane"} ${last/1000}\ncommands_poll_errors_total{error_kind="other"} 4\n`);
    });
    await new Promise<void>(resolve=>http.listen(0,'127.0.0.1',resolve));
    const address=http.address();
    if(!address || typeof address==='string')throw new Error('missing port');
    const base=`http://127.0.0.1:${address.port}`;
    const home=await mkdtemp(path.join(os.tmpdir(),'cos-next-handshake-test-'));
    const dir=path.join(home,'chat-on-steroids-tunnels',hash);
    try{
      await mkdir(dir,{recursive:true});
      await writeFile(path.join(dir,'client.pid'),'12345\n');
      await writeFile(path.join(dir,'health.url'),base+'\n');
      const config={tunnel:{tunnelId:tid}};
      const fresh=await tunnelHandshakeHealth(config,new Set([12345]),Date.now(),[home]);
      expect(fresh.core).toMatchObject({running:true,freshHandshake:true,pollErrorCount:4});
      const wrongPid=await tunnelHandshakeHealth(config,new Set([55555]),Date.now(),[home]);
      expect(wrongPid.core).toMatchObject({running:false,freshHandshake:false});
      last=Date.now()-110_000;
      const stale=await tunnelHandshakeHealth(config,new Set([12345]),Date.now(),[home]);
      expect(stale.core).toMatchObject({running:true,freshHandshake:false});
      last=Date.now()+1_000_000;
      const impossible=await tunnelHandshakeHealth(config,new Set([12345]),Date.now(),[home]);
      expect(impossible.core).toMatchObject({running:true,freshHandshake:false});
    }finally{await rm(home,{recursive:true,force:true});await new Promise<void>(resolve=>http.close(()=>resolve()));}
  });
});
