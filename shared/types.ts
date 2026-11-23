export type Platform = 'win32' | 'darwin' | 'linux';
export interface Device {
  id: string; name: string; platform: Platform; hostname: string; addresses: string[];
  controlPort: number; inputPort: number; online: boolean; lastSeen: number; paired: boolean;
  fingerprint: string; engineFingerprint?: string; engineAvailable: boolean; role: 'server' | 'client';
}
export interface EngineSettings {
  executablePath: string; role: 'server' | 'client'; port: number; screenName: string;
  serverDeviceId: string | null; autoStart: boolean;
}
export interface Settings {
  deviceName: string; engine: EngineSettings; startMinimized: boolean;
  closeToTray: boolean; discoveryEnabled: boolean;
}
export interface ScreenPlacement { deviceId: string; x: number; y: number }
export interface EngineStatus {
  status: 'stopped' | 'starting' | 'running' | 'error'; message: string;
  version: string | null; executablePath: string | null; logs: string[];
}
export interface AppState {
  local: Device; devices: Device[]; settings: Settings; engine: EngineStatus;
  discovery: { active: boolean; error: string | null }; layout: ScreenPlacement[];
  latency: Record<string, number>; notices: string[];
}
export interface PairInvite { code: string; expiresAt: number }
export interface HeyMouseBridge {
  getState(): Promise<AppState>;
  onState(listener: (state: AppState) => void): () => void;
  updateSettings(patch: Partial<Settings>): Promise<AppState>;
  setLayout(layout: ScreenPlacement[]): Promise<AppState>;
  refreshDiscovery(): Promise<void>;
  createInvite(): Promise<PairInvite>;
  pair(code: string): Promise<AppState>;
  forgetDevice(id: string): Promise<AppState>;
  startSharing(): Promise<AppState>;
  stopSharing(): Promise<AppState>;
  selectEngine(): Promise<AppState>;
  openExternal(url: string): Promise<void>;
  copyText(text: string): Promise<void>;
}
