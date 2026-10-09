import {describe,it,expect} from 'vitest';
import {PageRecoveryGate,type SafePageProbe} from '../../src/main/next/web-first/page-recovery.js';
const empty:SafePageProbe={readyState:'complete',bodyElements:1,buttons:0,
  editorPresent:false,visibleElements:0,hasBody:true};
describe('Web-First blank page detection and bounded recovery',()=>{
  it('never retries an editor, login buttons or a still-loading page',()=>{
    const gate=new PageRecoveryGate();gate.navigate(100);
    for(const page of [{...empty,editorPresent:true},{...empty,buttons:1},
      {...empty,readyState:'loading'},{...empty,bodyElements:10}]){
      for(let i=0;i<5;i++)expect(gate.probe(page,16000+i*3000)).toEqual({issue:null,retry:false});
    }
  });
  it('detects sustained empty document and retries at most once per app process',()=>{
    const gate=new PageRecoveryGate();gate.navigate(1000);
    expect(gate.probe(empty,10000).issue).toBeNull();
    expect(gate.probe(empty,16000).issue).toBeNull();
    expect(gate.probe(empty,19000).issue).toBeNull();
    expect(gate.probe(empty,22000)).toMatchObject({retry:true,issue:{cause:'EMPTY_DOCUMENT'}});
    gate.navigate(23000);
    for(const now of [40000,43000,46000])gate.probe(empty,now);
    expect(gate.probe(empty,49000).retry).toBe(false);
  });
  it('shows a recoverable failure after repeated no-response renderer probes without blind reload',()=>{
    const gate=new PageRecoveryGate();gate.navigate(1000);
    for(const now of [29000,33000])expect(gate.probe(null,now)).toMatchObject({issue:null,retry:false});
    expect(gate.probe(null,37000)).toMatchObject({issue:{cause:'NO_PAGE_RESPONSE'},retry:false});
  });
  it('keeps sanitized HTTP, failed network and dead renderer diagnoses',()=>{
    const gate=new PageRecoveryGate();gate.navigate(1000);gate.httpStatus(403);
    for(const now of [16000,19000])gate.probe(empty,now);
    expect(gate.probe(empty,22000).issue?.cause).toBe('MAIN_FRAME_HTTP');
    expect(gate.fallbackMessage()?.detail).toContain('403');
    gate.navigate(25000);gate.renderFailure(-105);
    expect(gate.fallbackMessage()?.detail).toContain('-105');
    gate.navigate(30000);gate.rendererGone();
    expect(gate.fallbackMessage()?.title).toContain('渲染器');
  });
});
