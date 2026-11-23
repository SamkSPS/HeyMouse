import { createHash, createPublicKey, randomBytes } from 'node:crypto';
import { createSocket, type Socket } from 'node:dgram';
import { EventEmitter } from 'node:events';
import { isIPv4 } from 'node:net';
import { networkInterfaces } from 'node:os';
import type { Device } from '../shared/types.js';

export const DISCOVERY_GROUP = '239.77.79.85';
export const DISCOVERY_PORT = 47855;
export const ANNOUNCEMENT_INTERVAL = 3_000;
export const OFFLINE_AFTER = 15_000;
export const MAX_PACKET_BYTES = 12_000;
const MAX_CLOCK_SKEW = 120_000;
const MAX_PEERS = 256;
const MAX_REPLAY_ENTRIES = 4_096;

export interface Announcement {
  id: string;
  name: string;
  platform: Device['platform'];
  hostname: string;
  controlPort: number;
  inputPort: number;
  fingerprint: string;
  engineFingerprint?: string;
  pairingSession?: string;
  engineAvailable: boolean;
  role: Device['role'];
  publicKey: string;
}

export interface DiscoveredDevice extends Device {
  pairingSession?: string;
  publicKey: string;
}

interface Payload {
  protocol: 'heymouse-discovery';
  version: 1;
  sentAt: number;
  nonce: string;
  device: Announcement;
}

type Sign = (payload: string) => string;
type Verify = (payload: string, signature: string, publicKey: string) => boolean;

export interface DiscoveryOptions {
  getAnnouncement: () => Announcement;
  sign: Sign;
  verify: Verify;
  /** Injection for deterministic tests and explicitly constrained deployments. */
  interfaces?: () => string[];
  now?: () => number;
}

export function publicKeyFingerprint(publicKey: string): string {
  const key = createPublicKey(publicKey);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('A identidade deve usar Ed25519.');
  return createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex');
}

function isText(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\u0000-\u001f\u007f]/.test(value);
}

function isPort(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0 && (value as number) <= 65535;
}

function parseAnnouncement(value: unknown): Announcement | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const a = value as Record<string, unknown>;
  if (
    !isText(a.id, 32) || !/^[a-f0-9]{32}$/.test(a.id) ||
    !isText(a.name, 80) || !isText(a.hostname, 255) ||
    !['win32', 'darwin', 'linux'].includes(a.platform as string) ||
    !isPort(a.controlPort) || !isPort(a.inputPort) ||
    typeof a.engineAvailable !== 'boolean' || !['server', 'client'].includes(a.role as string) ||
    typeof a.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(a.fingerprint) ||
    typeof a.publicKey !== 'string' || a.publicKey.length > 512 ||
    (a.pairingSession !== undefined && (typeof a.pairingSession !== 'string' || !/^[a-f0-9]{64}$/.test(a.pairingSession))) ||
    (a.engineFingerprint !== undefined && (typeof a.engineFingerprint !== 'string' || !/^(?:[a-fA-F0-9]{64}|(?:[a-fA-F0-9]{2}:){31}[a-fA-F0-9]{2})$/.test(a.engineFingerprint)))
  ) return null;
  try {
    const fingerprint = publicKeyFingerprint(a.publicKey);
    if (a.fingerprint !== fingerprint || a.id !== fingerprint.slice(0, 32)) return null;
  } catch {
    return null;
  }
  // Construct a fresh object; never pass arbitrary network fields to the application.
  return {
    id: a.id, name: a.name, hostname: a.hostname,
    platform: a.platform as Announcement['platform'], controlPort: a.controlPort,
    inputPort: a.inputPort, fingerprint: a.fingerprint,
    engineFingerprint: a.engineFingerprint as string | undefined,
    ...(typeof a.pairingSession === 'string' ? { pairingSession: a.pairingSession } : {}),
    engineAvailable: a.engineAvailable, role: a.role as Announcement['role'], publicKey: a.publicKey,
  };
}

export function encodeAnnouncement(device: Announcement, sign: Sign, now = Date.now()): Buffer {
  if (!parseAnnouncement(device)) throw new Error('Identidade de descoberta inválida.');
  const payload = JSON.stringify({ protocol: 'heymouse-discovery', version: 1, sentAt: now, nonce: randomBytes(16).toString('hex'), device } satisfies Payload);
  const packet = Buffer.from(JSON.stringify({ payload, signature: sign(payload) }), 'utf8');
  if (packet.byteLength > MAX_PACKET_BYTES) throw new Error('Anúncio de descoberta excede o limite.');
  return packet;
}

