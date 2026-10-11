/** Privacy-minimal real ChatGPT webpage gate.
 * No text, cookies, challenge tokens, or page credentials cross the boundary.
 */
export type WebGateInput={
  official:boolean; composer:'READY'|'EMPTY_OR_HIDDEN'|'DRAFT_PRESENT'|'GENERATING';
  loginVisible:boolean; interstitial:boolean; documentStatus:number|null;
};
export type WebGateDecision=
  |'EDITOR_READY'|'LOGIN_REQUIRED'|'SECURITY_CHECK_REQUIRED'|'HTTP_BLOCKED'
  |'OTHER_SITE'|'PAGE_LOADING'|'COMPOSER_OCCUPIED';
export function classifyRealWebGate(gate:WebGateInput):WebGateDecision{
  if(!gate.official)return 'OTHER_SITE';
  if(gate.interstitial)return 'SECURITY_CHECK_REQUIRED';
  if(gate.documentStatus!==null&&gate.documentStatus>=400)
    return 'HTTP_BLOCKED';
  if(gate.loginVisible)return 'LOGIN_REQUIRED';
  if(gate.composer==='READY')return 'EDITOR_READY';
  if(gate.composer==='DRAFT_PRESENT'||gate.composer==='GENERATING')
    return 'COMPOSER_OCCUPIED';
  return 'PAGE_LOADING';
}
export const WEB_INTERSTITIAL_PROBE=`(() => {
  const title=(document.title||"").toLowerCase();
  const body=(document.body?.innerText||"").slice(0,2400).toLowerCase();
  return !!document.querySelector('#challenge-form,#challenge-stage,#challenge-running,[id^="cf-challenge"],[class*="challenge-container"]') ||
    /just a moment|请稍候|正在检查您的浏览器|checking your browser/.test(title) ||
    /enable javascript and cookies to continue|验证成功。正在等待|verify you are human|confirm you are human/.test(body);
})()`;
