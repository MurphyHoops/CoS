/** Official MCP tool protocol, local-only until a verified user-owned Tunnel is connected. */
import {createMcpHandler,McpServer} from '@modelcontextprotocol/server';
import {z} from 'zod';
import type {WebFirstReadAuthority} from './project-read.js';
import type {WebFirstOperationJournal,ProjectOperation} from './operation-journal.js';
import type {WebFirstTaskTools} from './task-tools.js';
import type {WebFirstProjectWriter} from './project-write.js';

/** Stable local catalogue. ChatGPT's *approved* tool snapshot is independent. */
export const WEBFIRST_CORE_TOOLS = Object.freeze([
  'runtime_health','identity_diagnostics','project_list','project_ls','project_read','project_find','project_replace',
  'task_begin','task_status','task_checkpoint','task_wait','task_finish_request'
]);
export const WEBFIRST_CORE_TOOLSET = 'web-first-project-workflow-p3.2-v1';


export function createWebFirstCoreMcp(authority:WebFirstReadAuthority,journal?:WebFirstOperationJournal,
  tasks?:WebFirstTaskTools,writes?:WebFirstProjectWriter){
  const handler=createMcpHandler(()=>{
    const server=new McpServer({name:'cos-next-webfirst',version:'4.0.0-alpha.1'});
    server.registerTool('runtime_health',{
      description:'Local Web-First bridge readiness; not proof of an authorized ChatGPT identity.',
      inputSchema:{},annotations:{readOnlyHint:true,idempotentHint:true,openWorldHint:false}
    },async()=>{
      // Additional fields are additive to the previously published health
      // schema. They prove only the *server's* tool list, not ChatGPT approval.
      const result={runtime:'WEB_FIRST',mcp:'LOCAL_ONLY',identity_verified:false,
        mission_authorized:false,model_inference:'NONE',
        server_toolset:WEBFIRST_CORE_TOOLSET,
        server_tools:[...WEBFIRST_CORE_TOOLS],
        chatgpt_tool_registry:'NOT_VERIFIED'};
      return {content:[{type:'text' as const,text:JSON.stringify(result)}],structuredContent:result};
    });
    server.registerTool('identity_diagnostics',{
      description:'Cannot verify a ChatGPT caller from untrusted metadata.',inputSchema:{},
      annotations:{readOnlyHint:true,idempotentHint:true,openWorldHint:false}
    },async()=>{
      const result={identity_verified:false,mission_authorized:false,authority:'UNVERIFIED'};
      return {content:[{type:'text' as const,text:JSON.stringify(result)}],structuredContent:result};
    });
    const register=(name:ProjectOperation,description:string,schema:Record<string,z.ZodTypeAny>,
      fn:(args:Record<string,unknown>)=>Promise<unknown>)=>{
      server.registerTool(name,{description,inputSchema:schema,
        annotations:{readOnlyHint:true,idempotentHint:false,openWorldHint:false}
      },async(args)=>{
        const projectId=typeof args.project_id==='string'?args.project_id:undefined;
        let receipt:string|undefined;
        try{
          // Fail closed when the STARTED receipt cannot be durably recorded.
          receipt=await journal?.start(name,projectId);
          const result=await fn(args);
          if(receipt)await journal?.finish(receipt,name,projectId,true);
          return {content:[{type:'text' as const,text:JSON.stringify(result)}],structuredContent:{result}};
        }catch(error){
          if(receipt)await journal?.finish(receipt,name,projectId,false).catch(()=>undefined);
          const message=error instanceof Error?error.message:'READ_DENIED';
          const code=/^[A-Z_]+$/.test(message)?message:'READ_DENIED';
          return {isError:true,content:[{type:'text' as const,text:code}]};
        }
      });
    };
    register('project_list','List named local projects ONLY after a separate native approval. No project paths.',{},
      ()=>authority.listProjects());
    register('project_ls','List filenames under a registered local project, with one native approval.',
      {project_id:z.string(),relative_path:z.string()},
      args=>authority.listDirectory(args.project_id as string,args.relative_path as string));
    register('project_find','Bounded literal filename and text search inside one approved project directory; skips hidden and sensitive files.',
      {project_id:z.string(),relative_path:z.string(),query:z.string().min(2).max(100)},
      args=>authority.find(args.project_id as string,args.relative_path as string,args.query as string));
    register('project_read','Read max 32 KiB UTF-8 from registered project, with one native approval.',
      {project_id:z.string(),relative_path:z.string()},
      args=>authority.readFile(args.project_id as string,args.relative_path as string));
    server.registerTool('project_replace',{
      description:'Replace one exact unique text span in a registered project file with expected SHA-256. Requires separate native approval for every write; read grants never apply.',
      inputSchema:{project_id:z.string(),relative_path:z.string(),expected_sha256:z.string().regex(/^[a-f0-9]{64}$/),
        old_text:z.string().min(1).max(4000),new_text:z.string().max(4000)},
      annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:false,openWorldHint:false}
    },async args=>{
      const projectId=args.project_id;
      let receipt:string|undefined;
      try{
        if(!writes)throw Error('WRITE_CAPABILITY_DISABLED');
        receipt=await journal?.start('project_replace',projectId);
        const result=await writes.replace({projectId,relativePath:args.relative_path,
          expectedSha256:args.expected_sha256,oldText:args.old_text,newText:args.new_text});
        if(receipt)await journal?.finish(receipt,'project_replace',projectId,true);
        return {content:[{type:'text' as const,text:JSON.stringify(result)}],structuredContent:{result}};
      }catch(error){
        if(receipt)await journal?.finish(receipt,'project_replace',projectId,false).catch(()=>undefined);
        const message=error instanceof Error?error.message:'PROJECT_WRITE_REJECTED';
        return {isError:true,content:[{type:'text' as const,
          text:/^[A-Z_]+$/.test(message)?message:'PROJECT_WRITE_REJECTED'}]};
      }
    });
    if(tasks){
      // Public snapshot names and schemas remain stable across live refreshes.
      // These update only local task metadata, never run code or type into ChatGPT.
      const taskTool=(name:string,description:string,schema:Record<string,z.ZodTypeAny>,
        call:(args:Record<string,unknown>)=>Promise<unknown>,readOnly=false)=>{
        server.registerTool(name,{description,inputSchema:schema,
          annotations:{readOnlyHint:readOnly,openWorldHint:false,idempotentHint:readOnly}
        },async(args)=>{
          try{const result=await call(args);
            return {content:[{type:'text' as const,text:JSON.stringify(result)}],structuredContent:{result}};
          }catch(error){
            const message=error instanceof Error?error.message:'TASK_OPERATION_REJECTED';
            return {isError:true,content:[{type:'text' as const,
              text:/^[A-Z_]+$/.test(message)?message:'TASK_OPERATION_REJECTED'}]};
          }
        });
      };
      taskTool('task_begin','Start durable local task after one native user approval, without using a model API.',
        {project_id:z.string(),goal:z.string().min(1).max(2000)},
        a=>tasks.begin(a.project_id as string,a.goal as string));
      taskTool('task_status','Read the durable task phase and revision. No auto-resume.',
        {task_id:z.string().uuid()},a=>tasks.status(a.task_id as string),true);
      taskTool('task_checkpoint','Record reported progress using an exact revision and retry nonce.',
        {task_id:z.string().uuid(),revision:z.number().int().min(1),nonce:z.string().min(8).max(100),note:z.string().min(1).max(1000)},
        a=>tasks.checkpoint(a.task_id as string,a.revision as number,a.nonce as string,a.note as string));
      taskTool('task_wait','Persist a manual or time-bounded wait; does not send a ChatGPT message.',
        {task_id:z.string().uuid(),revision:z.number().int().min(1),nonce:z.string().min(8).max(100),minutes:z.number().int().min(1).max(10080).nullable()},
        a=>tasks.wait(a.task_id as string,a.revision as number,a.nonce as string,a.minutes as number|null));
      taskTool('task_finish_request','Request native operator review; not an automatic success claim.',
        {task_id:z.string().uuid(),revision:z.number().int().min(1),nonce:z.string().min(8).max(100),note:z.string().min(1).max(1000)},
        a=>tasks.finishRequest(a.task_id as string,a.revision as number,a.nonce as string,a.note as string));
    }
    return server;
  });
  return {handler,close:()=>handler.close()};
}
