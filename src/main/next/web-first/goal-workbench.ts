/**
 * Pure JavaScript-free local-native Goal UI. HTML forms are intercepted
 * BEFORE navigation by WebContents will-navigate. No renderer IPC, preload,
 * remote URLs, browser storage, ChatGPT page access or model inference.
 */
import type {WebFirstProject} from './project-registry.js';
import type {DurableTask} from './task-ledger.js';
import type {TaskPlan,PlanStep} from './plan-ledger.js';
import {GOAL_WORKBENCH_CSS} from './goal-workbench-style.js';
import type {LocalCheckJob,LocalCheckKind} from './local-job-queue.js';
import type {AiWorkerAssignment} from './agent-roster.js';
const escape=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;',
  '>':'&gt;','"':'&quot;',"'":'&#39;'}[c]??''));
export const GOAL_FORM_ORIGIN='cos-next-goal://native/';
export type GoalWorkbenchAction= {kind:'create';projectId:string;goal:string;lines:string}|
  {kind:'update-plan';taskId:string;revision:number;lines:string}|
  {kind:'advance';taskId:string;taskRevision:number;planRevision:number;at:number}|
  {kind:'local-check';taskId:string;taskRevision:number;planRevision:number;check:LocalCheckKind}|
  {kind:'worker-team';taskId:string;taskRevision:number;planRevision:number;slots:2|3|4}|
  {kind:'ai-workers';taskId:string;taskRevision:number;planRevision:number;count:1|2|3|4}|
  {kind:'ai-worker-remove';taskId:string;taskRevision:number;workerId:string}|
  {kind:'decision';taskId:string;revision:number;decision:'pause'|'resume'|'cancel'|'complete'}|
  {kind:'refresh'};
