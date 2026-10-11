#!/usr/bin/env node
/**
 * Build the complete original CoS Classic UI/Goal/Agent/MCP entrypoint,
 * then bundle the SDK's transitive JS dependencies. Electron Builder can
 * otherwise silently omit indirect packages such as @hono/node-server.
 *
 * Native ABI modules stay external and get copied by electron-builder.next.
 */
import {spawnSync} from 'node:child_process';
import {readdir,readFile,rename,rm,stat} from 'node:fs/promises';
import path from 'node:path';
import {build} from 'esbuild';

const cwd=process.cwd();
const compiler=path.resolve(cwd,'node_modules/.bin/electron-vite');
const built=spawnSync(compiler,['build','--config','electron.vite.next.config.ts'],
  {cwd,stdio:'inherit'});
if(built.status!==0)process.exit(built.status??1);
const folder=path.resolve(cwd,'out-next/main/chunks');
const list=await readdir(folder);
const chunks=list.filter(file=>/^index-[A-Za-z0-9_-]+\.js$/.test(file));
if(chunks.length!==1)throw Error('CLASSIC_ENTRY_CHUNK_INVALID');
const original=path.join(folder,chunks[0]);
const temp=original+'.complete-runtime.tmp.cjs';
try{
  const result=await build({
    entryPoints:[original],outfile:temp,bundle:true,
    platform:'node',format:'cjs',target:'node22',
    external:['electron','node-pty','sharp','tree-sitter','tree-sitter-bash','@img/*'],
    logLevel:'silent',metafile:true
  });
  const source=await readFile(temp,'utf8');
  if(source.length<1_000_000||
    source.includes('require("@modelcontextprotocol/node")')||
    source.includes('require("@hono/node-server")')||
    source.includes('require("@modelcontextprotocol/core")')||
    source.includes('require("fflate")'))
    throw Error('CLASSIC_TRANSITIVE_SDK_BUNDLE_INCOMPLETE');
  await rename(temp,original);
  const size=(await stat(original)).size;
  if(size<2_000_000)throw Error('CLASSIC_RUNTIME_BUNDLE_TOO_SMALL');
  console.log('NEXT_CLASSIC_RUNTIME_SDK_BUNDLE=PASS bytes='+size+
    ' outputs='+Object.keys(result.metafile.outputs).length);
}catch(error){await rm(temp,{force:true});throw error;}
