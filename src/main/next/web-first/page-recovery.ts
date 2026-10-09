/** A page may be 'did-finish-load' while displaying only a blank document. */
export interface SafePageProbe {
  readyState:string;bodyElements:number;buttons:number;editorPresent:boolean;
  visibleElements:number;hasBody:boolean;
}
export type PageRecoveryCause='MAIN_FRAME_HTTP'|'MAIN_FRAME_NETWORK'|'RENDERER_GONE'|'EMPTY_DOCUMENT'|'NO_PAGE_RESPONSE';
export interface PageRecoveryIssue {cause:PageRecoveryCause;status:number|null;code:number|null;}
export class PageRecoveryGate {
  private startedAt=0;
  private emptyCount=0;
  private retried=false;
  private recordedIssue:PageRecoveryIssue|null=null;
  private navHttpStatus:number|null=null;
  navigate(now:number){this.startedAt=now;this.emptyCount=0;this.recordedIssue=null;this.navHttpStatus=null;}
  httpStatus(status:number){if(Number.isInteger(status)&&status>=100&&status<=599)this.navHttpStatus=status;}
  get http(){return this.navHttpStatus;}
  get issue(){return this.recordedIssue;}
  get autoRetried(){return this.retried;}
  renderFailure(code:number){this.recordedIssue={cause:'MAIN_FRAME_NETWORK',status:this.navHttpStatus,code};}
  rendererGone(){this.recordedIssue={cause:'RENDERER_GONE',status:this.navHttpStatus,code:null};}
  clearIssue(){this.recordedIssue=null;this.emptyCount=0;}
  probe(sample:SafePageProbe|null,now:number):{issue:PageRecoveryIssue|null;retry:boolean}{
    if(this.recordedIssue)return {issue:this.recordedIssue,retry:false};
    // Never classify OAuth prompts, loading screens, or a working composer as empty.
    if(!sample){
      // A stalled or inaccessible renderer can otherwise remain entirely
      // white with no did-fail-load event. Do NOT auto-retry this case.
      if(now-this.startedAt>26000&&++this.emptyCount>=3){
        this.recordedIssue={cause:'NO_PAGE_RESPONSE',status:this.navHttpStatus,code:null};
        return {issue:this.recordedIssue,retry:false};
      }
      return {issue:null,retry:false};
    }
    if(sample.readyState!=='complete'||!sample.hasBody||
      sample.editorPresent||sample.buttons>0||sample.bodyElements>4||sample.visibleElements>1){
      this.emptyCount=0;return {issue:null,retry:false};
    }
    if(now-this.startedAt<14000){this.emptyCount=0;return {issue:null,retry:false};}
    this.emptyCount++;
    if(this.emptyCount<3)return {issue:null,retry:false};
    this.recordedIssue={cause:this.navHttpStatus&&this.navHttpStatus>=400?'MAIN_FRAME_HTTP':'EMPTY_DOCUMENT',
      status:this.navHttpStatus,code:null};
    if(!this.retried){this.retried=true;return {issue:this.recordedIssue,retry:true};}
    return {issue:this.recordedIssue,retry:false};
  }
  fallbackMessage():{title:string;detail:string}|null{
    const issue=this.recordedIssue;
    if(!issue)return null;
    if(issue.cause==='MAIN_FRAME_HTTP')return {title:'ChatGPT 网页请求未成功',
      detail:'主文档 HTTP '+(issue.status??'未知')+'。可能是临时访问限制、网络校验或服务端错误；Core MCP 连接不代表网页已加载。'};
    if(issue.cause==='MAIN_FRAME_NETWORK')return {title:'ChatGPT 网页连接失败',
      detail:'主文档加载错误 '+(issue.code??'未知')+'。请检查网络，使用顶部「ChatGPT 网页 → 安全重新加载」。'};
    if(issue.cause==='RENDERER_GONE')return {title:'ChatGPT 网页渲染器异常退出',
      detail:'网页渲染进程已退出，原生项目侧栏和 Core MCP 可以继续工作；请从菜单重新加载网页。'};
    return {title:'ChatGPT 网页没有显示内容',
      detail:'已检测到持续空白文档。不会清除登录凭证；可以从顶部菜单安全重新加载或检查网页健康状态。'};
  }
}
