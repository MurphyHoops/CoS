/**
 * ChatGPT Web-First health counters. Never retain URL paths, query parameters,
 * cookies, tokens, message bodies, text content or JavaScript console strings.
 */
export type RequestBucket = 'chatgpt-api' | 'chatgpt-shell' | 'openai-login' | 'external-login' | 'other';
export interface WebHealthCounters { total:number; success:number; http4xx:number; http5xx:number; failed:number; }
export interface WebHealthSnapshot {
  requests:Record<RequestBucket,WebHealthCounters>;
  lastNetworkError:string|null;
  httpFailures: Record<string,number>;
  // Coarse UI structure only, never user text, account or conversation data.
  page?:{readyState:string;textareaCount:number;enabledTextareas:number;disabledButtons:number;totalButtons:number;serviceWorkerControlled:boolean;editorPresent:boolean;editorEnabled:boolean;historyLinkCount:number;editableNodes:number;textBoxRoles:number;inputNodes:number;editorVisible:boolean;editorAcceptsInput:boolean;};
}
const BUCKETS:RequestBucket[]=['chatgpt-api','chatgpt-shell','openai-login','external-login','other'];
function count():WebHealthCounters{return {total:0,success:0,http4xx:0,http5xx:0,failed:0};}
export function classifyRequest(url:string):RequestBucket {
  try{
    const u=new URL(url);
    if(u.protocol!=='https:')return 'other';
    if(u.hostname==='chatgpt.com' || u.hostname==='www.chatgpt.com'){
      return u.pathname.startsWith('/backend-api/') || u.pathname.startsWith('/api/') ? 'chatgpt-api':'chatgpt-shell';
    }
    if(['auth.openai.com','login.openai.com','auth.chatgpt.com'].includes(u.hostname))return 'openai-login';
    if(['accounts.google.com','appleid.apple.com','idmsa.apple.com','login.microsoftonline.com','login.live.com'].includes(u.hostname))return 'external-login';
  }catch{/* unsupported URL */}
  return 'other';
}
export function safeApiRouteClass(value:string):string {
  try{
    const u=new URL(value);
    if(!['chatgpt.com','www.chatgpt.com'].includes(u.hostname))return 'not-chatgpt';
    const path=u.pathname;
    for(const [prefix,label] of [
      ['/backend-api/conversations','conversation-list'],
      ['/backend-api/conversation/','conversation-detail'],
      ['/backend-api/accounts','accounts'],
      ['/backend-api/models','models'],
      ['/backend-api/settings','settings'],
      ['/backend-api/gizmos','gizmos'],
      ['/backend-api/me','profile'],
      ['/backend-api/auth','auth'],
      ['/backend-api/user','user'],
      ['/api/auth','auth']
    ] as Array<[string,string]>)if(path===prefix||path.startsWith(prefix+'/'))return label;
    return path.startsWith('/backend-api/')?'other-chatgpt-api':'other-chatgpt-route';
  }catch{return 'malformed';}
}
export function redactedNetworkError(error:string):string {
  // Only the standardized transport error code. No text, URL, query or headers.
  const match=error.match(/(?:net::)?ERR_[A-Z0-9_]{1,60}/);
  return match ? match[0].replace(/^net::/, '') : 'NETWORK_ERROR_UNCLASSIFIED';
}
export function newWebHealthTracker(){
  const requests=Object.fromEntries(BUCKETS.map(b=>[b,count()])) as Record<RequestBucket,WebHealthCounters>;
  let lastNetworkError:string|null=null;
  const httpFailures:Record<string,number>={};
  return {
    completed(url:string,status:number){
      const c=requests[classifyRequest(url)];c.total++;
      if(status>=400 && status<500)c.http4xx++;
      else if(status>=500)c.http5xx++;
      if(status>=400 && status<600){
        const key=safeApiRouteClass(url)+':'+status;
        if(Object.prototype.hasOwnProperty.call(httpFailures,key)||Object.keys(httpFailures).length<32)
          httpFailures[key]=(httpFailures[key]??0)+1;
      }
      else if(status>=200 && status<400)c.success++;
    },
    failed(url:string,error:string){
      const c=requests[classifyRequest(url)];c.total++;c.failed++;
      lastNetworkError=redactedNetworkError(error);
    },
    snapshot():WebHealthSnapshot{return {requests:structuredClone(requests),lastNetworkError,httpFailures:{...httpFailures}};}
  };
}
