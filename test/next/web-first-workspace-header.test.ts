import {describe,it,expect} from 'vitest';
import {renderWorkspaceHeader} from '../../src/main/next/web-first/workspace-header.js';
describe('privilege-free workspace orientation bar',()=>{
  it('offers clear native navigation without overstating server authorization',()=>{
    expect(renderWorkspaceHeader('REMOTE_CONNECTED')).toContain('工具发布待核验');
    expect(renderWorkspaceHeader('REMOTE_CONNECTED')).toContain('⌘ ⇧ G');
    expect(renderWorkspaceHeader('HOLD')).toContain('Core 连接需检查');
    expect(renderWorkspaceHeader('UNCONNECTED')).toContain('Core 尚未连接');
    expect(renderWorkspaceHeader('REMOTE_CONNECTED')).toContain("default-src 'none'");
  });
});