/** No user string is allowed to be treated as a navigable URL. */
export function parseWorkbenchAction(raw:string):GoalWorkbenchAction{
  const u=new URL(raw);
  if(u.protocol!=='cos-next-goal:'||u.hostname!=='native'||
    u.username||u.password||u.port||u.hash)throw Error('GOAL_NAVIGATION_DENIED');
  const one=(name:string,limit:number)=>{
    const values=u.searchParams.getAll(name);
    if(values.length!==1||values[0]!.length>limit)throw Error('GOAL_FORM_INVALID');
    return values[0]!;
  };
  const noExtra=(allowed:string[])=>{
    if([...u.searchParams.keys()].some(k=>!allowed.includes(k)))throw Error('GOAL_FORM_INVALID');
  };
  if(u.pathname==='/refresh'){noExtra([]);return {kind:'refresh'};}
  if(u.pathname==='/create'){
    noExtra(['project_id','goal','steps']);
    const projectId=one('project_id',90),goal=one('goal',2000),lines=one('steps',12000);
    if(!projectId||!goal.trim())throw Error('GOAL_FORM_INVALID');
    return {kind:'create',projectId,goal,lines};
  }
  if(u.pathname==='/plan'){
    noExtra(['task_id','revision','steps']);
    const taskId=one('task_id',36),revision=Number(one('revision',10));
    if(!/^[a-f0-9-]{36}$/i.test(taskId)||!Number.isInteger(revision)||revision<0)
      throw Error('GOAL_FORM_INVALID');
    return {kind:'update-plan',taskId,revision,lines:one('steps',12000)};
  }
  if(u.pathname==='/advance'){
    noExtra(['task_id','task_revision','plan_revision','at']);
    const taskId=one('task_id',36);
    const taskRevisionRaw=one('task_revision',10);
    const planRevisionRaw=one('plan_revision',10);
    const atRaw=one('at',2);
    if(!/^[1-9][0-9]*$/.test(taskRevisionRaw)||!/^[1-9][0-9]*$/.test(planRevisionRaw)||
      !/^(?:[0-9]|1[01])$/.test(atRaw))throw Error('GOAL_FORM_INVALID');
    const taskRevision=Number(taskRevisionRaw),planRevision=Number(planRevisionRaw),at=Number(atRaw);
    if(!/^[a-f0-9-]{36}$/i.test(taskId)||
      !Number.isSafeInteger(taskRevision)||taskRevision<1||
      !Number.isSafeInteger(planRevision)||planRevision<1||
      !Number.isSafeInteger(at)||at<0||at>=12)throw Error('GOAL_FORM_INVALID');
    return {kind:'advance',taskId,taskRevision,planRevision,at};
  }
  if(u.pathname==='/local-check'){
    noExtra(['task_id','task_revision','plan_revision','check']);
    const taskId=one('task_id',36),taskRev=one('task_revision',10),planRev=one('plan_revision',10);
    const check=one('check',24);
    if(!/^[a-f0-9-]{36}$/i.test(taskId)||!/^[1-9][0-9]*$/.test(taskRev)||
      !/^(?:0|[1-9][0-9]*)$/.test(planRev)||
      !['root-check','git-status'].includes(check)||
      !Number.isSafeInteger(Number(taskRev))||!Number.isSafeInteger(Number(planRev)))
      throw Error('GOAL_FORM_INVALID');
    return {kind:'local-check',taskId,taskRevision:Number(taskRev),
      planRevision:Number(planRev),check:check as LocalCheckKind};
  }
  if(u.pathname==='/worker-team'){
    noExtra(['task_id','task_revision','plan_revision','slots']);
    const taskId=one('task_id',36),taskRev=one('task_revision',10);
    const planRev=one('plan_revision',10),slots=one('slots',1);
    if(!/^[a-f0-9-]{36}$/i.test(taskId)||!/^[1-9][0-9]*$/.test(taskRev)||
      !/^(?:0|[1-9][0-9]*)$/.test(planRev)||!['2','3','4'].includes(slots)||
      !Number.isSafeInteger(Number(taskRev))||!Number.isSafeInteger(Number(planRev)))
      throw Error('GOAL_FORM_INVALID');
    return {kind:'worker-team',taskId,taskRevision:Number(taskRev),
      planRevision:Number(planRev),slots:Number(slots) as 2|3|4};
  }
  if(u.pathname==='/ai-workers'){
    noExtra(['task_id','task_revision','plan_revision','count']);
    const taskId=one('task_id',36),rev=one('task_revision',10);
    const plan=one('plan_revision',10),count=one('count',1);
    if(!/^[a-f0-9-]{36}$/i.test(taskId)||!/^[1-9][0-9]*$/.test(rev)||
      !/^(?:0|[1-9][0-9]*)$/.test(plan)||!['1','2','3','4'].includes(count)||
      !Number.isSafeInteger(Number(rev))||!Number.isSafeInteger(Number(plan)))
      throw Error('GOAL_FORM_INVALID');
    return {kind:'ai-workers',taskId,taskRevision:Number(rev),
      planRevision:Number(plan),count:Number(count) as 1|2|3|4};
  }
  if(u.pathname==='/ai-worker-remove'){
    noExtra(['task_id','task_revision','worker_id']);
    const taskId=one('task_id',36),rev=one('task_revision',10),workerId=one('worker_id',36);
    if(!/^[a-f0-9-]{36}$/i.test(taskId)||!/^[a-f0-9-]{36}$/i.test(workerId)||
      !/^[1-9][0-9]*$/.test(rev)||!Number.isSafeInteger(Number(rev)))
      throw Error('GOAL_FORM_INVALID');
    return {kind:'ai-worker-remove',taskId,taskRevision:Number(rev),workerId};
  }
  if(u.pathname==='/decision'){
    noExtra(['task_id','revision','decision']);
    const taskId=one('task_id',36),revision=Number(one('revision',10)),decision=one('decision',16);
    if(!/^[a-f0-9-]{36}$/i.test(taskId)||!Number.isInteger(revision)||revision<1||
      !['pause','resume','cancel','complete'].includes(decision))throw Error('GOAL_FORM_INVALID');
    return {kind:'decision',taskId,revision,decision:decision as 'pause'|'resume'|'cancel'|'complete'};
  }
  throw Error('GOAL_NAVIGATION_DENIED');
}
export function parsePlanLines(raw:string):PlanStep[]{
  const lines=raw.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  if(lines.length>12)throw Error('PLAN_STEPS_INVALID');
  let inProgress=0;
  const result=lines.map(line=>{
    const m=/^\[( |>|x)\]\s+(.+)$/i.exec(line);
    const status:mappedStatus=m?(m[1]==='>'?'in_progress':m[1]?.toLowerCase()==='x'?'completed':'pending'):'pending';
    const text=m?m[2]!:line;
    const [name,...details]=text.split(' :: ');
    const step=name?.trim()??'',detail=details.join(' :: ').trim();
    if(!step||step.length>160||detail.length>2000)throw Error('PLAN_STEP_INVALID');
    if(status==='in_progress')inProgress++;
    return detail?{step,status,details:detail}:{step,status};
  });
  if(inProgress>1)throw Error('PLAN_CONFLICT_OR_TOO_LONG');
  return result;
}
/** Explicit user assertion about a plan step. Never advances the task phase or runs a model. */
export function completePlanStep(steps:ReadonlyArray<PlanStep>,at:number):PlanStep[]{
  if(!Number.isInteger(at)||at<0||at>=steps.length||steps[at]?.status!=='in_progress')
    throw Error('PLAN_ADVANCE_INVALID');
  const next=steps.map(step=>({...step}));
  next[at]!.status='completed';
  const following=next.findIndex((step,i)=>i>at&&step.status==='pending');
  if(following!==-1)next[following]!.status='in_progress';
  return next;
}
type mappedStatus=PlanStep['status'];
export function formatPlanLines(steps:ReadonlyArray<PlanStep>){
  return steps.map(x=>`[${x.status==='in_progress'?'>':x.status==='completed'?'x':' '}] ${x.step}`+
    (x.details?' :: '+x.details:'')).join('\n');
}
const labels:Record<DurableTask['phase'],string>={
  active:'进行中',waiting:'等待中',paused:'已暂停','recovery-hold':'需恢复确认',
  review:'待验收',completed:'已完成',cancelled:'已取消'
};
/** View projection only; never claim that a persisted plan authorizes execution. */
export function goalWorkbenchSummary(tasks:ReadonlyArray<DurableTask>){
  return {total:tasks.length,active:tasks.filter(t=>t.phase==='active').length,
    waiting:tasks.filter(t=>['waiting','paused','recovery-hold','review'].includes(t.phase)).length,
    completed:tasks.filter(t=>t.phase==='completed').length};
}
export function renderGoalWorkbench(args:{projects:ReadonlyArray<WebFirstProject>;
  tasks:ReadonlyArray<DurableTask>;plans:ReadonlyArray<TaskPlan>;jobs?:ReadonlyArray<LocalCheckJob>;
  jobError?:boolean;aiWorkers?:ReadonlyArray<AiWorkerAssignment>;aiWorkerError?:boolean;message:string;
  limit?:{model:'clear'|'cooldown'|'review';history:'normal'|'degraded'}|null}):string{
  const {projects,tasks,plans,message}=args;
  const summary=goalWorkbenchSummary(tasks);
  const projectNames=new Map(projects.map(p=>[p.id,p.name]));
  const order:Record<DurableTask['phase'],number>={
    active:0,'recovery-hold':1,review:2,waiting:3,paused:4,completed:5,cancelled:6
  };
  const sorted=tasks.slice().sort((a,b)=>order[a.phase]-order[b.phase]||b.updatedAt-a.updatedAt);
  const live=sorted.filter(t=>!['completed','cancelled'].includes(t.phase));
  const archived=sorted.filter(t=>['completed','cancelled'].includes(t.phase));
  const entry=(t:DurableTask)=>{
    const p=plans.find(x=>x.taskId===t.id),revision=p?.revision??0;
    const editable=t.phase!=='completed'&&t.phase!=='cancelled';
    const completed=p?.steps.filter(x=>x.status==='completed').length??0;
    const total=p?.steps.length??0;
    const percentage=total?Math.round(completed*100/total):0;
    const currentIndex=p?.steps.findIndex(x=>x.status==='in_progress')??-1;
    const current=p?.steps.find(x=>x.status==='in_progress')??p?.steps.find(x=>x.status==='pending');
    const stepsPreview=(p?.steps??[]).slice(0,3).map(st=>{
      const status=st.status==='completed'?'done':st.status==='in_progress'?'current':'';
      return `<div class="step-line ${status}"><span class="step-symbol">${st.status==='completed'?'✓':st.status==='in_progress'?'●':'·'}</span><span>${escape(st.step)}</span></div>`;
    }).join('');
    const advance=editable&&t.phase==='active'&&currentIndex>=0&&p?`<form action="${GOAL_FORM_ORIGIN}advance" method="GET">
      <input type="hidden" name="task_id" value="${escape(t.id)}">
      <input type="hidden" name="task_revision" value="${t.revision}">
      <input type="hidden" name="plan_revision" value="${p.revision}">
      <input type="hidden" name="at" value="${currentIndex}">
      <button type="submit" class="success" title="仅标记计划进度；不运行命令或模型">✓ 完成当前步骤</button>
    </form>`:'';
    const recentJob=args.jobs?.filter(j=>j.taskId===t.id).at(-1);
    const busy=args.jobs?.some(j=>j.taskId===t.id&&['queued','running'].includes(j.state))??false;
    const jobLabel:Record<LocalCheckJob['state'],string>={queued:'等待本地检查',running:'本地检查执行中',
      succeeded:'本地检查已完成',failed:'本地检查失败',review:'检查结果待复核'};
    const jobNote=recentJob?`<p class="goal-note" role="status">最近一次 ${recentJob.kind==='root-check'?'目录完整性':'Git 状态'}检查 · ${jobLabel[recentJob.state]}
      ${recentJob.changedCount!==null?' · 已跟踪变更 '+recentJob.changedCount+' 项':''}
      ${recentJob.reason?' · '+escape(recentJob.reason):''}（仅本地检查结果，不代表 Goal 完成）</p>`:'';
    const activeLocalJobs=(args.jobs??[]).filter(j=>j.taskId===t.id).slice(-4);
    const lanes=activeLocalJobs.length>=2?`<div class="steps-mini" aria-label="最近本地 Worker 槽位">
      ${activeLocalJobs.map((j,i)=>`<div class="step-line ${j.state==='succeeded'?'done':j.state==='running'?'current':''}">
        <span class="step-symbol">${j.state==='succeeded'?'✓':j.state==='review'?'!':i+1}</span>
        <span>本地槽位 ${i+1} · ${j.kind==='root-check'?'目录校验':j.kind==='git-status'?'Git 状态':
          j.kind==='git-head'?'Git HEAD':'已跟踪文件统计'} · ${jobLabel[j.state]}</span>
      </div>`).join('')}</div>`:'';
    const team=editable&&t.phase==='active'&&!args.jobError?`<form action="${GOAL_FORM_ORIGIN}worker-team" method="GET">
      <input type="hidden" name="task_id" value="${escape(t.id)}">
      <input type="hidden" name="task_revision" value="${t.revision}">
      <input type="hidden" name="plan_revision" value="${revision}">
      <label class="soft" for="slots-${escape(t.id)}">本地 Worker 并行数（不是 AI Agent）</label>
      <select id="slots-${escape(t.id)}" name="slots" ${busy?'disabled':''}>
        <option value="2">2 个 Worker</option><option value="3">3 个 Worker</option>
        <option value="4">4 个 Worker</option>
      </select><button class="secondary" type="submit" ${busy?'disabled':''}>启动只读 Worker 预检</button>
    </form>`:'';
    const checks=editable&&t.phase==='active'&&args.jobError?
      '<span class="soft">本机检查收据异常；检查已禁用，计划编辑不受影响。</span>':
      editable&&t.phase==='active'?`<form action="${GOAL_FORM_ORIGIN}local-check" method="GET">
      <input type="hidden" name="task_id" value="${escape(t.id)}">
      <input type="hidden" name="task_revision" value="${t.revision}">
      <input type="hidden" name="plan_revision" value="${revision}">
      <button class="secondary" name="check" value="root-check" ${busy?'disabled':''}>检查项目目录</button>
      <button class="secondary" name="check" value="git-status" title="只统计已跟踪文件，不包含未跟踪文件" ${busy?'disabled':''}>检查 Git 状态</button>
    </form>`:'';
    const agents=(args.aiWorkers??[]).filter(w=>w.taskId===t.id&&w.state!=='cancelled');
    const aiLabels:Record<AiWorkerAssignment['role'],string>={
      planner:'规划 Worker',builder:'开发 Worker',tester:'验证 Worker',auditor:'审计 Worker'};
    const aiActive=agents.filter(w=>w.state==='waiting-auth'&&
      w.taskRevision===t.revision&&w.planRevision===revision);
    const agentDescription=agents.length?`<div class="steps-mini" aria-label="AI Agent Worker 分工">
      ${agents.map(w=>`<div class="step-line"><span class="step-symbol">${w.state==='review'?'!':'◇'}</span>
        <span>${aiLabels[w.role]} · ${w.state==='waiting-auth'?'等待可信会话授权':'计划变更，待复核'}</span>
        <form action="${GOAL_FORM_ORIGIN}ai-worker-remove" method="GET">
          <input type="hidden" name="task_id" value="${escape(t.id)}">
          <input type="hidden" name="task_revision" value="${t.revision}">
          <input type="hidden" name="worker_id" value="${escape(w.id)}">
          <button class="secondary" type="submit" title="仅移除此分工，不会发出 ChatGPT 消息">移除</button>
        </form></div>`).join('')}</div>`:
      '<p class="goal-note">尚未配置 AI Agent Worker。分工登记不会启动 ChatGPT 模型。</p>';
    const capacity=4-aiActive.length;
    const aiForm=editable&&t.phase==='active'&&!args.aiWorkerError&&capacity>0?`<form action="${GOAL_FORM_ORIGIN}ai-workers" method="GET">
      <input type="hidden" name="task_id" value="${escape(t.id)}">
      <input type="hidden" name="task_revision" value="${t.revision}">
      <input type="hidden" name="plan_revision" value="${revision}">
      <label class="soft" for="ai-count-${escape(t.id)}">配置 AI Worker 角色（只登记，不发送消息）</label>
      <select id="ai-count-${escape(t.id)}" name="count">
        ${Array.from({length:capacity},(_,i)=>`<option value="${i+1}">增加 ${i+1} 个 AI Worker</option>`).join('')}
      </select><button class="secondary" type="submit">＋ 添加 AI Worker 分工</button>
    </form>`:'';
    const actions=editable?`<form class="state-actions" action="${GOAL_FORM_ORIGIN}decision" method="GET">
      <input type="hidden" name="task_id" value="${escape(t.id)}">
      <input type="hidden" name="revision" value="${t.revision}">
      ${t.phase==='active'?'<button class="secondary" name="decision" value="pause">暂停目标</button>':''}
      ${['paused','waiting','recovery-hold','review'].includes(t.phase)?'<button class="secondary" name="decision" value="resume">确认恢复</button>':''}
      ${t.phase==='review'?'<button class="success" name="decision" value="complete">确认验收完成</button>':''}
      <button class="danger" name="decision" value="cancel">取消目标</button>
    </form>`:'';
    return `<article class="goal" data-phase="${escape(t.phase)}" aria-label="${escape(t.goal)}">
      <div class="goal-body">
        <div class="goal-title-row"><h3 class="goal-title">${escape(t.goal)}</h3><span class="phase ${escape(t.phase)}">${labels[t.phase]}</span></div>
        <div class="goal-meta">${escape(projectNames.get(t.projectId)??'项目已移除')} · 任务 <code title="${escape(t.id)}">${escape(t.id.slice(0,8))}</code> · 修订 ${t.revision}</div>
        ${total?`<div class="goal-summary"><span class="goal-progress-label">计划进度 · ${completed} / ${total} 步</span><span class="goal-progress-label">${percentage}%</span></div><div class="progress" role="progressbar" aria-label="已完成计划步骤" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percentage}"><div class="bar" style="width:${percentage}%"></div></div>
          ${stepsPreview?`<div class="steps-mini">${stepsPreview}</div>`:''}`:'<p class="goal-note">尚未编写计划 · 可在下方展开编辑</p>'}
        ${current?`<p class="next-line"><strong>当前重点</strong> · ${escape(current.step)}</p>`:''}
        ${p?.explanation?`<p class="goal-note">${escape(p.explanation)}</p>`:''}
        ${jobNote}${lanes}
        ${args.aiWorkerError?'<p class="goal-note">AI Worker 登记账本异常；Goal 保留且不会启动模型。</p>':
          `<p class="goal-note">AI Worker ${aiActive.length} / 4 · 待复核 ${agents.length-aiActive.length}（模型执行尚未连接）</p>${agentDescription}`}
        ${t.phase==='recovery-hold'?'<p class="goal-note">重启后需要你确认恢复，系统不会重复执行未知操作。</p>':''}
      </div>
      ${editable?`<details class="edit-panel"><summary>编辑分步计划 · 最多 12 步</summary>
        <div class="edit-content"><form action="${GOAL_FORM_ORIGIN}plan" method="GET">
          <input type="hidden" name="task_id" value="${escape(t.id)}">
          <input type="hidden" name="revision" value="${revision}">
          <label for="plan-${escape(t.id)}">步骤与状态</label>
          <textarea id="plan-${escape(t.id)}" name="steps" rows="${Math.max(4,Math.min(12,total+2))}" maxlength="12000" spellcheck="false" placeholder="[>] 当前正在做什么&#10;[ ] 下一步准备做什么">${escape(formatPlanLines(p?.steps??[]))}</textarea>
          <p class="helper">[ ] 待办 · [&gt;] 进行中 · [x] 完成 · 用 :: 添加说明。最多一个进行中步骤。</p>
          <div class="toolbar"><button class="primary" type="submit">保存计划</button><span class="soft">计划版本 ${revision} · 保存不等于执行</span></div>
        </form></div>
      </details>`: ''}
      ${editable?`<div class="goal-actions"><span class="soft">手动更新本机状态 · 不运行模型</span>
        <div class="state-actions">${aiForm}${team}${checks}${advance}${actions}</div></div>`:''}
    </article>`;
  };
  const model=args.limit?.model;
  const modelText=model==='cooldown'?'检测到模型冷却。你仍可安全编辑目标、计划和检查点。':
    model==='review'?'本机冷却期限已到，实际可用额度尚未核实。恢复前需要人工检查。':
    model==='clear'?'本机未设置模型续接暂停；这不代表服务端额度已获验证。':
    '尚未获得可信的模型额度状态，自动执行保持关闭。';
  const visibleMessage=args.jobError?'本机检查收据异常：仅禁用检查操作，Goal 和计划不会被重置。'+message:message;
  const noticeError=/未执行|拒绝|失败|异常/.test(visibleMessage);
  const noticeSuccess=!!visibleMessage&&!noticeError;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; form-action cos-next-goal:; base-uri 'none'; connect-src 'none'; img-src 'none'">
    <title>CoS Next · Goal 工作台</title><style>${GOAL_WORKBENCH_CSS}</style></head><body><main>
      <header class="top"><div><div class="eyebrow">WORKSPACE / GOALS</div><h1>目标与计划工作台</h1>
        <p class="muted">从目标到分步计划，状态在本机持久保存。按需编辑、暂停或恢复，不会自动消耗模型额度。</p></div>
        <div class="top-right"><span class="cap">本机持久化</span><a class="text-link" href="${GOAL_FORM_ORIGIN}refresh">刷新状态 ↻</a></div>
      </header>
      <div class="metrics" aria-label="目标概览">
        <div class="metric"><span class="label">全部目标</span><span class="number">${summary.total}</span></div>
        <div class="metric active"><span class="label">进行中</span><span class="number">${summary.active}</span></div>
        <div class="metric wait"><span class="label">等待 / 需处理</span><span class="number">${summary.waiting}</span></div>
        <div class="metric"><span class="label">已完成</span><span class="number">${summary.completed}</span></div>
      </div>
      ${visibleMessage?`<div class="notice ${noticeError?'error':noticeSuccess?'success':''}" role="status"><span class="glyph">${noticeError?'!':'✓'}</span><div><strong>${noticeError?'操作未保存':'状态已更新'}</strong><p>${escape(visibleMessage)}</p></div></div>`:''}
      <div class="columns"><section class="card" id="create"><div class="card-body">
        <div class="card-heading"><div><div class="card-kicker">01 · NEW GOAL</div><h2 class="card-title">创建一个新目标</h2></div><span class="muted">无需预先配置 MCP 命令</span></div>
        <form action="${GOAL_FORM_ORIGIN}create" method="GET">
          <div class="field"><label for="new-project">选择项目</label><select id="new-project" name="project_id" required ${projects.length?'':'disabled'}>
            ${projects.map(p=>`<option value="${escape(p.id)}">${escape(p.name)}</option>`).join('')}
          </select>${!projects.length?'<div class="no-projects">尚无本地项目，请从主窗口顶部「本地项目 → 添加项目目录」登记后再创建。</div>':''}</div>
          <div class="field"><label for="new-goal">你希望完成什么？</label><textarea id="new-goal" name="goal" maxlength="2000" rows="3" required placeholder="例如：修复项目的核心问题，完成本地测试并形成验收报告"></textarea><p class="helper">建议描述目标、验收标准和不允许修改的范围。</p></div>
          <div class="field"><label for="new-steps">初始执行计划 <span class="soft">· 可稍后添加</span></label>
            <textarea id="new-steps" name="steps" maxlength="12000" rows="4" spellcheck="false" placeholder="[>] 检查当前状态与测试
