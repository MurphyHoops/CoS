/** Ephemeral one-user native MCP loopback. Nothing here registers a ChatGPT plugin. */
import http from 'node:http';
import {randomBytes} from 'node:crypto';
import {Readable} from 'node:stream';
import {createWebFirstCoreMcp} from './project-mcp.js';
import type {WebFirstReadAuthority} from './project-read.js';
import type {WebFirstOperationJournal} from './operation-journal.js';
import type {WebFirstTaskTools} from './task-tools.js';
import type {WebFirstProjectWriter} from './project-write.js';
const MAX_REQUEST=64*1024;
function reject(res:http.ServerResponse,status:number,code:string){
  res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});
  res.end(JSON.stringify({error:code}));
}
export async function createWebFirstCoreLoopback(authority:WebFirstReadAuthority,journal?:WebFirstOperationJournal,
  tasks?:WebFirstTaskTools,writes?:WebFirstProjectWriter){
  const core=createWebFirstCoreMcp(authority,journal,tasks,writes);
  const secret=randomBytes(32).toString('base64url');
  const route='/web-first/'+secret+'/mcp';
  const metadata='/.well-known/oauth-protected-resource'+route;
  const httpServer=http.createServer(async(req,res)=>{
    const host=req.headers.host??'';
    if(!/^127\.0\.0\.1(?::\d{1,5})?$/.test(host))return reject(res,403,'invalid_host');
    if(req.headers.origin)return reject(res,403,'browser_origin_not_allowed');
    const requestPath=(req.url??'').split('?')[0];
    if(requestPath===metadata){
      if(req.method!=='GET')return reject(res,405,'method_not_allowed');
      const a=httpServer.address();
      if(!a||typeof a==='string')return reject(res,503,'not_ready');
      const body=JSON.stringify({resource:'http://127.0.0.1:'+a.port+route,
        resource_name:'CoS Next Web-First native read-only project tools',
        authorization_servers:[],scopes_supported:[]});
      res.writeHead(200,{'content-type':'application/json','cache-control':'no-store',
        'content-length':Buffer.byteLength(body)});res.end(body);return;
    }
    if(requestPath!==route)return reject(res,404,'not_found');
    if(!['POST','GET','DELETE'].includes(req.method??''))return reject(res,405,'method_not_allowed');
    const length=Number(req.headers['content-length']??0);
    if(!Number.isFinite(length)||length<0||length>MAX_REQUEST)return reject(res,413,'body_too_large');
    try{
      let bytes=0;
      const chunks:Buffer[]=[];
      if(req.method==='POST')for await(const part of req){
        const data=Buffer.isBuffer(part)?part:Buffer.from(part);
        bytes+=data.length;
        if(bytes>MAX_REQUEST){reject(res,413,'body_too_large');req.resume();return;}
        chunks.push(data);
      }
      const headers=new Headers();
      for(const [name,value] of Object.entries(req.headers)){
        if(!value||['host','content-length','connection','origin'].includes(name))continue;
        headers.set(name,Array.isArray(value)?value.join(','):value);
      }
      const answer=await core.handler.fetch(new Request('http://127.0.0.1'+route,{
        method:req.method,headers,
        ...(req.method==='POST'?{body:Buffer.concat(chunks)}:{})
      }));
      res.writeHead(answer.status,Object.fromEntries(answer.headers.entries()));
      if(answer.body)Readable.fromWeb(answer.body as Parameters<typeof Readable.fromWeb>[0]).pipe(res);
      else res.end();
    }catch{
      if(!res.headersSent)reject(res,500,'mcp_error'); else res.end();
    }
  });
  try{
    await new Promise<void>((resolve,reject)=>{
      httpServer.once('error',reject);
      httpServer.listen(0,'127.0.0.1',resolve);
    });
  }catch(error){await core.close();throw error;}
  const address=httpServer.address();
  if(!address||typeof address==='string')throw Error('LISTEN_FAILED');
  let closeFlight:Promise<void>|null=null;
  return {
    endpointUrl:'http://127.0.0.1:'+address.port+route,
    port:address.port,
    close:()=>closeFlight??=(async()=>{
      await new Promise<void>((resolve,reject)=>httpServer.close(err=>err?reject(err):resolve()));
      await core.close();
    })()
  };
}
