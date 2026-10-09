import {describe,expect,it} from 'vitest';
import {createHostSessionDiagnostic} from '../../src/main/next/web-first/host-session-diagnostic.js';
describe('G1b host session diagnostics never authorize model or mission',()=>{
  const key=Buffer.alloc(32,0x42);
  it('correlates same chat, separates chats, keeps same subject, never emits raw ID',()=>{
    const probe=createHostSessionDiagnostic(key);
    const a=probe({'openai/session':'conversation-A','openai/subject':'user-one'});
    const again=probe({'openai/session':'conversation-A','openai/subject':'user-one'});
    const b=probe({'openai/session':'conversation-B','openai/subject':'user-one'});
    expect(a.session_fingerprint).toBe(again.session_fingerprint);
    expect(b.session_fingerprint).not.toBe(a.session_fingerprint);
    expect(b.subject_fingerprint).toBe(a.subject_fingerprint);
    expect(JSON.stringify(a)).not.toContain('conversation-A');
    expect(JSON.stringify(a)).not.toContain('user-one');
    expect(a).toMatchObject({identity_verified:false,mission_authorized:false,
      authority:'UNVERIFIED',session_field:'PRESENT'});
  });
  it('fails closed for absent, malformed, oversized and control character input',()=>{
    const probe=createHostSessionDiagnostic(key);
    for(const meta of [undefined,null,{},[],{'openai/session':123},
      {'openai/session':'x'.repeat(257)},{'openai/session':'bad\nid'},
      {'openai/session':{toString:()=>{throw Error('GETTER');}}}]){
      const r=probe(meta);
      expect(r.session_present).toBe(false);
      expect(r.session_fingerprint).toBeNull();
      expect(r.identity_verified).toBe(false);
    }
  });
  it('fingerprints change with the diagnostic process secret, so do not form durable leases',()=>{
    const a=createHostSessionDiagnostic(Buffer.alloc(32,1))({'openai/session':'s'});
    const b=createHostSessionDiagnostic(Buffer.alloc(32,2))({'openai/session':'s'});
    expect(a.session_fingerprint).not.toBe(b.session_fingerprint);
  });
});
