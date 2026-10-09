import type {WebFirstPlanLedger,PlanStep,TaskPlan} from './plan-ledger.js';
import type {WebFirstTaskLedger} from './task-ledger.js';
export type PlanPermission=(action:'update',details:{taskId:string;goal:string;
  steps:PlanStep[];expectedRevision:number})=>Promise<boolean>;
const view=(p:TaskPlan|null)=>p&&({task_id:p.taskId,project_id:p.projectId,
  revision:p.revision,updated_at:p.updatedAt,explanation:p.explanation,plan:p.steps});
export class WebFirstPlanTools {
  constructor(private readonly plans:WebFirstPlanLedger,
    private readonly tasks:WebFirstTaskLedger,private readonly consent:PlanPermission){}
  async status(taskId:string){return view(await this.plans.status(taskId));}
  async update(args:{taskId:string;expectedRevision:number;nonce:string;
    explanation:string;steps:PlanStep[]}){
    const old=await this.plans.status(args.taskId),task=await this.tasks.get(args.taskId);
    // Idempotent retransmissions require no new approval and never mutate.
    if(old?.nonce===args.nonce){return view(await this.plans.update(args));}
    if(!await this.consent('update',{taskId:task.id,goal:task.goal,
      steps:args.steps,expectedRevision:args.expectedRevision}))
      throw Error('PLAN_NATIVE_APPROVAL_DENIED');
    return view(await this.plans.update(args));
  }
}
