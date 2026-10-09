#!/usr/bin/env node
/** Standalone Web-First main bundle, including installed MCP SDK dependencies. */
import {spawnSync} from 'node:child_process';
import {rename,rm,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {build} from 'esbuild';
const cwd=process.cwd();
const vite=spawnSync(resolve(cwd,'node_modules/.bin/electron-vite'),
  ['build','--config','electron.vite.next-webfirst.config.ts'],{cwd,stdio:'inherit'});
if(vite.status!==0)process.exit(vite.status??1);
const output=resolve(cwd,'out-webfirst/main/web-first-main.js');
const staged=resolve(cwd,'out-webfirst/main/.web-first-bundled.tmp.cjs');
try {
  await build({entryPoints:[output],outfile:staged,bundle:true,platform:'node',
    format:'cjs',target:['node22'],external:['electron'],logLevel:'silent'});
  const source=await readFile(staged,'utf8');
  if(!source.includes('WebContentsView')||!source.includes('cos-next-web-first-chatgpt')||
      !source.includes('McpServer')||source.includes('require("@modelcontextprotocol/server")')||
      source.includes('require("zod")'))throw Error('INCOMPLETE_WEBFIRST_MCP_BUNDLE');
  await rename(staged,output);
  console.log('WEB_FIRST_BUNDLED_MCP_SDK=PASS');
}catch(error){await rm(staged,{force:true});throw error;}
