import type { NextUiBridge, NextUiCatalog, NextUiStatus } from '../shared/next-ui.js';

declare global { interface Window { cosNext?: NextUiBridge } }
type Page = 'overview' | 'projects' | 'missions' | 'agents' | 'waits' | 'connections' | 'security';
const names: Record<Page, string> = {
  overview: '工作台总览', projects: '项目管理', missions: 'Mission 任务', agents: '多 Agent',
  waits: '等待与恢复', connections: '连接管理', security: '安全与权限'
};
const labels: Record<Page, [string, string]> = {
  overview: ['LOCAL WORKSPACE · OVERVIEW', '在一个本地工作台中查看项目、任务与连接状态。ChatGPT 仍是主要 AI 交互入口。'],
  projects: ['LOCAL WORKSPACE · PROJECTS', '按真实文件系统路径登记项目，各项目都由本地审批授权。'],
  missions: ['DURABLE KERNEL · MISSIONS', '查看持久化任务状态、Epoch、Revision 与机器验证的完成条件。'],
  agents: ['COORDINATION · AGENTS', '查看 Worker 生命周期和状态证据；远程自主推理尚未开放。'],
  waits: ['RECOVERY · EXTERNAL EVENTS', 'CI、进程与外部事件的核验、等待和续跑责任。'],
  connections: ['CONNECTIONS · TRANSPORT', '复用已导入的旧 CoS Core Tunnel，避免双实例竞争。'],
  security: ['TRUST · LOCAL POLICY', '受信本机操作和远程授权严格分离；未经核验的 ChatGPT 会话默认无权执行。']
};
const bridge = window.cosNext;
const byId = (id: string) => document.getElementById(id)!;
const escape = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g,
  ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
const icon = (name: string) => `<svg aria-hidden="true"><use href="#i-${name}"></use></svg>`;
let view: Page = 'overview';
let status: NextUiStatus | null = null;
let catalog: NextUiCatalog | null = null;
let busy = false;
let timer: number | undefined;
let toastTimer: number | undefined;
const stateClass = (x: string) =>
  ['READY', 'CONNECTED', 'FINISHED', 'RESOLVED', 'ACKED', 'SUCCESS'].includes(x) ? 'good' :
    /UNKNOWN|FAILED|HOLD|BLOCK|CANCELLED|AUTH|OWED/.test(x) ? 'attention' : 'blue';
