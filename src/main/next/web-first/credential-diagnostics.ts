/** Read-only native macOS credential preflight; never prints plaintext, fields or exception details. */
import {safeStorage} from 'electron';
import {promises as fs} from 'node:fs';
import path from 'node:path';
export async function inspectExistingCredentialProfiles(appData:string){
  const available=await safeStorage.isAsyncEncryptionAvailable().catch(()=>false);
  const profiles:Record<string,{exists:boolean;decryption:'not_attempted'|'ok'|'failed'|'missing';openaiKeyPresent:boolean;bridgeTokenPresent:boolean}>={};
  for(const name of ['chat-on-steroids-next','chat-on-steroids']){
    const out:{exists:boolean;decryption:'not_attempted'|'ok'|'failed'|'missing';openaiKeyPresent:boolean;bridgeTokenPresent:boolean}={
      exists:false,decryption:'not_attempted',openaiKeyPresent:false,bridgeTokenPresent:false};
    try{
      const buf=await fs.readFile(path.join(appData,name,'secrets.bin'));
      out.exists=true;
      if(available){
        try{
          const contents=(await safeStorage.decryptStringAsync(buf)).result;
          const data:unknown=JSON.parse(contents);
          if(!data||typeof data!=='object'||Array.isArray(data))throw Error('INVALID_DATA');
          const record=data as Record<string,unknown>;
          out.openaiKeyPresent=typeof record.openaiApiKey==='string'&&record.openaiApiKey.length>0;
          out.bridgeTokenPresent=typeof record.bridgeToken==='string'&&record.bridgeToken.length>0;
          out.decryption='ok';
        }catch{out.decryption='failed';}
      }
    }catch{out.decryption='missing';}
    profiles[name]=out;
  }
  return {secureStorageAvailable:available,profiles};
}
