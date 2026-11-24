import { contextBridge, ipcRenderer, webUtils } from 'electron';
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
  sendFile: deviceId => ipcRenderer.invoke('heymouse:send-file', deviceId),
  sendDroppedFile: async (deviceId, file) => {
    const path = webUtils.getPathForFile(file);
    if (!path) throw new Error('Arraste um arquivo do Explorer ou do Finder.');
    return ipcRenderer.invoke('heymouse:send-file', deviceId, path);
  },
  onFileReceived: listener => {
    const handler = (_event: unknown, name: string) => listener(name);
    ipcRenderer.on('heymouse:file-received', handler);
    return () => ipcRenderer.removeListener('heymouse:file-received', handler);
  },
  onFileFeedback: listener => {
    const handler = (_event: unknown, message: string) => listener(message);
    ipcRenderer.on('heymouse:file-feedback', handler);
    return () => ipcRenderer.removeListener('heymouse:file-feedback', handler);
  },
};
contextBridge.exposeInMainWorld('heymouse', api);
