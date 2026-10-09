/** Official MCP tool protocol, local-only until a verified user-owned Tunnel is connected. */
import {createMcpHandler,McpServer} from '@modelcontextprotocol/server';
import {z} from 'zod';
import type {WebFirstReadAuthority} from './project-read.js';
import type {WebFirstOperationJournal,ProjectOperation} from './operation-journal.js';

/** Stable local catalogue. ChatGPT's *approved* tool snapshot is independent. */
export const WEBFIRST_CORE_TOOLS = Object.freeze([
  'runtime_health','identity_diagnostics','project_list','project_ls','project_read'
]);
export const WEBFIRST_CORE_TOOLSET = 'web-first-readonly-p2b-v1';


export function createWebFirstCoreMcp(authority:WebFirstReadAuthority,journal?:WebFirstOperationJournal){
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
    register('project_read','Read max 32 KiB UTF-8 from registered project, with one native approval.',
      {project_id:z.string(),relative_path:z.string()},
      args=>authority.readFile(args.project_id as string,args.relative_path as string));
    return server;
  });
  return {handler,close:()=>handler.close()};
}