export function decodeAnnouncement(packet: Uint8Array, verify: Verify, now = Date.now()): Payload | null {
  if (packet.byteLength === 0 || packet.byteLength > MAX_PACKET_BYTES) return null;
  try {
    const envelope: unknown = JSON.parse(Buffer.from(packet).toString('utf8'));
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return null;
    const { payload, signature } = envelope as Record<string, unknown>;
    if (typeof payload !== 'string' || typeof signature !== 'string' || signature.length > 256 || signature.length < 64) return null;
    const data: unknown = JSON.parse(payload);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    const value = data as Record<string, unknown>;
    if (value.protocol !== 'heymouse-discovery' || value.version !== 1 ||
      !Number.isSafeInteger(value.sentAt) || Math.abs(now - (value.sentAt as number)) > MAX_CLOCK_SKEW ||
      typeof value.nonce !== 'string' || !/^[a-f0-9]{32}$/.test(value.nonce)) return null;
    const device = parseAnnouncement(value.device);
    if (!device || !verify(payload, signature, device.publicKey)) return null;
    return { protocol: 'heymouse-discovery', version: 1, sentAt: value.sentAt as number, nonce: value.nonce, device };
  } catch {
    return null;
  }
}

export function ipv4Interfaces(): string[] {
  return [...new Set(Object.values(networkInterfaces()).flatMap((entries) =>
    (entries ?? []).filter((entry) => entry.family === 'IPv4' && !entry.internal).map((entry) => entry.address),
  ))];
}

function usableAddress(address: string): boolean {
  if (!isIPv4(address)) return false;
  const first = Number(address.split('.')[0]);
  return first > 0 && first !== 127 && first < 224;
}

interface PeerEntry {
  device: DiscoveredDevice;
  lastTimestamp: number;
  addresses: Map<string, number>;
}

/**
 * Signed LAN presence only. A discovered device is never trusted/paired here.
 * Pairing and pinned, authenticated control connections belong to the control service.
 */
export class Discovery extends EventEmitter {
  private receiver: Socket | null = null;
  private senders = new Map<string, Socket>();
  private memberships = new Set<string>();
  private peers = new Map<string, PeerEntry>();
  private replay = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private starting: Promise<void> | null = null;
  private generation = 0;
  private active = false;
  private now: () => number;

  constructor(private readonly options: DiscoveryOptions) {
    super();
    this.now = options.now ?? Date.now;
  }

  async start(): Promise<void> {
    if (this.starting) return this.starting;
    if (this.receiver) return;
    this.starting = this.startSocket();
    try { await this.starting; } finally { this.starting = null; }
  }

