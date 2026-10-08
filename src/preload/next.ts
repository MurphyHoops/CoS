import { contextBridge, ipcRenderer } from 'electron';
import type { NextUiBridge } from '../shared/next-ui.js';

/**
 * Next renderer receives only a fixed, typed, serialization-safe control plane.
 * Never expose arbitrary ipcRenderer, FS, shell, credentials or raw MCP metadata.
 */
const bridge: NextUiBridge = Object.freeze({
  status: () => ipcRenderer.invoke('next-ui:status'),
  catalog: () => ipcRenderer.invoke('next-ui:catalog'),
  chooseProject: () => ipcRenderer.invoke('next-ui:choose-project'),
  createMission: (projectId: string, checks: string[]) =>
    ipcRenderer.invoke('next-ui:create-mission', projectId, checks),
  connectCore: () => ipcRenderer.invoke('next-ui:connect-core'),
  disconnectCore: () => ipcRenderer.invoke('next-ui:disconnect-core')
});
contextBridge.exposeInMainWorld('cosNext', bridge);
