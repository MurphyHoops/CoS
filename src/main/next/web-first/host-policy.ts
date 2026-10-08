/** P1's entire navigation policy: no Chrome, no private ChatGPT API, no DOM scraping. */
export const CHATGPT_START_URL = 'https://chatgpt.com/';
export const WEB_FIRST_PARTITION = 'persist:cos-next-web-first-chatgpt';
const CHAT_ORIGINS = new Set(['chatgpt.com','www.chatgpt.com']);
// Exact login hosts only; any new identity provider must be reviewed explicitly.
const LOGIN_HOSTS = new Set([
  'auth.openai.com', 'login.openai.com', 'auth.chatgpt.com',
  'accounts.google.com', 'appleid.apple.com', 'idmsa.apple.com',
  'login.microsoftonline.com', 'login.live.com'
]);
export type HostSite = 'chatgpt' | 'login' | 'blocked';
export function classifyWebFirstNavigation(value: string): HostSite {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return 'blocked';
    if (CHAT_ORIGINS.has(url.hostname)) return 'chatgpt';
    if (LOGIN_HOSTS.has(url.hostname)) return 'login';
  } catch { /* malformed */ }
  return 'blocked';
}
export function isAllowedWebFirstNavigation(value: string): boolean {
  return classifyWebFirstNavigation(value) !== 'blocked';
}
export function sanitizedNavigationLabel(value: string): string {
  // Intentionally excludes path, query, fragment, login tickets and conversation IDs.
  const kind = classifyWebFirstNavigation(value);
  return kind === 'blocked' ? 'blocked' : kind;
}
