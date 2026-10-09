import {describe,it,expect} from 'vitest';
import {classifyRequest,redactedNetworkError,newWebHealthTracker,safeApiRouteClass} from '../../src/main/next/web-first/web-health.js';
describe('privacy-safe post-login Web-First HTTP diagnostics',()=>{
  it('classifies exact trusted domains but never returns sensitive path or query',()=>{
    expect(classifyRequest('https://chatgpt.com/backend-api/conversation?access_token=TOPSECRET')).toBe('chatgpt-api');
    expect(classifyRequest('https://chatgpt.com/c/PRIVATE_CONVERSATION')).toBe('chatgpt-shell');
    expect(classifyRequest('https://auth.openai.com/authorize?code=SECRET')).toBe('openai-login');
    expect(classifyRequest('https://chatgpt.com.evil.test/backend-api/')).toBe('other');
  });
  it('retains status aggregates and standard errors, not private URLs/response text',()=>{
    const health=newWebHealthTracker();
    health.completed('https://chatgpt.com/backend-api/conversation?auth=PRIVATE',401);
    health.completed('https://chatgpt.com/backend-api/settings',200);
    health.failed('https://auth.openai.com/auth?ticket=SECRET','net::ERR_CONNECTION_RESET: auth SECRET');
    const out=health.snapshot();
    expect(out.requests['chatgpt-api']).toMatchObject({total:2,success:1,http4xx:1});
    expect(out.requests['openai-login'].failed).toBe(1);
    expect(out.httpFailures).toMatchObject({'other-chatgpt-api:401':1});
    expect(safeApiRouteClass('https://chatgpt.com/backend-api/conversations?ticket=PRIVATE')).toBe('conversation-list');
    expect(out.lastNetworkError).toBe('ERR_CONNECTION_RESET');
    expect(JSON.stringify(out)).not.toMatch(/PRIVATE|SECRET|ticket|access_token|authorization/i);
    expect(redactedNetworkError('https://private.example SECRET')).toBe('NETWORK_ERROR_UNCLASSIFIED');
  });
});
