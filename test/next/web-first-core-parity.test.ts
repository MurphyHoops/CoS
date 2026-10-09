import {describe,it,expect} from 'vitest';
import {coreMigrationAudit,CLASSIC_CORE_MIGRATION} from '../../src/main/next/web-first/core-parity.js';
import {SURFACES} from '../../src/main/mcp/surfaces.js';
import {WEBFIRST_CORE_TOOLS} from '../../src/main/next/web-first/project-mcp.js';
describe('Core tool parity while migrating from Classic to native Web-First',()=>{
  it('explicitly tracks every existing Classic coding tool without deletion',()=>{
    const audit=coreMigrationAudit();
    expect(audit.missingLegacy).toEqual([]);
    expect(audit.unexpectedLegacy).toEqual([]);
    expect(CLASSIC_CORE_MIGRATION.length).toBe(SURFACES.core.tools.length);
  });
  it('never declares unavailable write/execute/agent capabilities as supported',()=>{
    const available=new Set(WEBFIRST_CORE_TOOLS);
    expect(available.has('apply_patch')).toBe(false);
    expect(available.has('exec_command')).toBe(false);
    expect(available.has('session_finish')).toBe(false);
    expect(available.has('runtime_health')).toBe(true);
    expect(available.has('project_read')).toBe(true);
    expect(available.has('task_wait')).toBe(true);
  });
});
