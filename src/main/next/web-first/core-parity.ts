/** Do not silently drop Classic Core's coding surface in Web-First migration. */
import {SURFACES} from '../../mcp/surfaces.js';
import {WEBFIRST_CORE_TOOLS} from './project-mcp.js';
export type MigrationStage='available'|'planned-native'|'conditional-identity'|'optional-agent';
export const CLASSIC_CORE_MIGRATION:ReadonlyArray<{name:string;stage:MigrationStage}>=Object.freeze([
  {name:'runtime_health',stage:'available'},
  {name:'identity_diagnostics',stage:'available'},
  {name:'read',stage:'planned-native'},
  {name:'view_image',stage:'planned-native'},
  {name:'find',stage:'planned-native'},
  {name:'apply_patch',stage:'conditional-identity'},
  {name:'exec_command',stage:'conditional-identity'},
  {name:'write_stdin',stage:'conditional-identity'},
  {name:'update_plan',stage:'planned-native'},
  {name:'project_runtime',stage:'planned-native'},
  {name:'session_wait',stage:'planned-native'},
  {name:'agents',stage:'optional-agent'},
  {name:'session_finish',stage:'conditional-identity'},
  {name:'exec',stage:'conditional-identity'}
]);
export function coreMigrationAudit(){
  const expected=new Set(SURFACES.core.tools);
  const declared=new Set(CLASSIC_CORE_MIGRATION.map(x=>x.name));
  const missingLegacy=[...expected].filter(x=>!declared.has(x));
  const unexpectedLegacy=[...declared].filter(x=>!expected.has(x));
  const available=new Set(WEBFIRST_CORE_TOOLS);
  return {
    missingLegacy,unexpectedLegacy,
    available:[...expected].filter(x=>available.has(x)),
    pending:[...expected].filter(x=>!available.has(x)),
    webfirstOnly:WEBFIRST_CORE_TOOLS.filter(x=>!expected.has(x))
  };
}
