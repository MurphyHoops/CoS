/** Native, nonsecret acceptance summary. PASS is never inferred from a simulated
 * browser event or from local tools/list when verifying ChatGPT publication. */
export type AcceptanceState='PASS'|'HOLD'|'FAIL';
export type AcceptanceRow={name:string;state:AcceptanceState;detail:string};
export type AcceptanceOutput={pass:number;hold:number;fail:number;headline:string;detail:string};
export function summarizeNativeAcceptance(rows:ReadonlyArray<AcceptanceRow>):AcceptanceOutput{
  if(!rows.length||rows.length>24)throw Error('NATIVE_AUDIT_ROWS_INVALID');
  const permitted=['PASS','HOLD','FAIL'];
  for(const row of rows){
    if(!row||!row.name||row.name.length>80||!permitted.includes(row.state)||
      !row.detail||row.detail.length>500||/[\r\n\u0000-\u001f]/.test(row.name+row.detail))
      throw Error('NATIVE_AUDIT_ROW_INVALID');
  }
  const pass=rows.filter(x=>x.state==='PASS').length;
  const hold=rows.filter(x=>x.state==='HOLD').length;
  const fail=rows.filter(x=>x.state==='FAIL').length;
  const headline=`本机自检：${pass} 项通过 · ${hold} 项待完善 · ${fail} 项异常`;
  const detail=rows.map((r,i)=>`${i+1}. [${r.state}] ${r.name}：${r.detail}`).join('\n')+
    '\n\n注意：本机自检不会调用模型或获得任何新权限。Core 本地响应、Tunnel 握手与 ChatGPT 工具发布分别核验。'+
    '未获身份验证的操作仍须原生批准，真实 AI Worker 自动执行未开启。';
  return {pass,hold,fail,headline,detail};
}
