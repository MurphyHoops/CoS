/**
 * Pure JavaScript-free local-native Goal UI. HTML forms are intercepted
 * BEFORE navigation by WebContents will-navigate. No renderer IPC, preload,
 * remote URLs, browser storage, ChatGPT page access or model inference.
 */
import type {WebFirstProject} from './project-registry.js';
import type {DurableTask} from './task-ledger.js';
import type {TaskPlan,PlanStep} from './plan-ledger.js';
const escape=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;',
  '>':'&gt;','"':'&quot;',"'":'&#39;'}[c]??''));
export const GOAL_FORM_ORIGIN='cos-next-goal://native/';
export type GoalWorkbenchAction= {kind:'create';projectId:string;goal:string;lines:string}|
  {kind:'update-plan';taskId:string;revision:number;lines:string}|
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
type mappedStatus=PlanStep['status'];
export function formatPlanLines(steps:ReadonlyArray<PlanStep>){
  return steps.map(x=>`[${x.status==='in_progress'?'>':x.status==='completed'?'x':' '}] ${x.step}`+
    (x.details?' :: '+x.details:'')).join('\n');
}
export function renderGoalWorkbench(args:{projects:ReadonlyArray<WebFirstProject>;
  tasks:ReadonlyArray<DurableTask>;plans:ReadonlyArray<TaskPlan>;message:string;
  limit?:{model:'clear'|'cooldown'|'review';history:'normal'|'degraded'}|null}):string{
  const {projects,tasks,plans,message}=args;
  const entries=tasks.slice().reverse().map(t=>{
    const p=plans.find(x=>x.taskId===t.id),revision=p?.revision??0;
    const editable=t.phase!=='completed'&&t.phase!=='cancelled';
    const buttons=editable?`<form action="${GOAL_FORM_ORIGIN}decision" method="GET">
      <input type="hidden" name="task_id" value="${escape(t.id)}">
      <input type="hidden" name="revision" value="${t.revision}">
      ${t.phase==='active'?'<button name="decision" value="pause">暂停目标</button>':''}
      ${['paused','waiting','recovery-hold','review'].includes(t.phase)?'<button name="decision" value="resume">恢复目标</button>':''}
      ${t.phase==='review'?'<button name="decision" value="complete">确认完成</button>':''}
      <button class="danger" name="decision" value="cancel">取消目标</button>
    </form>`:'';
    return `<section><header><strong>${escape(t.goal)}</strong><span>${escape(t.phase)} · 任务版本 ${t.revision}</span></header>
      <p class="small">任务 ${escape(t.id)} · 项目 ${escape(t.projectId)}</p>
      ${p?.explanation?`<p class="small">${escape(p.explanation)}</p>`:''}
      <form action="${GOAL_FORM_ORIGIN}plan" method="GET">
       <input type="hidden" name="task_id" value="${escape(t.id)}">
       <input type="hidden" name="revision" value="${revision}">
       <label>分步计划（每行一步，[ ] 待办、[&gt;] 进行中、[x] 已完成；:: 后写细节）</label>
       <textarea name="steps" rows="${Math.max(3,Math.min(12,(p?.steps.length??0)+2))}" maxlength="12000" ${editable?'':'disabled'}>${escape(formatPlanLines(p?.steps??[]))}</textarea>
       ${editable?`<button type="submit">保存计划 · rev ${revision}</button>`:''}
      </form>${buttons}</section>`;
  }).join('');
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; form-action cos-next-goal:; base-uri 'none'; connect-src 'none'; img-src 'none'">
    <title>CoS Next · Goal 工作台</title><style>
      body{font-family:system-ui,-apple-system,sans-serif;background:#111c29;color:#e9f0f8;margin:0;padding:22px;line-height:1.55}
      h1{font-size:21px;margin:0 0 4px}h2{font-size:16px;margin:16px 0}p{margin:7px 0}
      section{background:#1b2a3d;border:1px solid #31445b;border-radius:12px;padding:15px;margin:13px 0}
      label{display:block;margin:10px 0 5px;font-weight:600;font-size:13px}
      textarea,select{box-sizing:border-box;width:100%;padding:10px;border-radius:7px;border:1px solid #64748b;background:#f8fafc;color:#14202e;font:14px system-ui}
      button{cursor:pointer;margin:10px 6px 0 0;padding:9px 13px;border:0;border-radius:7px;color:white;background:#1769df;font-weight:600}
      button.danger{background:#8e3b46}button:disabled{opacity:.4}
      header{display:flex;gap:12px;justify-content:space-between;flex-wrap:wrap}header span,.small{color:#b1c3d8;font-size:12px}
      .notice{border-left:4px solid #efb663;padding:10px;background:#22334b;border-radius:5px;margin-top:15px}
      a{color:#98c6ff;text-decoration:underline}
    </style></head><body><h1>CoS Next · Goal / 计划工作台</h1>
    <p class="small">目标与计划存储在本机。计划不会自动执行；暂停与重启后不会重复发送网页消息。</p>
    <div class="notice">${escape(message||'创建一次 Goal，后续在此更新计划、暂停或恢复。限流不会删除任务。')}</div>
    <section><h2>模型与网络限流</h2><p>${args.limit?.model==='cooldown'? '模型冷却中 · 本机计划可继续维护':
      args.limit?.model==='review'?'冷却期限已到 · 需核对模型额度并人工确认':
      args.limit?.model==='clear'?'本机模型续接门禁未暂停（不代表云端额度已确认）':
      '限流状态不可用 · 不允许据此自动续接'}
      <span class="small"> · 历史列表 ${args.limit?.history==='degraded'?'加载限流':'状态正常或未知'}</span></p>
      <p class="small">持续自动 Loop 尚未开放。限流等待期间，目标、计划、检查点仍保留。</p>
    </section>
    <section><h2>创建新 Goal</h2><form action="${GOAL_FORM_ORIGIN}create" method="GET">
      <label>本地项目</label><select name="project_id">${projects.map(p=>
        `<option value="${escape(p.id)}">${escape(p.name)}</option>`).join('')}</select>
      <label>目标（具体、可验证）</label><textarea name="goal" maxlength="2000" rows="3" required></textarea>
      <label>步骤（可先不填）</label><textarea name="steps" maxlength="12000" rows="4" placeholder="[>] 检查当前项目状态\n[ ] 修复主要问题\n[ ] 本地验证后提交"></textarea>
      <button type="submit" ${projects.length?'':'disabled'}>创建 Goal 并保存初始计划</button>
    </form></section><h2>已有目标 · ${tasks.length}</h2>${entries||'<p>尚无目标。创建后会出现在这里。</p>'}
    <p class="small">本工作台使用独立、禁用 JavaScript 的原生窗口；不会通过 ChatGPT 网页提交计划。</p></body></html>`;
}