const chip = (x: string) => `<span class="chip ${stateClass(x)}">${escape(x)}</span>`;
function flash(message: string, problem = false): void {
  const node = byId('notice');
  node.textContent = message;
  node.className = problem ? 'toast error' : 'toast';
  node.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { node.hidden = true; }, 6500);
}
function unavailable(text: string, type = 'lock'): string {
  return `<div class="empty"><span class="empty-icon">${icon(type)}</span><strong>${escape(text)}</strong><p>此处只展示已落盘、经过授权的真实状态，不会生成模拟任务或虚构执行结果。</p></div>`;
}
function requestCatalogCard(): string {
  return `<div class="notice-card">${icon('lock')}<div>项目、Mission 和 Agent 的目录受本机授权保护。点击「授权查看项目」，由 macOS 审批后才会显示。授权不会赋予 ChatGPT 远程操作权限。</div></div>
    <button class="btn btn-primary" data-action="catalog">${icon('lock')}授权查看项目</button>`;
}
const sections = {
  box: (label: string, title: string, id: string) =>
    `<div class="card section-card"><div class="card-heading"><span class="card-title">${icon(id)}${escape(title)}</span><span class="count-badge">${escape(label)}</span></div>`,
  end: '</div>'
};
function stat(label: string, value: string, sub: string, ico: string): string {
  return `<div class="card stat"><div class="stat-icon">${icon(ico)}</div><div class="stat-label">${escape(label)}</div>
    <div class="stat-value">${escape(value)}</div><div class="stat-bottom">${escape(sub)}</div></div>`;
}
function projectRows(items: NextUiCatalog['projects']): string {
  if (!items.length) return unavailable('还没有登记的项目', 'folder');
  return `<div class="list">${items.map(p => `<div class="item-row"><div class="item-left">
    <span class="item-icon">${icon('folder')}</span><div class="item-meta">
    <div class="item-name" title="${escape(p.canonicalRoot)}">${escape(p.canonicalRoot.split('/').filter(Boolean).at(-1) ?? p.projectId)}</div>
    <div class="item-desc" title="${escape(p.canonicalRoot)}">${escape(p.canonicalRoot)}</div></div></div>
    ${chip(catalog!.missions.filter(m => m.projectId === p.projectId).length + ' Missions')}</div>`).join('')}</div>`;
}
function missionRows(items: NextUiCatalog['missions']): string {
  if (!items.length) return unavailable('当前没有 Mission', 'list');
  return `<table class="table"><thead><tr><th>MISSION / 项目</th><th>状态</th><th>版本</th><th>完成条件</th></tr></thead>
  <tbody>${items.map(m => `<tr><td><div class="mono" title="${escape(m.missionId)}">${escape(m.missionId)}</div>
    <div class="secondary">${escape(catalog?.projects.find(p => p.projectId === m.projectId)?.canonicalRoot.split('/').at(-1) ?? m.projectId)}</div></td>
    <td>${chip(m.state)}</td><td class="mono">e${m.epoch} · r${m.revision}</td>
    <td>${escape(m.completionChecks.join(' / '))}</td></tr>`).join('')}</tbody></table>`;
}
function workerRows(items: NextUiCatalog['workers']): string {
  if (!items.length) return unavailable('还没有 Worker 记录', 'agents');
  return `<table class="table"><thead><tr><th>AGENT</th><th>MISSION</th><th>EPOCH</th><th>状态</th></tr></thead><tbody>${items.map(w =>
    `<tr><td class="mono">${escape(w.agentId)}</td><td class="mono">${escape(w.missionId)}</td>
    <td>${w.epoch}</td><td>${chip(w.state)}</td></tr>`).join('')}</tbody></table>`;
}
function waitRows(items: NextUiCatalog['obligations']): string {
  if (!items.length) return unavailable('当前没有外部等待事件', 'clock');
  return `<table class="table"><thead><tr><th>等待责任</th><th>事件</th><th>结果</th><th>续跑</th></tr></thead><tbody>${items.map(w =>
    `<tr><td><div class="mono">${escape(w.obligationId)}</div><div class="secondary">${escape(w.missionId)}</div></td>
    <td>${escape(w.kind)} · ${escape(w.state)}</td><td>${chip(w.outcome)}</td>
    <td>${chip(w.continuation)}</td></tr>`).join('')}</tbody></table>`;
}
function infoLine(a: string, b: string, badge = false): string {
  return `<div class="info-row"><span class="muted">${escape(a)}</span><span class="value">${badge ? chip(b) : escape(b)}</span></div>`;
}
function overview(): string {
  const p = catalog?.projects.length;
  const m = catalog?.missions.length;
  const a = catalog?.workers.length;
  const w = catalog?.obligations.filter(x => x.continuation === 'OWED').length;
  return `<div class="grid stats">
    ${stat('已登记项目', p === undefined ? '—' : String(p), '需本机审批才能查看', 'folder')}
    ${stat('持久化 Mission', m === undefined ? '—' : String(m), '恢复安全状态独立保存', 'list')}
    ${stat('Agent / Worker', a === undefined ? '—' : String(a), '多 Agent 任务账本', 'agents')}
    ${stat('待续跑事件', w === undefined ? '—' : String(w), '仅可验证回执才能确认', 'clock')}
  </div>
  <div class="grid feature-layout">
    ${sections.box('MISSION PIPELINE', '最近的任务', 'list')}
    ${catalog ? missionRows([...catalog.missions].reverse().slice(0, 5)) : requestCatalogCard()}
    ${sections.end}
    <div class="grid" style="gap:16px">
      ${sections.box('SYSTEM STATUS', '核心运行状态', 'pulse')}
      ${infoLine('本地 Runtime', status?.runtime ?? 'STARTING', true)}
      ${infoLine('持久化 Mission', status?.journal ?? 'NEW', true)}
      ${infoLine('Core Tunnel', status?.tunnel ?? 'DISCONNECTED', true)}
      ${infoLine('远程写入授权', 'DISABLED', true)}
      ${sections.end}
      ${sections.box('TRUST BOUNDARY', '默认安全策略', 'shield')}
      <div class="security-line">${icon('shield')}<div><strong>本地审批 · 默认拒绝</strong>
      <small>项目、Tunnel、Mission 创建均需本机批准；模型不会获得原始密钥或系统命令权限。</small></div></div>
      <div class="security-line">${icon('lock')}<div><strong>ChatGPT Web 不可伪造自动续跑</strong>
      <small>浏览器端继续等待真实宿主回合。独立 Codex 登录目前尚未启用。</small></div></div>
      ${sections.end}
    </div>
  </div>`;
}
function projects(): string {
  return `${sections.box('LOCAL PROJECTS', '项目目录', 'folder')}
    ${catalog ? projectRows(catalog.projects) : requestCatalogCard()}
    <div class="divider"></div><p class="section-sub">新增项目将校验真实路径和目录身份，并写入 Next 专属持久化账本。项目不会自动授予 Agent 命令执行权限。</p>
    <div class="action-line"><button class="btn btn-primary" data-action="choose-project">${icon('plus')}选择文件夹并登记</button>
    <button class="btn btn-quiet" data-action="catalog">${icon('refresh')}授权刷新目录</button></div>
    ${sections.end}`;
}
function missions(): string {
  const opts = catalog?.projects ?? [];
  const select = opts.length ? `<div class="field"><label for="project-select">选择已授权项目</label>
    <select id="project-select">${opts.map(p => `<option value="${escape(p.projectId)}">${escape(p.canonicalRoot.split('/').at(-1) ?? p.projectId)}</option>`).join('')}</select></div>`
    : '<p class="muted-sm">需要先完成项目目录授权，才能创建 Mission。</p>';
  return `${sections.box('DURABLE MISSIONS', '任务列表', 'list')}
    ${catalog ? missionRows(catalog.missions) : requestCatalogCard()}${sections.end}
    <div style="height:16px"></div>${sections.box('NEW MISSION', '创建新的持久化任务', 'plus')}
    <p class="section-sub">参考旧 CoS 的 Goal / Project 工作流，任务创建后永久记录 Epoch 与验收条件，但不会自动启动模型。</p>
    ${select}
    <div class="field"><label for="check-select">完成条件模板</label><select id="check-select">
      <option value="build,tests,review">本地构建 + 测试 + 审核</option>
      <option value="ci,ledger,review">CI + Evidence Ledger + 审核</option>
      <option value="artifact,review">产物交付 + 审核</option></select></div>
    <button class="btn btn-primary" data-action="create-mission" ${opts.length ? '' : 'disabled'}>${icon('plus')}批准并创建 Mission</button>
    ${sections.end}`;
}
function agents(): string {
  return `<div class="notice-card warning">${icon('lock')}<div><strong>多 Agent 内核已建立，远程自主执行尚未开放。</strong>
    Worker 队列、领取、回执、并发与撤权由持久化 Mission 内核管理。需要完成真实 ChatGPT 身份绑定和 Codex 订阅授权后，才能安全地启动独立模型回合。</div></div>
    ${sections.box('WORKER LEDGER', '已记录的 Agent / Worker', 'agents')}
    ${catalog ? workerRows(catalog.workers) : requestCatalogCard()}
    ${sections.end}
    <div style="height:16px"></div>${sections.box('EXECUTION DESIGN', '多 Agent 协同流程', 'grid')}
    <div class="flow-steps"><span class="flow-node">Mission 排队</span><span class="flow-arrow">→</span><span class="flow-node">受信 Worker 领取</span>
    <span class="flow-arrow">→</span><span class="flow-node">模型 / 工具核验</span><span class="flow-arrow">→</span><span class="flow-node">证据回写</span></div>
    <p class="section-sub" style="margin-bottom:0;margin-top:16px">不会因代理自称完成而关闭任务，Stop/Pause 会使旧 Epoch 失效。</p>${sections.end}`;
}
function waits(): string {
  return `${sections.box('EVENT JOURNAL', '外部等待与续跑责任', 'clock')}
    ${catalog ? waitRows(catalog.obligations) : requestCatalogCard()}${sections.end}
    <div style="height:16px"></div><div class="notice-card">${icon('info')}<div>
    <strong>续跑遵循真实事件证据。</strong> GitHub CI / 进程完成后，账本先写入 <code>CONTINUATION_OWED</code>。
    只有真正的受信宿主／模型回合发生，才记录 ACK。MCP 服务无法凭空触发 ChatGPT 网页继续对话。</div></div>`;
}
function connections(): string {
  const connected = status?.tunnel === 'CONNECTED';
  return `<div class="grid feature-layout">
    ${sections.box('OPENAI MCP TRANSPORT', '原 Core Tunnel', 'link')}
    <div class="mini-grid">
      <div class="mini-tile"><div class="label">连接状态</div><div class="value">${connected ? '● 已连接' : escape(status?.tunnel ?? 'DISCONNECTED')}</div></div>
      <div class="mini-tile"><div class="label">认证来源</div><div class="value">旧 CoS 安全迁移</div></div>
    </div>
    <p class="section-sub" style="margin-top:17px">使用之前已迁入 macOS 钥匙串的凭据和旧 Core Tunnel ID。旧 CoS 必须关闭，避免双实例抢占同一 Tunnel。</p>
    <div class="action-line">
      <button class="btn btn-primary" data-action="connect-core" ${connected || status?.runtime !== 'READY' ? 'disabled' : ''}>${icon('link')}连接 Core Tunnel</button>
      <button class="btn btn-danger" data-action="disconnect-core" ${connected ? '' : 'disabled'}>断开连接</button>
    </div>${sections.end}
    ${sections.box('CAPABILITIES', '当前远端开放范围', 'shield')}
    ${infoLine('Runtime Health', 'READ ONLY', true)}
    ${infoLine('Identity Diagnostics', 'READ ONLY', true)}
    ${infoLine('Mission / Stop / Agent', 'DISABLED', true)}
    ${infoLine('可计费 API', 'DISABLED', true)}
    ${sections.end}</div>
    <div class="notice-card">${icon('info')}<div>成功连接 Tunnel 只证明传输认证，不证明能确定具体 ChatGPT 对话身份。Next 不会把工具参数中的 <code>openai/session</code> 当成授权。</div></div>`;
}
function security(): string {
  return `<div class="grid feature-layout">
    ${sections.box('RUNTIME POLICY', '隔离与权限', 'shield')}
    <div class="security-line">${icon('shield')}<div><strong>独立用户数据目录</strong>
    <small>旧 CoS 原始数据保持完整；Next 拥有独立 writer 锁、Mission、凭据和元数据。</small></div></div>
    <div class="security-line">${icon('shield')}<div><strong>原生批准票据</strong>
    <small>审批由 Mac 主进程签发，一次性使用，并按操作及 Project / Mission 绑定。</small></div></div>
    <div class="security-line">${icon('shield')}<div><strong>远程执行默认拒绝</strong>
    <small>Chrome 插件不是本地内核运行的前置条件；真实对话归属仍须单独验证。</small></div></div>
    ${sections.end}
    ${sections.box('SECURITY GATES', '生产验收状态', 'lock')}
    ${infoLine('本机持久化', status?.journal ?? 'NEW', true)}
    ${infoLine('macOS 安全存储', status?.keychain ?? 'UNAVAILABLE', true)}
    ${infoLine('真实 ChatGPT 身份绑定', 'PENDING', true)}
    ${infoLine('订阅授权 Codex 推理', 'DISABLED', true)}
    ${infoLine('Chrome Companion 依赖', 'NOT REQUIRED', true)}
    ${sections.end}</div>`;
}
function render(): void {
  byId('page-title').textContent = names[view];
  byId('crumb-current').textContent = names[view];
  byId('page-eyebrow').textContent = labels[view][0];
  byId('page-description').textContent = labels[view][1];
  document.querySelectorAll<HTMLButtonElement>('.nav-item').forEach(button => {
    button.classList.toggle('active', button.dataset.view === view);
    if (button.dataset.view === view) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  const heading = byId('heading-actions');
  heading.innerHTML = view === 'overview' || view === 'projects'
    ? `<button class="btn btn-quiet" data-action="reload">${icon('refresh')}刷新状态</button>
       <button class="btn btn-primary" data-action="choose-project">${icon('plus')}添加项目</button>`
    : `<button class="btn btn-quiet" data-action="reload">${icon('refresh')}刷新状态</button>`;
  byId('content').innerHTML =
    ({ overview, projects, missions, agents, waits, connections, security }[view])();
  if (status) updateShell();
}
function updateShell(): void {
  if (!status) return;
  const ok = status.runtime === 'READY';
  const connected = status.tunnel === 'CONNECTED';
  byId('sidebar-runtime').textContent = status.runtime + ' · ' + status.journal;
  byId('footer-state').textContent = 'Runtime ' + status.runtime + ' · Tunnel ' + status.tunnel;
  for (const id of ['sidebar-led', 'footer-led']) byId(id).className =
    'tiny-led ' + (ok ? 'ok' : status.runtime === 'HOLD' ? 'bad' : 'warn');
  byId('top-tunnel').innerHTML = '<span class="tiny-led ' + (connected ? 'ok' : '') + '"></span>' +
    (connected ? 'Core Tunnel 已连接' : 'Tunnel 已断开');
}
async function refreshStatus(redraw = true): Promise<void> {
  if (!bridge) return;
  try {
    const latest = await bridge.status();
    const changed = status?.runtime !== latest.runtime || status?.tunnel !== latest.tunnel ||
      status?.journal !== latest.journal;
    status = latest;
    updateShell();
    if (changed && redraw) render();
  } catch { flash('未能连接本地 Next Runtime。请检查应用状态。', true); }
}
async function requestCatalog(): Promise<void> {
  if (!bridge) return;
  const answer = await bridge.catalog();
  if (answer) { catalog = answer; render(); flash('本机审批已完成，项目与任务目录已更新。'); }
  else flash('未授权访问项目目录。原有数据保持不变。', true);
}
async function act(action: string): Promise<void> {
  if (!bridge || busy) return;
  busy = true;
  document.querySelectorAll<HTMLButtonElement>('button[data-action]').forEach(b => { b.disabled = true; });
  try {
    switch (action) {
      case 'reload': await refreshStatus(); flash('状态已更新。目录信息需要另行审批刷新。'); break;
      case 'catalog': await requestCatalog(); break;
      case 'choose-project': {
        const outcome = await bridge.chooseProject();
        flash(outcome.ok ? '项目已登记。可授权刷新目录查看。' :
          (outcome.reason ?? '操作已取消或未获批准。'), !outcome.ok);
        if (outcome.ok) catalog = null;
        break;
      }
      case 'create-mission': {
        const projectId = (document.getElementById('project-select') as HTMLSelectElement | null)?.value;
        const checks = (document.getElementById('check-select') as HTMLSelectElement | null)?.value.split(',');
        if (!projectId || !checks?.length) { flash('请选择项目和完成条件。', true); break; }
        const outcome = await bridge.createMission(projectId, checks);
        flash(outcome.ok ? 'Mission 已保存到本地账本。请授权刷新查看。' :
          (outcome.reason ?? '审批未通过。'), !outcome.ok);
        if (outcome.ok) catalog = null;
        break;
      }
      case 'connect-core': {
        const outcome = await bridge.connectCore();
        flash(outcome.ok ? 'Core Tunnel 已连接（只读诊断）。' :
          (outcome.reason ?? '连接失败或未获审批。'), !outcome.ok);
        await refreshStatus();
        break;
      }
      case 'disconnect-core': {
        const outcome = await bridge.disconnectCore();
        flash(outcome.ok ? 'Tunnel 已安全断开。' :
          (outcome.reason ?? 'Tunnel 断开状态未核实。'), !outcome.ok);
        await refreshStatus();
        break;
      }
      default: break;
    }
  } catch { flash('操作未完成。请查看本机安全状态并重试。', true); }
  finally { busy = false; render(); }
}
function attach(): void {
  document.addEventListener('click', event => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const nav = target.closest<HTMLButtonElement>('[data-view]');
    if (nav && nav.dataset.view && nav.dataset.view in names) {
      view = nav.dataset.view as Page; render(); return;
    }
    const action = target.closest<HTMLButtonElement>('[data-action]');
    if (action?.dataset.action) void act(action.dataset.action);
  });
  byId('refresh').addEventListener('click', () => { void act('reload'); });
}
async function boot(): Promise<void> {
  if (!bridge) { flash('Next 安全桥接未加载。所有写操作均已禁用。', true); render(); return; }
  attach(); render();
  await refreshStatus();
  timer = window.setInterval(() => { if (!busy) void refreshStatus(); }, 4000);
  window.addEventListener('beforeunload', () => { if (timer) window.clearInterval(timer); });
}
void boot();