[ ] 修复高优先级缺口
[ ] 全量本地验证
[ ] 汇报结果"></textarea>
            <p class="helper">[ ] 待办 · [&gt;] 进行中 · [x] 完成 · :: 说明。最多 12 步。</p></div>
          <div class="toolbar"><button type="submit" class="primary" ${projects.length?'':'disabled'}>＋ 创建并保存目标</button><span class="soft">仅保存，不自动运行</span></div>
        </form></div></section>
        <aside class="card limit-card"><div class="card-body">
          <div class="card-kicker">02 · RUNTIME STATUS</div><h2 class="card-title">执行与限流状态</h2>
          <div class="limit-header" style="margin-top:18px"><span class="limit-dot ${model==='clear'?'clear':model==='review'?'review':''}"></span>${model==='cooldown'?'模型冷却中':model==='review'?'等待人工复核':model==='clear'?'本机未设置限流暂停':'状态待确认'}</div>
          <p class="limit-message">${modelText}</p><div class="limit-detail">
          <p class="hint">历史列表：${args.limit?.history==='degraded'?'检测到加载限流，不等于模型额度耗尽':'未记录当前加载限流（不代表网络已验证）'}</p>
          <p class="mini-line">计划修改、状态记录与本地保存不需要模型。</p>
          <p class="mini-line">自动 Goal/Loop 仍未启用，不会擅自续发网页消息。</p>
          <p class="mini-line">仅人工授权后可恢复等待或异常目标。</p>
          </div></div></aside></div>
      <section aria-label="当前目标"><div class="section-heading"><h2>当前目标</h2><p>${live.length} 个需要跟进的目标 · 按状态优先级排列</p></div>
        ${live.length?`<div class="goals">${live.map(entry).join('')}</div>`:
        '<div class="empty"><div class="empty-icon">◎</div><h3>还没有需要跟进的目标</h3><p>从上方创建第一个目标，或者查看下方已完成的目标。</p></div>'}
      </section>
      ${archived.length?`<details class="archive"><summary>历史目标 · ${archived.length} 个（已完成 / 已取消）</summary><div class="goals">${archived.map(entry).join('')}</div></details>`:''}
      <footer class="footer">CoS Next · 原生安全工作台 · 无 JavaScript / 无 ChatGPT 网页访问权限 / 不读取 Cookie 或密钥。<br>计划与持久任务并非自动执行授权；修改文件、终端命令和网页续接仍须通过各自的安全门禁。</footer>
    </main></body></html>`;
}
