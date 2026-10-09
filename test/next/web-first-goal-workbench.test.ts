import {describe,it,expect} from 'vitest';
import {parseWorkbenchAction,parsePlanLines,formatPlanLines,renderGoalWorkbench} from '../../src/main/next/web-first/goal-workbench.js';
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
  it('escapes hostile project names and goal text, only renders non-JS local forms',()=>{
    const html=renderGoalWorkbench({projects:[{id:'project-test-12345',name:'<img src=x onerror=alert(1)>',root:'/tmp/example',registeredAt:1}],
      tasks:[{id:goalId,projectId:'project-test-12345',projectRoot:'/tmp/example',rootDev:1,rootIno:2,
        goal:'<script>alert(1)</script>',phase:'waiting',revision:2,createdAt:1,updatedAt:2,
        waitUntil:null,events:[]}],plans:[],message:'<svg onload=alert(1)>'});
    expect(html).not.toContain('<script>');expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;');expect(html).toContain('form-action cos-next-goal:');
    expect(html).toContain('disabled');
    expect(html).toContain('恢复目标');
  });
});
