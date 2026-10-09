/** G1b only: anonymous host metadata correlation, NEVER principal authorization.
 * The HMAC key lives in this process only; raw host IDs must not be logged.
 */
import {createHmac,randomBytes} from 'node:crypto';
type HostEvidence={session_present:boolean;session_fingerprint:string|null;
  subject_present:boolean;subject_fingerprint:string|null;
  session_field:'PRESENT'|'MISSING'|'INVALID';
  subject_field:'PRESENT'|'MISSING'|'INVALID';
  fingerprint_scope:'current_mcp_server_process_only';
  identity_verified:false;mission_authorized:false;authority:'UNVERIFIED'};
function inspect(value:unknown):{status:'PRESENT'|'MISSING'|'INVALID';id:string|null}{
  if(value===undefined||value===null)return {status:'MISSING',id:null};
  if(typeof value!=='string'||value.length<1||value.length>256||
    /[\u0000-\u001f\u007f]/.test(value))return {status:'INVALID',id:null};
  return {status:'PRESENT',id:value};
}
export function createHostSessionDiagnostic(secret:Buffer=randomBytes(32)){
  if(!Buffer.isBuffer(secret)||secret.length<16)throw Error('HOST_DIAGNOSTIC_KEY_INVALID');
  const stamp=(scope:string,id:string)=>createHmac('sha256',secret)
    .update(scope).update('\0').update(id).digest('hex').slice(0,24);
  return (meta:unknown):HostEvidence=>{
    const values=meta&&typeof meta==='object'&&!Array.isArray(meta)?
      meta as Record<string,unknown>:{};
    const session=inspect(values['openai/session']);
    const subject=inspect(values['openai/subject']);
    return {
      session_present:session.id!==null,
      session_fingerprint:session.id?stamp('session',session.id):null,
      subject_present:subject.id!==null,
      subject_fingerprint:subject.id?stamp('subject',subject.id):null,
      session_field:session.status,subject_field:subject.status,
      fingerprint_scope:'current_mcp_server_process_only',
      identity_verified:false,mission_authorized:false,authority:'UNVERIFIED'
    };
  };
}
