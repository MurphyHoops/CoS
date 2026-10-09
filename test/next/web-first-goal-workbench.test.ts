import {describe,it,expect} from 'vitest';
import {parseWorkbenchAction,parsePlanLines,formatPlanLines,completePlanStep,goalWorkbenchSummary,renderGoalWorkbench} from '../../src/main/next/web-first/goal-workbench.js';
const goalId='11111111-2222-4333-8444-555555555555';
describe('JS-free native Goal workbench parser and presentation',()=>{
  it('parses plan status syntax, enforces one in-progress and rejects oversized goals',()=>{
    const parsed=parsePlanLines('[x] Completed :: verified\n[>] Running\n[ ] Later');
    expect(parsed.map(p=>p.status)).toEqual(['completed','in_progress','pending']);
    expect(formatPlanLines(parsed)).toContain('[x] Completed :: verified');
    expect(()=>parsePlanLines('[>] One\n[>] Two')).toThrow('PLAN_CONFLICT_OR_TOO_LONG');
    expect(()=>parsePlanLines(new Array(13).fill('[ ] Too many').join('\n'))).toThrow('PLAN_STEPS_INVALID');
  });
  it('only handles exact local navigation with bounded required field names',()=>{
    const url='cos-next-goal://native/create?project_id=project-0000001&goal='+encodeURIComponent('Repair P3')+'&steps='+encodeURIComponent('[>] Test');
    expect(parseWorkbenchAction(url)).toEqual({kind:'create',projectId:'project-0000001',goal:'Repair P3',lines:'[>] Test'});
    expect(parseWorkbenchAction('cos-next-goal://native/plan?task_id='+goalId+'&revision=0&steps=x')).toMatchObject({kind:'update-plan',revision:0});
    expect(parseWorkbenchAction('cos-next-goal://native/decision?task_id='+goalId+'&revision=2&decision=resume')).toMatchObject({kind:'decision',decision:'resume'});
    expect(parseWorkbenchAction('cos-next-goal://native/decision?task_id='+goalId+'&revision=2&decision=pause')).toMatchObject({kind:'decision',decision:'pause'});
    for(const raw of ['https://evil.com/create?goal=x','cos-next-goal://evil/create?goal=x',
      url+'&goal=second',url+'&unexpected=true','cos-next-goal://native/../../etc']){
      expect(()=>parseWorkbenchAction(raw)).toThrow();
    }
  });
  it('manual single-step advance requires valid step and revisions',()=>{
    const original=parsePlanLines('[x] Finished\n[>] Running\n[ ] Later');
    const updated=completePlanStep(original,1);
    expect(updated.map(x=>x.status)).toEqual(['completed','completed','in_progress']);
    expect(original.map(x=>x.status)).toEqual(['completed','in_progress','pending']);
    expect(()=>completePlanStep(original,2)).toThrow('PLAN_ADVANCE_INVALID');
    expect(()=>completePlanStep(original,12)).toThrow('PLAN_ADVANCE_INVALID');
    const parsed=parseWorkbenchAction(`cos-next-goal://native/advance?task_id=${goalId}&task_revision=2&plan_revision=3&at=1`);
    expect(parsed).toEqual({kind:'advance',taskId:goalId,taskRevision:2,planRevision:3,at:1});
    for(const suffix of ['at=-1','at=99','at=','at=1&unexpected=true']){
      expect(()=>parseWorkbenchAction(`cos-next-goal://native/advance?task_id=${goalId}&task_revision=2&plan_revision=3&${suffix}`)).toThrow();
    }
  });
  it('does not hide existing goals if the separate diagnostic ledger is corrupt',()=>{
    const html=renderGoalWorkbench({projects:[],tasks:[{id:goalId,
      projectId:'project-test-12345',projectRoot:'/tmp/example',rootDev:1,rootIno:2,
      goal:'Preserved Goal',phase:'active',revision:1,createdAt:1,updatedAt:1,
      waitUntil:null,events:[]}],plans:[],jobs:[],jobError:true,message:''});
    expect(html).toContain('Preserved Goal');
    expect(html).toContain('本机检查收据异常');
    expect(html).toContain('编辑分步计划');
    expect(html).not.toContain('name="check"');
  });
  it('accepts only named read-only native checks with exact revisions',()=>{
    const u=`cos-next-goal://native/local-check?task_id=${goalId}&task_revision=1&plan_revision=0&check=git-status`;
    expect(parseWorkbenchAction(u)).toMatchObject({kind:'local-check',check:'git-status',planRevision:0});
    for(const bad of [u.replace('git-status','exec-command'),u+'&shell=true',
      u.replace('task_revision=1','task_revision=0'),u.replace('plan_revision=0','plan_revision=-1')]){
      expect(()=>parseWorkbenchAction(bad)).toThrow();
    }
  });
  it('renders plan progress, archive and model limits',()=>{
    const base={id:goalId,projectId:'project-test-12345',projectRoot:'/tmp/example',rootDev:1,rootIno:2,
      goal:'Test durable plan',phase:'active' as const,revision:2,createdAt:1,updatedAt:2,waitUntil:null,events:[]};
    const tasks=[base,{...base,id:'22222222-3333-4444-8555-666666666666',phase:'completed' as const}];
    const html=renderGoalWorkbench({projects:[],tasks,plans:[{taskId:goalId,projectId:base.projectId,revision:3,updatedAt:2,
      explanation:'Manual plan',nonce:'synthetic-once',steps:parsePlanLines('[x] Done\n[>] Running\n[ ] Next')}],
      message:'',limit:{model:'cooldown',history:'degraded'}});
    expect(goalWorkbenchSummary(tasks)).toMatchObject({total:2,active:1,completed:1});
    expect(html).toContain('完成当前步骤');expect(html).toContain('计划进度 · 1 / 3 步');
    expect(html).toContain('模型冷却中');expect(html).toContain('<details class="archive">');
    expect(html).toContain('form-action cos-next-goal:');expect(html).not.toContain('<script>');
  });
  it('escapes hostile project names and goal text, only renders non-JS local forms',()=>{
    const html=renderGoalWorkbench({projects:[{id:'project-test-12345',name:'<img src=x onerror=alert(1)>',root:'/tmp/example',registeredAt:1}],
      tasks:[{id:goalId,projectId:'project-test-12345',projectRoot:'/tmp/example',rootDev:1,rootIno:2,
        goal:'<script>alert(1)</script>',phase:'waiting',revision:2,createdAt:1,updatedAt:2,
        waitUntil:null,events:[]}],plans:[],message:'<svg onload=alert(1)>'});
    expect(html).not.toContain('<script>');expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;');expect(html).toContain('form-action cos-next-goal:');
    expect(html).toContain('disabled');
    expect(html).toContain('确认恢复');
  });
});