  private async startSocket(): Promise<void> {
    const generation = ++this.generation;
    const socket = createSocket({ type: 'udp4', reuseAddr: true });
    this.receiver = socket;
    socket.on('message', (packet, remote) => this.acceptPacket(packet, remote.address));
    socket.on('error', (error) => {
      if (this.receiver === socket) this.emit('status', { active: this.active, error: `Descoberta: ${error.message}` });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const failed = (error: Error) => { socket.removeListener('listening', ready); socket.removeListener('close', closed); reject(error); };
        const closed = () => failed(new Error('A descoberta foi encerrada durante a inicialização.'));
        const ready = () => { socket.removeListener('error', failed); socket.removeListener('close', closed); resolve(); };
        socket.once('error', failed);
        socket.once('close', closed);
        socket.once('listening', ready);
        socket.bind(DISCOVERY_PORT, '0.0.0.0');
      });
      if (generation !== this.generation || this.receiver !== socket) return;
      socket.setMulticastTTL(1);
      this.active = true;
      this.reconcileInterfaces();
      this.announce();
      this.timer = setInterval(() => {
        this.reconcileInterfaces();
        this.announce();
        this.expire();
      }, ANNOUNCEMENT_INTERVAL);
      this.timer.unref();
    } catch (error) {
      if (generation !== this.generation) return;
      if (this.receiver === socket) this.stop();
      this.emit('status', { active: false, error: `Não foi possível iniciar a descoberta: ${(error as Error).message}` });
      throw error;
    }
  }

  stop(): void {
    ++this.generation;
    this.active = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const receiver = this.receiver;
    this.receiver = null;
    if (receiver) { try { receiver.close(); } catch { /* Already closed. */ } }
    for (const socket of this.senders.values()) { try { socket.close(); } catch { /* Already closed. */ } }
    this.senders.clear();
    this.memberships.clear();
    for (const id of this.peers.keys()) this.emit('offline', id);
    this.peers.clear();
    this.replay.clear();
    this.emit('status', { active: false, error: null });
  }

  devices(): DiscoveredDevice[] {
    this.expire();
    return [...this.peers.values()].map(peer => peer.device);
  }

  refresh(): void {
    if (!this.active) return;
    this.reconcileInterfaces();
    this.announce();
    this.expire();
  }

  private reconcileInterfaces(): void {
    const receiver = this.receiver;
    if (!receiver || !this.active) return;
    const addresses = new Set((this.options.interfaces ?? ipv4Interfaces)().filter(usableAddress));
    for (const address of this.memberships) {
      if (addresses.has(address)) continue;
      try { receiver.dropMembership(DISCOVERY_GROUP, address); } catch { /* Interface already disappeared. */ }
      this.memberships.delete(address);
      const socket = this.senders.get(address);
      this.senders.delete(address);
      if (socket) { try { socket.close(); } catch { /* Already closed. */ } }
    }
    const errors: string[] = [];
    for (const address of addresses) {
      if (this.memberships.has(address)) continue;
      try {
        receiver.addMembership(DISCOVERY_GROUP, address);
        this.memberships.add(address);
        const sender = createSocket('udp4');
        const generation = this.generation;
        this.senders.set(address, sender);
        sender.on('error', () => {
          if (this.senders.get(address) !== sender) return;
          this.senders.delete(address);
          this.memberships.delete(address);
          try { receiver.dropMembership(DISCOVERY_GROUP, address); } catch { /* Retry next interval. */ }
          try { sender.close(); } catch { /* Already closed. */ }
        });
        sender.bind(0, address, () => {
          if (generation !== this.generation || this.senders.get(address) !== sender) return;
          try {
            sender.setMulticastInterface(address);
            sender.setMulticastTTL(1);
            this.sendPacket(sender);
          } catch { sender.emit('error', new Error('Interface indisponível.')); }
        });
      } catch (error) {
        errors.push(`${address}: ${(error as Error).message}`);
      }
    }
    this.emit('status', {
      active: this.memberships.size > 0,
      error: this.memberships.size === 0
        ? 'Nenhuma interface de rede disponível para descoberta. Conecte os aparelhos à mesma rede.'
        : errors.length ? `Algumas interfaces não aceitam multicast: ${errors.join('; ')}` : null,
    });
  }

  private sendPacket(socket: Socket): void {
    if (!this.active) return;
    try {
      // address() throws until the sender has finished binding.
      socket.address();
      const packet = encodeAnnouncement(this.options.getAnnouncement(), this.options.sign, this.now());
      socket.send(packet, DISCOVERY_PORT, DISCOVERY_GROUP, (error) => {
        if (error && this.active) this.emit('status', { active: true, error: `Anúncio de rede: ${error.message}` });
      });
    } catch { /* An interface may disappear while a send is pending; retry next interval. */ }
  }

  private announce(): void {
    for (const socket of this.senders.values()) this.sendPacket(socket);
  }

  /** Public for deterministic packet tests; remoteAddress must come from dgram's rinfo. */
  acceptPacket(packet: Uint8Array, remoteAddress: string): void {
    if (!usableAddress(remoteAddress)) return;
    const now = this.now();
    const announcement = decodeAnnouncement(packet, this.options.verify, now);
    if (!announcement || announcement.device.id === this.options.getAnnouncement().id) return;
    const { device, nonce, sentAt } = announcement;
    const replayKey = `${device.id}:${nonce}:${remoteAddress}`;
    if (this.replay.has(replayKey)) return;
    const prior = this.peers.get(device.id);
    // Older signed datagrams cannot roll a device back to a stale endpoint or role.
    if (prior && sentAt < prior.lastTimestamp) return;
    if (!prior && this.peers.size >= MAX_PEERS) return;
    if (this.replay.size >= MAX_REPLAY_ENTRIES) this.replay.delete(this.replay.keys().next().value!);
    this.replay.set(replayKey, now);
    const addresses = prior?.addresses ?? new Map<string, number>();
    addresses.delete(remoteAddress);
    addresses.set(remoteAddress, now);
    for (const [address, seen] of addresses) {
      if (now - seen > OFFLINE_AFTER) addresses.delete(address);
    }
    while (addresses.size > 8) addresses.delete(addresses.keys().next().value!);
    const result: DiscoveredDevice = {
      ...device, addresses: [...addresses.keys()].reverse(), online: true, lastSeen: now, paired: false,
    };
    this.peers.set(device.id, { device: result, lastTimestamp: sentAt, addresses });
    this.emit('device', result);
  }

  /** Expires by receive time, so clock drift cannot keep a device online. */
  expire(): void {
    const now = this.now();
    for (const [id, peer] of this.peers) {
      if (now - peer.device.lastSeen >= OFFLINE_AFTER) {
        this.peers.delete(id);
        this.emit('offline', id);
      }
    }
    for (const [key, seen] of this.replay) {
      if (now - seen > MAX_CLOCK_SKEW * 2) this.replay.delete(key);
    }
  }
}
