/** Strictly static native sidecar HTML, NOT a ChatGPT web content script. */
import type {WebFirstProject} from './project-registry.js';
export function escapeSidebarText(value:string):string {
  return value.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
export function renderProjectSidebar(projects:ReadonlyArray<WebFirstProject>,status:'UNCONNECTED'|'LOCAL_ONLY'|'REMOTE_CONNECTING'|'REMOTE_CONNECTED'|'HOLD',registryError=false):string {
  const cards=projects.map(p=>
    `<article><strong>${escapeSidebarText(p.name)}</strong><div class="root" title="${escapeSidebarText(p.root)}">${escapeSidebarText(p.root)}</div><small>仅本地登记 · 未授予 AI 权限</small></article>`).join('');
  return `<!doctype html><html lang="zh"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
  <style>*{box-sizing:border-box}body{margin:0;background:#111923;color:#e5edf6;font:13px -apple-system,BlinkMacSystemFont,system-ui,sans-serif}header{padding:20px 16px;border-bottom:1px solid #334151}h2{font-size:15px;margin:0 0 4px}.minor{color:#94a3b8;font-size:11px}section{padding:13px 13px 17px}h3{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:#a5b4c6;margin:10px 0}article{margin:9px 0;border:1px solid #344456;border-radius:9px;padding:12px;background:#192534}strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.root{color:#9fb2c9;word-break:break-all;font-size:10px;line-height:1.5;margin:5px 0 8px}small{color:#c0cad5;font-size:10px}aside{padding:12px;background:#172338;border-left:3px solid #e0ae66;border-radius:5px;line-height:1.6;color:#e4d4ac}.empty{border:1px dashed #45576c;border-radius:9px;color:#a9b6c9;padding:15px;line-height:1.6}.tip{margin-top:14px;color:#9cacc0;font-size:11px;line-height:1.8}</style>
  <header><h2>本地项目</h2><div class="minor">Web-First · 原生工作区</div></header>
  <section><h3>项目目录 · ${projects.length}</h3>${cards||'<div class="empty">尚未登记本地项目<br>请使用菜单「本地项目 → 添加项目目录」</div>'}
  <h3>Core MCP</h3><aside>${registryError?'项目登记文件异常 · 操作暂停':status==='HOLD'?'Core Tunnel 连接受阻 · 项目登记仍正常':status==='LOCAL_ONLY'?'本地 MCP 已启动 · ChatGPT 插件未连接':status==='REMOTE_CONNECTED'?'Core 已握手 · 服务器有 5 个只读工具，ChatGPT 工具发布待确认。读取仍需逐次批准':status==='REMOTE_CONNECTING'?'正在验证 Core 握手':'尚未连接／未授权'}<br><span class="minor">网页对话不会自动获得项目、文件或终端权限。</span></aside>
  <div class="tip">添加目录只保存一个本地书签，不上传文件、不启动任务、不消耗 Codex/API 模型额度。<br><br>管理入口：顶部菜单「本地项目」。</div></section></html>`;
}
