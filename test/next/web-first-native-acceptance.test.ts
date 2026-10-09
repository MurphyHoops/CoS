import {describe,expect,it} from 'vitest';
import {summarizeNativeAcceptance} from '../../src/main/next/web-first/native-acceptance.js';
describe('native factual acceptance reporting',()=>{
  it('separately reports local health and unresolved provider/tool publication',()=>{
    const report=summarizeNativeAcceptance([
      {name:'MCP 本机工具列表',state:'PASS',detail:'13 tools were found in local loopback'},
      {name:'ChatGPT 工具发布',state:'HOLD',detail:'未验证远端与本机一致'},
      {name:'AI Worker',state:'HOLD',detail:'未授权真实模型调度'},
      {name:'Goal 记录',state:'FAIL',detail:'本机存储损坏'}
    ]);
    expect(report).toMatchObject({pass:1,hold:2,fail:1});
    expect(report.detail).toContain('工具发布');
    expect(report.detail).toContain('本机自检不会调用模型');
    expect(report.headline).not.toContain('全部功能通过');
  });
  it('rejects unsafe record data and empty sets',()=>{
    expect(()=>summarizeNativeAcceptance([])).toThrow('NATIVE_AUDIT_ROWS_INVALID');
    expect(()=>summarizeNativeAcceptance([{name:'s',state:'PASS',detail:'secret\nvalue'}])).toThrow('NATIVE_AUDIT_ROW_INVALID');
    expect(()=>summarizeNativeAcceptance([{name:'s',state:'DENIED' as 'PASS',detail:'value'}])).toThrow('NATIVE_AUDIT_ROW_INVALID');
  });
});
