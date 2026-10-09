/** Scoped P3 task tool facade; no model transport, shell or autonomous browser input. */
import type {WebFirstProjectRegistry} from './project-registry.js';
import {WebFirstTaskLedger,type DurableTask} from './task-ledger.js';
export type TaskApproval=(action:'create',detail:{projectId:string;name:string;goal:string})=>Promise<boolean>;
export type TaskView={task_id:string;project_id:string;phase:string;revision:number;wait_until:number|null;last_event:string};
const safeView=(t:DurableTask):TaskView=>({task_id:t.id,project_id:t.projectId,
  phase:t.phase,revision:t.revision,wait_until:t.waitUntil,
  last_event:t.events.at(-1)?.kind??'unknown'});
export class WebFirstTaskTools {
  constructor(private readonly ledger:WebFirstTaskLedger,
    private readonly projects:WebFirstProjectRegistry,private readonly approve:TaskApproval){}
  async begin(projectId:string,goal:string){
    const target=(await this.projects.list()).find(p=>p.id===projectId);
    if(!target)throw Error('PROJECT_NOT_REGISTERED');
    if(!await this.approve('create',{projectId,name:target.name,goal}))throw Error('NATIVE_TASK_APPROVAL_DENIED');
    return safeView(await this.ledger.begin({projectId,projectRoot:target.root,goal}));
  }
  async status(taskId:string){return safeView(await this.ledger.get(taskId));}
  async checkpoint(taskId:string,revision:number,nonce:string,note:string){
    return safeView(await this.ledger.checkpoint(taskId,revision,nonce,note));
  }
  async wait(taskId:string,revision:number,nonce:string,minutes:number|null){
    return safeView(await this.ledger.wait(taskId,revision,nonce,minutes));
  }
  async finishRequest(taskId:string,revision:number,nonce:string,note:string){
    return safeView(await this.ledger.requestReview(taskId,revision,nonce,note));
  }
}
