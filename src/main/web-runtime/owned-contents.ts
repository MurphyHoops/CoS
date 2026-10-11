import type {WebContents} from 'electron';

/** CoS-owned webpage pages, never the local Classic UI. This registry is set
 * by the native Browser Supervisor before the first navigation occurs.
 */
const permitted=new WeakSet<WebContents>();
export function registerOwnedWebContents(contents:WebContents):void {
  permitted.add(contents);
  contents.once('destroyed',()=>permitted.delete(contents));
}
export function isOwnedWebContents(contents:WebContents):boolean{
  return permitted.has(contents);
}
