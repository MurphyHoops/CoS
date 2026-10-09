/** Display-only native WebContentsView. No navigation or privileges. */
export function renderWorkspaceHeader(status:'UNCONNECTED'|'LOCAL_ONLY'|'REMOTE_CONNECTING'|'REMOTE_CONNECTED'|'HOLD'){
  const label=status==='REMOTE_CONNECTED'?'Core 握手已建立 · 工具发布待核验':
    status==='REMOTE_CONNECTING'?'Core 握手验证中':status==='LOCAL_ONLY'?'本机工具就绪 · 未连接 ChatGPT':
    status==='HOLD'?'Core 连接需检查':'Core 尚未连接';
  const dot=status==='REMOTE_CONNECTED'?'good':status==='HOLD'?'warn':'';
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; img-src 'none'; connect-src 'none'; form-action 'none'">
  <style>*{box-sizing:border-box}body{margin:0;height:48px;padding:0 16px;background:linear-gradient(90deg,#101e30,#182c46);border-bottom:1px solid #334863;color:#e4edff;display:flex;align-items:center;justify-content:space-between;gap:12px;font:12px system-ui,-apple-system,sans-serif}.left,.right{display:flex;align-items:center;gap:10px}.mark{border-radius:9px;background:#3565ad;padding:6px 7px;font-weight:800;font-size:11px}.brand{font-weight:800;letter-spacing:-.02em;font-size:13px}.subtitle{padding-left:10px;border-left:1px solid #496078;color:#a7bbd4;font-size:11px}.status{white-space:nowrap;color:#bbcee7;font-size:11px}.dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:#9daec7;margin-right:7px}.good .dot{background:#69d5b1}.warn .dot{background:#e9b27a}.key{white-space:nowrap;color:#bfdaff;background:#213855;border:1px solid #49617f;padding:5px 8px;border-radius:7px;font-size:11px}@media(max-width:890px){.subtitle,.key{display:none}}@media(max-width:590px){.status{display:none}}</style>
  <body><div class="left"><span class="mark">CoS</span><span class="brand">Next</span><span class="subtitle">ChatGPT Web-First · 本地工作区</span></div><div class="right"><span class="status ${dot}"><span class="dot"></span>${label}</span><span class="key">⌘ ⇧ G · 打开目标</span></div></body></html>`;
}
