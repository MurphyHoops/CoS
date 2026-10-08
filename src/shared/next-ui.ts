/** Public, intentionally bounded local-only UI contract. */
export type NextUiStatus = {
  runtime: 'OFF' | 'STARTING' | 'READY' | 'REAPPROVAL_REQUIRED' | 'HOLD' | 'STOPPING' | 'STOPPED';
  leases: string;
  journal: string;
  tunnel: 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED' | 'AUTH_REJECTED' | 'HOLD';
  keychain: 'AVAILABLE' | 'UNAVAILABLE';
  model: 'DISABLED';
  remoteAuthority: 'DISABLED';
  plugin: 'NOT_REQUIRED';
};
export type NextUiProject = { projectId: string; canonicalRoot: string };
export type NextUiMission = {
  missionId: string; projectId: string; state: string; revision: number;
  epoch: number; completionChecks: readonly string[];
};
export type NextUiAgent = { agentId: string; missionId: string; state: string; epoch: number };
export type NextUiWait = {
  obligationId: string; missionId: string; state: string;
  kind: string; outcome: string; continuation: string;
};
export type NextUiCatalog = {
  projects: NextUiProject[];
  missions: NextUiMission[];
  workers: NextUiAgent[];
  obligations: NextUiWait[];
};
export type NextUiResult = { ok: boolean; reason?: string };
export interface NextUiBridge {
  status(): Promise<NextUiStatus>;
  catalog(): Promise<NextUiCatalog | null>;
  chooseProject(): Promise<NextUiResult>;
  createMission(projectId: string, checks: string[]): Promise<NextUiResult>;
  connectCore(): Promise<NextUiResult>;
  disconnectCore(): Promise<NextUiResult>;
}
