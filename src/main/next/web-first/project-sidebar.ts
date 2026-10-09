/** Strictly static native sidecar HTML, NOT a ChatGPT web content script. */
import type {WebFirstProject} from './project-registry.js';
import {PROJECT_SIDEBAR_CSS} from './project-sidebar-style.js';
export function escapeSidebarText(value:string):string {
  return value.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
export function renderProjectSidebar(projects:ReadonlyArray<WebFirstProject>,status:'UNCONNECTED'|'LOCAL_ONLY'|'REMOTE_CONNECTING'|'REMOTE_CONNECTED'|'HOLD',registryError=false,grantSummary?:{permanent:number;session:number;error:boolean},
  goalSummary?:{total:number;active:number;waiting:number;error:boolean}):string {
  const cards=projects.map(p=>
    `<article class="block project"><span class="name">${escapeSidebarText(p.name)}</span><div class="root" title="${escapeSidebarText(p.root)}">${escapeSidebarText(p.root)}</div><small>● 本地登记 · 权限单独审批</small></article>`).join('');
  const connected=status==='REMOTE_CONNECTED';
  const held=registryError||status==='HOLD';
  const statusText=registryError?'项目登记文件异常 · 操作暂停':status==='HOLD'?'Core Tunnel 连接受阻 · 项目登记仍正常':
    status==='LOCAL_ONLY'?'本地 MCP 已启动 · ChatGPT 插件未连接':connected?'Core 已握手 · ChatGPT 发布列表需单独核对':
    status==='REMOTE_CONNECTING'?'正在验证 Core 握手':'尚未连接／未授权';
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; connect-src 'none'; img-src 'none'">
  <style>${PROJECT_SIDEBAR_CSS}</style><body>
  <header><div class="brand">COS NEXT / WEB-FIRST</div><h2>本地工作区</h2><p class="minor">项目、目标与受控连接</p></header>
  <main class="shell"><section class="group"><h3>PROJECTS · 项目目录 · ${projects.length}</h3>
    ${cards||'<div class="empty">尚未登记本地项目<br>使用「本地项目 → 添加项目目录」开始</div>'}</section>
  <section class="group"><h3>GOALS · 目标工作台</h3><div class="block goal-box">
    <div class="goal-title"><strong>Goal / 分步计划</strong><span class="goal-count">${goalSummary?.error?'!':goalSummary?.total??0}</span></div>
    ${goalSummary?.error?'<p class="muted" style="margin-top:9px">任务记录需要检查 · 不执行任何任务</p>':
      `<div class="facts"><div class="stat"><div class="n">${goalSummary?.active??0}</div><div class="label">进行中</div></div>
      <div class="stat"><div class="n">${goalSummary?.waiting??0}</div><div class="label">等待 / 恢复</div></div></div>`}
    <p class="hint">从顶部「本地项目 → Goal / 计划工作台」创建、编辑或恢复。<strong>计划并非自动执行授权。</strong></p>
  </div></section>
  <section class="group"><h3>CONNECTION · 核心连接</h3><div class="block"><div class="status ${connected?'connected':held?'hold':''}">
    <span class="dot"></span><strong>${held?'需要检查':connected?'Core 已连接':status==='REMOTE_CONNECTING'?'连接中':'本地 / 未连接'}</strong></div>
    <p class="hint" style="margin-top:9px">${statusText}</p><p class="hint details">网页会话不自动获得文件、终端或项目编辑权限。</p>
  </div></section>
  <section class="group"><h3>ACCESS · 只读授权</h3><div class="block">
    ${grantSummary?.error?'<p class="hint">授权记录异常 · 自动放行已禁用</p>':
      `<span class="pill">永久 ${grantSummary?.permanent??0} 项 · 本次运行 ${grantSummary?.session??0} 项</span>`}
    <p class="hint" style="margin-top:9px">批准范围内减少重复弹窗，敏感文件仍需单次确认；可从本地项目菜单撤销。</p>
  </div></section>
  <div class="bottom"><p class="muted">目录登记不会上传文件或自动启动模型任务。</p>
    <p class="muted" style="margin-top:7px">所有设置、目标和授权均由原生应用管理。</p></div></main></body></html>`;
}
