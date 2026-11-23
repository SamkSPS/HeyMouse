import { contextBridge, ipcRenderer } from 'electron';
import type { AppState, HeyMouseBridge, Settings, ScreenPlacement } from '../shared/types';
const api: HeyMouseBridge = {
  getState: () => ipcRenderer.invoke('heymouse:state'),
  onState: listener => { const handler = (_event: unknown, state: AppState) => listener(state); ipcRenderer.on('heymouse:state', handler); return () => ipcRenderer.removeListener('heymouse:state', handler); },
  updateSettings: (patch: Partial<Settings>) => ipcRenderer.invoke('heymouse:settings', patch),
  setLayout: (layout: ScreenPlacement[]) => ipcRenderer.invoke('heymouse:layout', layout),
  refreshDiscovery: () => ipcRenderer.invoke('heymouse:refresh'),
  createInvite: () => ipcRenderer.invoke('heymouse:invite'),
  pair: (code: string) => ipcRenderer.invoke('heymouse:pair', code),
  forgetDevice: (id: string) => ipcRenderer.invoke('heymouse:forget', id),
  startSharing: () => ipcRenderer.invoke('heymouse:start'),
  stopSharing: () => ipcRenderer.invoke('heymouse:stop'),
  selectEngine: () => ipcRenderer.invoke('heymouse:select-engine'),
  openExternal: (url: string) => ipcRenderer.invoke('heymouse:external', url),
  copyText: (text: string) => ipcRenderer.invoke('heymouse:copy', text),
};
contextBridge.exposeInMainWorld('heymouse', api);
