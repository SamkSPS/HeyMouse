import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, shell, Tray, type IpcMainInvokeEvent } from 'electron';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { pathToFileURL } from 'node:url';
import type { AppState, Device, Settings, ScreenPlacement } from '../shared/types';
import { certificateFingerprint, fingerprint, identityId, loadIdentity, signPayload, verifyPayload, type Identity } from './identity';
import { Store, validateLayout, validateSettings, type TrustedPeer } from './store';
import { Discovery, ipv4Interfaces, type DiscoveredDevice } from './discovery';
import { ControlServer } from './control';
import { EngineManager, engineScreenName } from './engine';

app.setName('HeyMouse');
if (process.env.HEYMOUSE_DATA_DIR) app.setPath('userData', process.env.HEYMOUSE_DATA_DIR);
const hasLock = app.requestSingleInstanceLock();
if (!hasLock) app.quit();
let window: BrowserWindow | null = null, tray: Tray | null = null;
let closing = false, sharingWanted = false, polling = false;
let identity: Identity, store: Store, engine: EngineManager, discovery: Discovery, control: ControlServer;
let localId = '', engineAvailable = false;
let discoveryStatus: AppState['discovery'] = { active: false, error: null };
const discovered = new Map<string, Device>();
const latency: Record<string, number> = {};
const notices: string[] = [];
let pollTimer: ReturnType<typeof setInterval> | undefined, publishTimer: ReturnType<typeof setTimeout> | undefined;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let mutations: Promise<unknown> = Promise.resolve();
function enqueue<T>(fn: () => Promise<T>): Promise<T> { const task = mutations.then(fn); mutations = task.catch(() => {}); return task; }
function notice(message: string) { if (!notices.includes(message)) { notices.push(message); if (notices.length > 5) notices.shift(); } publish(); }
function localDevice(): Device {
  return {
    id: localId, name: store.state.settings.deviceName, platform: process.platform as Device['platform'], hostname: hostname(),
    addresses: ipv4Interfaces(), controlPort: control?.port || 47856, inputPort: store.state.settings.engine.port,
    online: true, lastSeen: Date.now(), paired: true, fingerprint: fingerprint(identity.publicKey),
    engineFingerprint: certificateFingerprint(identity.certificate), engineAvailable, role: store.state.settings.engine.role,
  };
}
function state(): AppState {
  const peers = store.state.peers.map(peer => peer.device);
  return { local: localDevice(), devices: [...peers, ...[...discovered.values()].filter(d => !peers.some(p => p.id === d.id))],
    settings: store.state.settings, engine: engine.getStatus(), discovery: discoveryStatus,
    layout: store.state.layout, latency: { ...latency }, notices: [...notices] };
}
function publish() {
  if (publishTimer || !store || !engine) return;
  publishTimer = setTimeout(() => {
    publishTimer = undefined;
    if (window && !window.isDestroyed()) window.webContents.send('heymouse:state', state());
    if (tray) tray.setToolTip(`HeyMouse · ${engine.getStatus().status === 'running' ? 'compartilhando' : 'pausado'}`);
  }, 80);
}
async function persist() { await store.save(); publish(); }
function addPlacement(id: string) {
  if (store.state.layout.some(p => p.deviceId === id)) return;
  const used = new Set(store.state.layout.map(p => `${p.x},${p.y}`));
  for (let y = 0; y <= 8; y++) for (let x = 0; x <= 8; x++) if (!used.has(`${x},${y}`)) { store.state.layout.push({ deviceId: id, x, y }); return; }
  throw new Error('Limite de posições do layout atingido.');
}
async function paired(peer: TrustedPeer) {
  const index = store.state.peers.findIndex(p => p.device.id === peer.device.id);
  if (index === -1 && store.state.peers.length >= 31) throw new Error('Limite de 32 computadores atingido.');
  if (index >= 0) store.state.peers[index] = peer; else store.state.peers.push(peer);
  discovered.delete(peer.device.id); addPlacement(peer.device.id);
  await persist(); discovery?.refresh(); scheduleRestart();
}
function engineOptions() {
  return { settings: store.state.settings.engine, localDeviceId: localId, devices: store.state.peers.map(p => p.device),
    layout: store.state.layout, certificatePem: identity.tlsKey + '\n' + identity.certificate, clipboardSharing: false };
}
async function startSharing() {
  if (store.state.settings.engine.role === 'client') {
    const server = store.state.peers.find(p => p.device.id === store.state.settings.engine.serverDeviceId);
    if (!server) throw new Error('Escolha o computador que fornece o mouse e teclado em Configurações.');
    if (server.device.role !== 'server') throw new Error('O computador escolhido também está em modo receptor. Ative o modo servidor nele.');
  }
  await engine.start(engineOptions()); sharingWanted = true; publish();
}
function scheduleRestart() {
  if (!sharingWanted || closing) return;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    void enqueue(async () => { if (sharingWanted && !closing) await engine.start(engineOptions()); }).catch(error => notice(error.message));
  }, 750);
}
function onDiscovered(device: DiscoveredDevice) {
  if (device.id === localId) return;
  const peer = store.state.peers.find(p => p.device.id === device.id);
  if (peer) {
    if (fingerprint(peer.publicKey) !== fingerprint(device.publicKey) || (device.engineFingerprint && device.engineFingerprint.replace(/:/g, '').toLowerCase() !== peer.tlsFingerprint)) {
      notice(`A identidade de ${peer.device.name} mudou. Refaça o pareamento nesse computador.`); return;
    }
    const changed = peer.device.addresses[0] !== device.addresses[0] || peer.device.inputPort !== device.inputPort || peer.device.controlPort !== device.controlPort;
    const { publicKey: _key, inviteProof: _proof, ...publicDevice } = device;
    peer.device = { ...publicDevice, paired: true, engineFingerprint: peer.tlsFingerprint };
    if (changed) {
      void persist().catch(error => notice(error.message));
      if (store.state.settings.engine.role === 'client' && store.state.settings.engine.serverDeviceId === device.id) scheduleRestart();
    }
  } else { const { publicKey: _key, inviteProof: _proof, ...publicDevice } = device; discovered.set(device.id, publicDevice); }
  publish();
}
async function pollPeers() {
  if (polling || closing) return; polling = true;
  try {
    await Promise.allSettled(store.state.peers.map(async peer => {
      try {
        const response = await control.ping(peer);
        if (!store.state.peers.includes(peer)) return;
        const changed = peer.device.addresses[0] !== response.device.addresses[0] || peer.device.inputPort !== response.device.inputPort;
        peer.device = response.device; latency[peer.device.id] = response.latency;
        if (changed) {
          await persist();
          if (store.state.settings.engine.serverDeviceId === peer.device.id) scheduleRestart();
        }
      } catch {
        if (Date.now() - peer.device.lastSeen > 15000) peer.device.online = false;
        delete latency[peer.device.id];
      }
    }));
  } finally { polling = false; publish(); }
}
const rendererFile = join(__dirname, '../dist/index.html');
const devUrl = !app.isPackaged ? process.env.HEYMOUSE_DEV_URL : undefined;
function validSender(event: IpcMainInvokeEvent) {
  return window && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame &&
    (devUrl ? event.senderFrame?.url.startsWith(devUrl + '/') : event.senderFrame?.url === pathToFileURL(rendererFile).href);
}
function bind(channel: string, handler: (...args: any[]) => unknown, serial = true) {
  ipcMain.handle(`heymouse:${channel}`, (event, ...args) => {
    if (!validSender(event)) throw new Error('Origem não autorizada.');
    return serial ? enqueue(async () => handler(...args)) : handler(...args);
  });
}
function registerIpc() {
  bind('state', () => state(), false);
  bind('settings', async (patch: Partial<Settings>) => {
    const current = store.state.settings;
    const next = validateSettings(current, patch);
    if (next.engine.serverDeviceId && !store.state.peers.some(p => p.device.id === next.engine.serverDeviceId)) throw new Error('Selecione um computador pareado.');
    const engineChanged = JSON.stringify(current.engine) !== JSON.stringify(next.engine);
    store.state.settings = next;
    if (current.discoveryEnabled !== next.discoveryEnabled) {
      if (next.discoveryEnabled) await discovery.start().catch(error => notice(error.message)); else discovery.stop();
    }
    if (current.engine.executablePath !== next.engine.executablePath) engineAvailable = (await engine.detect(next.engine.executablePath)).available;
    await persist(); discovery.refresh(); if (engineChanged) scheduleRestart(); return state();
  });
  bind('layout', async (layout: ScreenPlacement[]) => {
    const known = new Set([localId, ...store.state.peers.map(p => p.device.id)]);
    store.state.layout = validateLayout(layout, known, localId);
    await persist(); scheduleRestart(); return state();
  });
  bind('refresh', async () => { discovery.refresh(); await pollPeers(); });
  bind('invite', () => {
    if (!discoveryStatus.active) throw new Error('Ative a descoberta automática em Configurações antes de gerar um código.');
    const invite = control.createInvite();
    discovery.refresh();
    return invite;
  });
  bind('pair', async (code: string) => { await control.pair(code); return state(); });
  bind('forget', async (id: string) => {
    if (typeof id !== 'string') throw new Error('Dispositivo inválido.');
    store.state.peers = store.state.peers.filter(p => p.device.id !== id);
    store.state.layout = store.state.layout.filter(p => p.deviceId !== id);
    if (store.state.settings.engine.serverDeviceId === id) { store.state.settings.engine.serverDeviceId = null; sharingWanted = false; await engine.stop(); }
    delete latency[id]; await persist();
    // Rewrite trust immediately for a running server, revoking existing input connections.
    if (sharingWanted) await engine.start(engineOptions());
    return state();
  });
  bind('start', async () => { await startSharing(); return state(); });
  bind('stop', async () => { sharingWanted = false; if (reconnectTimer) clearTimeout(reconnectTimer); await engine.stop(); publish(); return state(); });
  bind('select-engine', async () => {
    const result = await dialog.showOpenDialog(window!, { title: 'Selecionar motor Deskflow 1.27', properties: ['openFile'], filters: process.platform === 'win32' ? [{ name: 'Deskflow core', extensions: ['exe'] }] : [] });
    if (!result.canceled && result.filePaths[0]) {
      const detected = await engine.detect(result.filePaths[0]);
      if (!detected.available) throw new Error(detected.message);
      store.state.settings.engine.executablePath = result.filePaths[0]; engineAvailable = true; await persist(); discovery.refresh(); scheduleRestart();
    }
    return state();
  });
  bind('copy', (text: string) => { if (typeof text !== 'string' || text.length > 32768) throw new Error('Texto inválido.'); clipboard.writeText(text); });
  bind('external', async (url: string) => {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !['deskflow.org', 'github.com'].includes(parsed.hostname) || parsed.username || parsed.password) throw new Error('Link não permitido.');
    await shell.openExternal(parsed.href);
  });
}
async function createWindow() {
  window = new BrowserWindow({ width: 1280, height: 850, minWidth: 1000, minHeight: 700, show: false,
    title: 'HeyMouse', backgroundColor: '#101114', autoHideMenuBar: true,
    icon: join(__dirname, '../dist/icon.png'),
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.on('close', event => { if (!closing && store.state.settings.closeToTray && tray) { event.preventDefault(); window?.hide(); } });
  window.on('closed', () => { window = null; });
  window.once('ready-to-show', () => {
    window?.show();
    if (store.state.settings.startMinimized) window?.minimize();
  });
  if (devUrl) await window.loadURL(devUrl); else await window.loadFile(rendererFile);
}
function createTray() {
  const icon = nativeImage.createFromPath(join(__dirname, '../dist/icon.png')).resize({ width: 20, height: 20 });
  if (icon.isEmpty()) return;
  tray = new Tray(icon);
  tray.setToolTip('HeyMouse');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Abrir HeyMouse', click: () => window?.show() },
    { label: 'Pausar compartilhamento', click: () => { sharingWanted = false; void enqueue(() => engine.stop()).catch(error => notice(error.message)); } },
    { type: 'separator' }, { label: 'Sair', click: () => app.quit() },
  ]));
  tray.on('double-click', () => window?.show());
}
async function boot() {
  identity = await loadIdentity(app.getPath('userData')); localId = identityId(identity.publicKey);
  store = new Store(app.getPath('userData'), localId); await store.load();
  store.state.settings.engine.screenName = engineScreenName(localId);
  engine = new EngineManager({ dataDir: app.getPath('userData'), resourcesDir: app.isPackaged ? join(process.resourcesPath, 'engine') : join(app.getAppPath(), 'resources/engine'), onStatus: publish, onLog: publish });
  control = new ControlServer({ identity, getDevice: localDevice, getDiscovered: () => discovery?.devices() ?? [], getPeer: id => store.state.peers.find(p => p.device.id === id), onPair: paired });
  try { await control.start(); } catch (error) { notice(`Pareamento indisponível: ${(error as Error).message}`); }
  engineAvailable = (await engine.detect(store.state.settings.engine.executablePath)).available;
  discovery = new Discovery({ getAnnouncement: () => ({ ...localDevice(), publicKey: identity.publicKey, inviteProof: control.inviteProof() }), sign: payload => signPayload(payload, identity.privateKey), verify: verifyPayload });
  discovery.on('device', onDiscovered);
  discovery.on('status', status => { discoveryStatus = status; publish(); });
  discovery.on('offline', (id: string) => { const peer = store.state.peers.find(p => p.device.id === id); if (peer && Date.now() - peer.device.lastSeen > 14000) peer.device.online = false; discovered.delete(id); delete latency[id]; publish(); });
  registerIpc(); await createWindow(); createTray();
  if (store.state.settings.discoveryEnabled) await discovery.start().catch(error => notice(error.message));
  pollTimer = setInterval(() => { void pollPeers(); }, 5000); void pollPeers();
  if (store.state.settings.engine.autoStart) await startSharing().catch(error => notice(error.message));
}
app.on('second-instance', () => { window?.show(); window?.focus(); });
app.on('activate', () => { if (window) window.show(); else if (store) void createWindow(); });
app.on('window-all-closed', () => { if (!tray) app.quit(); });
app.on('before-quit', event => {
  if (closing) return; event.preventDefault(); closing = true; sharingWanted = false;
  if (pollTimer) clearInterval(pollTimer); if (reconnectTimer) clearTimeout(reconnectTimer); if (publishTimer) clearTimeout(publishTimer);
  discovery?.stop();
  void Promise.allSettled([engine?.stop(), control?.stop(), store?.save()]).finally(() => { tray?.destroy(); tray = null; app.quit(); });
});
if (hasLock) app.whenReady().then(boot).catch(error => {
  dialog.showErrorBox('HeyMouse não conseguiu iniciar', error instanceof Error ? error.message : String(error)); app.quit();
});
