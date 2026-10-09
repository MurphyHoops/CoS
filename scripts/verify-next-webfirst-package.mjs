/** No network/model requests. Inspect a genuine packaged ARM64 Web-First P1 only. */
import {stat} from 'node:fs/promises';
import {resolve,join,isAbsolute} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const asar=require('@electron/asar');
const arg=process.argv[2];
if(!arg||!isAbsolute(arg)||!arg.endsWith('.app'))throw Error('WEBFIRST_EXPECTED_ABSOLUTE_APP');
const app=resolve(arg), info=join(app,'Contents/Info.plist');
const bundle=execFileSync('/usr/libexec/PlistBuddy',['-c','Print :CFBundleIdentifier',info],{encoding:'utf8'}).trim();
if(bundle!=='com.chatonsteroids.next.webfirst.preview')throw Error('INCORRECT_APP_ID');
const arch=execFileSync('/usr/bin/file',['-b',join(app,'Contents/MacOS/CoS Next Web-First Preview')],{encoding:'utf8'});
if(!arch.includes('arm64'))throw Error('INCORRECT_ARCH');
const archive=join(app,'Contents/Resources/app.asar');
const files=asar.listPackage(archive);
if(!files.includes('/out-webfirst/main/web-first-main.js'))throw Error('MISSING_WEB_FIRST');
const forbidden=['/out-next/','/extension/','/tunnel/','/out-webfirst/preload/','/out-webfirst/renderer/'];
for(const item of forbidden)if(files.some(f=>f.includes(item)))throw Error('LEGACY_DEPENDENCY_BUNDLED_'+item);
const main=asar.extractFile(archive,'out-webfirst/main/web-first-main.js').toString('utf8');
for(const marker of ['WebContentsView','chatgpt.com','cos-next-web-first-chatgpt','web-first-projects.json','添加项目目录']){
  if(!main.includes(marker))throw Error('WEB_FIRST_RUNTIME_MARKER_MISSING');
}
for(const marker of ['tunnel-client','codex-cli','COS_NEXT_CLASSIC_WORKFLOW','CHROME_EXTENSION']){
  if(main.includes(marker))throw Error('LEGACY_RUNTIME_MARKER_FOUND');
}
if((await stat(archive)).size<1024)throw Error('EMPTY_WEB_FIRST_ARCHIVE');
console.log('WEB_FIRST_P1_PACKAGE_GATE=PASS');
console.log('WEB_FIRST_BUNDLE_ID='+bundle);
console.log('WEB_FIRST_ARM64_EXECUTABLE=PASS');
console.log('WEB_FIRST_LEGACY_CHROME_AND_CODEX_DEPENDENCY=ABSENT');
