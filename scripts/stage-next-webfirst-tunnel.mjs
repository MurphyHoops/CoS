#!/usr/bin/env node
/** Stage the existing Next-owned native tunnel into this preview package; never download binaries. */
import {resolve,join} from 'node:path';
import {promises as fs} from 'node:fs';
import {execFileSync} from 'node:child_process';
const app=process.argv[2];
if(!app||!app.endsWith('.app'))throw Error('EXISTING_NEXT_APP_REQUIRED');
const executable=join(resolve(app),'Contents/Resources/tunnel/tunnel-client');
const info=await fs.stat(executable);
if(!info.isFile()||info.size<5*1024*1024||info.size>60*1024*1024)
  throw Error('EXISTING_TUNNEL_SIZE_INVALID');
const details=execFileSync('/usr/bin/file',['-b',executable],{encoding:'utf8'});
if(!details.includes('Mach-O')||!details.includes('arm64'))throw Error('EXISTING_TUNNEL_NOT_ARM64');
const destination=resolve('resources/packaging/tunnel/darwin/arm64/tunnel-client');
await fs.mkdir(resolve('resources/packaging/tunnel/darwin/arm64'),{recursive:true});
await fs.copyFile(executable,destination);
await fs.chmod(destination,0o755);
const staged=await fs.stat(destination);
if(staged.size!==info.size)throw Error('STAGED_TUNNEL_SIZE_MISMATCH');
console.log('WEBFIRST_NATIVE_TUNNEL_STAGED=PASS');
