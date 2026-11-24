import { hostname } from 'node:os';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { isIP } from 'node:net';
import type { Device, Settings, ScreenPlacement } from '../shared/types';
import { fingerprint, identityId } from './identity';

export interface TrustedPeer { device: Device; publicKey: string; tlsFingerprint: string }
export interface SavedState { version: 1; settings: Settings; peers: TrustedPeer[]; layout: ScreenPlacement[] }
export class Store {
  state: SavedState;
  private pending: Promise<void> = Promise.resolve();
  constructor(private directory: string, private localId: string) {
    this.state = { version: 1, settings: {
      deviceName: hostname(), engine: { executablePath: '', role: 'server', port: 24800, screenName: localId, serverDeviceId: null, autoStart: false },
      startMinimized: false, closeToTray: true, discoveryEnabled: true,
      clipboardSharing: false, macControlAsCommand: false,
    }, peers: [], layout: [{ deviceId: localId, x: 0, y: 0 }] };
  }
  async load(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      const saved: unknown = JSON.parse(await readFile(join(this.directory, 'settings.json'), 'utf8'));
      if (!isRecord(saved) || saved.version !== 1 || !Array.isArray(saved.peers) || saved.peers.length > 256 || !Array.isArray(saved.layout)) throw new Error('Formato de preferências incompatível.');
      if (!isRecord(saved.settings) || !isRecord(saved.settings.engine) ||
        !['deviceName', 'engine', 'startMinimized', 'closeToTray', 'discoveryEnabled'].every(key => Object.hasOwn(saved.settings as object, key)) ||
        !['executablePath', 'role', 'port', 'screenName', 'serverDeviceId', 'autoStart'].every(key => Object.hasOwn((saved.settings as Record<string, unknown>).engine as object, key))) {
        throw new Error('Preferências salvas incompletas.');
      }
      const settings = validateSettings(this.state.settings, saved.settings as unknown as Settings);
      const peers = saved.peers.map(validateTrustedPeer);
      const knownIds = new Set([this.localId]);
      for (const peer of peers) {
        if (knownIds.has(peer.device.id)) throw new Error('Identidade duplicada nos aparelhos pareados.');
        knownIds.add(peer.device.id);
      }
      if (settings.engine.serverDeviceId !== null && (settings.engine.serverDeviceId === this.localId || !knownIds.has(settings.engine.serverDeviceId))) throw new Error('O servidor salvo não é um aparelho pareado.');
      const layout = validateLayout(saved.layout, knownIds, this.localId);
      // Commit only after every field has passed validation. Invalid files remain untouched.
      this.state = { version: 1, settings, peers, layout };
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  save(): Promise<void> {
    const content = JSON.stringify(this.state, null, 2);
    this.pending = this.pending.catch(() => {}).then(async () => {
      const path = join(this.directory, 'settings.json');
      await writeFile(path + '.tmp', content, { encoding: 'utf8', mode: 0o600 });
      await rename(path + '.tmp', path);
    });
    return this.pending;
  }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function pick<T extends object>(value: Record<string, unknown>, keys: (keyof T)[]): Partial<T> {
  return Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key as string]])) as Partial<T>;
}
function normalizeCertificatePin(value: unknown): string {
  if (typeof value !== 'string' || !/^(?:[a-fA-F0-9]{64}|(?:[a-fA-F0-9]{2}:){31}[a-fA-F0-9]{2})$/.test(value)) throw new Error('Certificado salvo inválido.');
  return value.replace(/:/g, '').toLowerCase();
}
function validateTrustedPeer(value: unknown): TrustedPeer {
  if (!isRecord(value) || !isRecord(value.device) || typeof value.publicKey !== 'string' || value.publicKey.length > 1024) throw new Error('Pareamento salvo inválido.');
  const d = value.device;
  const actualFingerprint = fingerprint(value.publicKey);
  if (d.id !== identityId(value.publicKey) || d.fingerprint !== actualFingerprint) throw new Error('Identidade salva inconsistente.');
  if (typeof d.name !== 'string' || !d.name.trim() || d.name.length > 64 || /[\x00-\x1f\x7f]/.test(d.name) ||
    typeof d.hostname !== 'string' || !d.hostname || d.hostname.length > 255 || /[\x00-\x1f\x7f]/.test(d.hostname)) throw new Error('Nome de aparelho salvo inválido.');
  if (!['win32', 'darwin', 'linux'].includes(d.platform as string) || !['server', 'client'].includes(d.role as string)) throw new Error('Aparelho salvo inválido.');
  if (![d.controlPort, d.inputPort].every(port => Number.isInteger(port) && (port as number) > 0 && (port as number) <= 65535)) throw new Error('Porta de aparelho salvo inválida.');
  if (!Array.isArray(d.addresses) || d.addresses.length > 32 || !d.addresses.every(address => typeof address === 'string' && isIP(address) === 4)) throw new Error('Endereço de aparelho salvo inválido.');
  if (typeof d.online !== 'boolean' || d.paired !== true || typeof d.engineAvailable !== 'boolean' || !Number.isFinite(d.lastSeen) || (d.lastSeen as number) < 0) throw new Error('Estado de aparelho salvo inválido.');
  const tlsFingerprint = normalizeCertificatePin(value.tlsFingerprint);
  const engineFingerprint = d.engineFingerprint === undefined ? undefined : normalizeCertificatePin(d.engineFingerprint);
  if (engineFingerprint && engineFingerprint !== tlsFingerprint) throw new Error('O certificado do motor salvo não corresponde ao pareamento.');
  return {
    publicKey: value.publicKey, tlsFingerprint,
    device: {
      id: d.id as string, name: d.name, platform: d.platform as Device['platform'], hostname: d.hostname,
      addresses: [...new Set(d.addresses as string[])], controlPort: d.controlPort as number,
      inputPort: d.inputPort as number, online: false, lastSeen: d.lastSeen as number,
      paired: true, fingerprint: actualFingerprint, engineFingerprint,
      engineAvailable: d.engineAvailable, role: d.role as Device['role'],
    },
  };
}
export function validateSettings(current: Settings, patch: Partial<Settings>): Settings {
  if (!isRecord(patch) || (Object.hasOwn(patch, 'engine') && !isRecord(patch.engine))) throw new Error('Preferências inválidas.');
  const settings = {
    ...current, ...pick<Settings>(patch, ['deviceName', 'startMinimized', 'closeToTray', 'discoveryEnabled', 'clipboardSharing', 'macControlAsCommand']),
    engine: { ...current.engine, ...pick<Settings['engine']>((patch.engine ?? {}) as Record<string, unknown>, ['executablePath', 'role', 'port', 'serverDeviceId', 'autoStart']) },
  };
  if (typeof settings.deviceName !== 'string' || !settings.deviceName.trim() || settings.deviceName.length > 64 || /[\r\n\x00-\x1f\x7f]/.test(settings.deviceName)) throw new Error('Use um nome com 1 a 64 caracteres.');
  settings.deviceName = settings.deviceName.trim();
  const engine = settings.engine;
  if (!['server', 'client'].includes(engine.role)) throw new Error('Modo inválido.');
  if (!Number.isInteger(engine.port) || engine.port < 1024 || engine.port > 65535) throw new Error('A porta deve estar entre 1024 e 65535.');
  if (typeof engine.executablePath !== 'string' || engine.executablePath.length > 4096 || engine.executablePath.includes('\0')) throw new Error('Caminho inválido.');
  if (engine.serverDeviceId !== null && (typeof engine.serverDeviceId !== 'string' || !/^[a-f0-9]{32}$/.test(engine.serverDeviceId))) throw new Error('Servidor inválido.');
  for (const value of [settings.startMinimized, settings.closeToTray, settings.discoveryEnabled, settings.clipboardSharing, settings.macControlAsCommand, engine.autoStart]) if (typeof value !== 'boolean') throw new Error('Preferência inválida.');
  engine.screenName = current.engine.screenName;
  return settings;
}
export function validateLayout(layout: ScreenPlacement[], knownIds: Set<string>, localId?: string): ScreenPlacement[] {
  if (!Array.isArray(layout) || layout.length === 0 || layout.length > 32) throw new Error('Layout inválido.');
  const occupied = new Set<string>(), devices = new Set<string>();
  for (const placement of layout) {
    if (!isRecord(placement) || !knownIds.has(placement.deviceId as string) || devices.has(placement.deviceId as string)) throw new Error('Dispositivo inválido no layout.');
    if (![placement.x, placement.y].every(n => Number.isInteger(n) && Math.abs(n) <= 8)) throw new Error('Posição de tela inválida.');
    const cell = `${placement.x},${placement.y}`;
    if (occupied.has(cell)) throw new Error('Duas telas não podem ocupar a mesma posição.');
    occupied.add(cell); devices.add(placement.deviceId);
  }
  if (localId && !devices.has(localId)) throw new Error('A tela deste computador precisa estar no layout.');
  return layout.map(({ deviceId, x, y }) => ({ deviceId, x, y }));
}
