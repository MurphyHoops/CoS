/** Minimal OAuth storage access and popup fences: no local OS permissions. */
import {classifyWebFirstNavigation,isAllowedWebFirstNavigation} from './host-policy.js';
const STORAGE_PERMISSIONS = new Set(['storage-access','top-level-storage-access']);
function exactTrustedOrigin(raw:string):boolean{
  try{
    const u=new URL(raw);
    return u.protocol==='https:' && !u.username && !u.password &&
      !u.port && u.pathname==='/' && !u.search && !u.hash && isAllowedWebFirstNavigation(raw);
  }catch{return false;}
}
export function allowedOAuthStoragePermission(permission:string, requestingOrigin:string, embeddingOrigin?:string):boolean{
  if(!STORAGE_PERMISSIONS.has(permission) || !exactTrustedOrigin(requestingOrigin))return false;
  if(embeddingOrigin && !exactTrustedOrigin(embeddingOrigin))return false;
  return true;
}
export function allowedOAuthPopup(url:string):boolean{
  const classification=classifyWebFirstNavigation(url);
  if(classification==='login')return true;
  if(classification!=='chatgpt')return false;
  try{
    const route=new URL(url).pathname;
    return route==='/login' || route.startsWith('/auth/') || route.startsWith('/api/auth/');
  }catch{return false;}
}
