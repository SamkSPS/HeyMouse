import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, request, Agent, type Server } from 'node:https';
import { connect, type TLSSocket } from 'node:tls';
import { isIP } from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Device, PairInvite } from '../shared/types';
import { certificateFingerprint, fingerprint, identityId, signPayload, verifyPayload, type Identity } from './identity';
import type { TrustedPeer } from './store';

interface PublicIdentity { device: Device; publicKey: string; tlsFingerprint: string }
interface Envelope { payload: string; signature: string }
interface Payload extends PublicIdentity { timestamp: number; nonce: string; recipient: string; token?: string }
interface Invite { v: 1; id: string; publicKey: string; tlsFingerprint: string; addresses: string[]; port: number; token: string; expiresAt: number }
interface ControlOptions {
  identity: Identity;
  getDevice: () => Device;
  getPeer: (id: string) => TrustedPeer | undefined;
  onPair: (peer: TrustedPeer) => Promise<void>;
  allowLoopback?: boolean;
}
export function isLanAddress(address: string, allowLoopback = false): boolean {
  if (isIP(address) !== 4) return false;
  const parts = address.split('.').map(Number);
  return parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168) || (parts[0] === 169 && parts[1] === 254) || (allowLoopback && parts[0] === 127);
}
function hash(input: string | Buffer) { return createHash('sha256').update(input).digest('hex'); }
function validateIdentity(value: PublicIdentity): void {
  if (!value || typeof value.publicKey !== 'string' || value.publicKey.length > 1024) throw new Error('Identidade inválida.');
  const d = value.device;
  if (!d || d.id !== identityId(value.publicKey) || d.fingerprint !== fingerprint(value.publicKey)) throw new Error('A identidade do aparelho não confere.');
  if (typeof d.name !== 'string' || d.name.length < 1 || d.name.length > 64 || /[\x00-\x1f]/.test(d.name)) throw new Error('Nome inválido.');
  if (!['win32', 'linux', 'darwin'].includes(d.platform) || !['client', 'server'].includes(d.role)) throw new Error('Aparelho inválido.');
  if (![d.inputPort, d.controlPort].every(port => Number.isInteger(port) && port > 0 && port < 65536)) throw new Error('Porta inválida.');
  if (!Array.isArray(d.addresses) || d.addresses.length > 32 || !d.addresses.every(ip => typeof ip === 'string' && isIP(ip) === 4)) throw new Error('Endereço inválido.');
  if (typeof d.hostname !== 'string' || d.hostname.length > 255 || typeof d.engineAvailable !== 'boolean') throw new Error('Aparelho inválido.');
  if (!/^[a-f0-9]{64}$/.test(value.tlsFingerprint)) throw new Error('Certificado inválido.');
  if (d.engineFingerprint && d.engineFingerprint.replace(/:/g, '').toLowerCase() !== value.tlsFingerprint) throw new Error('Certificado do motor inconsistente.');
}
export function parseInvite(code: string, allowLoopback = false): Invite {
  if (typeof code !== 'string' || code.length > 12000 || !code.trim().startsWith('HM1.')) throw new Error('Cole um convite HeyMouse válido, iniciado por HM1.');
  let invite: Invite;
  try { invite = JSON.parse(Buffer.from(code.trim().slice(4), 'base64url').toString('utf8')); }
  catch { throw new Error('O convite está incompleto ou é inválido.'); }
  if (invite.v !== 1 || typeof invite.publicKey !== 'string' || invite.publicKey.length > 1024 || invite.id !== identityId(invite.publicKey) || !/^[a-f0-9]{64}$/.test(invite.tlsFingerprint)) throw new Error('Identidade do convite inválida.');
  if (!Number.isFinite(invite.expiresAt) || invite.expiresAt <= Date.now() || invite.expiresAt > Date.now() + 6 * 60_000) throw new Error('Este convite expirou. Gere outro no aparelho de origem.');
  if (!/^[a-f0-9]{64}$/.test(invite.token) || !Number.isInteger(invite.port) || invite.port < 1 || invite.port > 65535) throw new Error('Convite inválido.');
  if (!Array.isArray(invite.addresses) || !invite.addresses.length || invite.addresses.length > 32 || !invite.addresses.every(address => isLanAddress(address, allowLoopback))) throw new Error('O convite precisa conter um endereço IPv4 da rede local.');
  return invite;
}

/** The HTTPS request is created only AFTER the remote certificate has been pinned. */
export async function pinnedRequest(host: string, port: number, pin: string, path: string, envelope: Envelope): Promise<Envelope> {
  const socket = await new Promise<TLSSocket>((resolve, reject) => {
    const socket = connect({ host, port, rejectUnauthorized: false, minVersion: 'TLSv1.2' });
    const fail = (error: Error) => { socket.destroy(); reject(error); };
    socket.setNoDelay(true);
    socket.setTimeout(3500, () => fail(new Error('O aparelho não respondeu na rede.')));
    socket.once('error', fail);
    socket.once('secureConnect', () => {
      const raw = socket.getPeerCertificate().raw;
      if (!raw || hash(raw) !== pin) return fail(new Error('O certificado do aparelho mudou. Refaça o pareamento para confiar nele.'));
      socket.removeListener('error', fail);
      resolve(socket);
    });
  });
  const agent = new Agent({ keepAlive: false, maxSockets: 1 });
  agent.createConnection = () => socket;
  const body = JSON.stringify(envelope);
  return new Promise<Envelope>((resolve, reject) => {
    const cleanup = () => { agent.destroy(); socket.destroy(); };
    const req = request({ host, port, path, method: 'POST', agent,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), connection: 'close' } }, response => {
      let data = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { data += chunk; if (data.length > 32768) req.destroy(new Error('Resposta excedeu o limite.')); });
      response.on('error', error => { cleanup(); reject(error); });
      response.on('end', () => {
        cleanup();
        try {
          const json = JSON.parse(data);
          if (response.statusCode !== 200) throw new Error(json.error || 'Não foi possível conectar ao aparelho.');
          resolve(json);
        } catch (error) { reject(error); }
      });
    });
    req.setTimeout(4000, () => req.destroy(new Error('O aparelho não respondeu a tempo.')));
    req.on('error', error => { cleanup(); reject(error); });
    req.end(body);
  });
}

export class ControlServer {
  private server: Server | null = null;
  private invite: { tokenHash: string; expiresAt: number } | null = null;
  private seen = new Map<string, number>();
  private attempts = new Map<string, { count: number; since: number }>();
  private sockets = new Set<TLSSocket>();
  port = 0;
  constructor(private options: ControlOptions) {}
  publicIdentity(): PublicIdentity {
    return { device: this.options.getDevice(), publicKey: this.options.identity.publicKey, tlsFingerprint: certificateFingerprint(this.options.identity.certificate) };
  }
  private envelope(recipient: string, nonce: string, token?: string): Envelope {
    const payload = JSON.stringify({ ...this.publicIdentity(), recipient, nonce, timestamp: Date.now(), ...(token ? { token } : {}) });
    return { payload, signature: signPayload(payload, this.options.identity.privateKey) };
  }
  private decode(envelope: Envelope, expectedKey?: string, nonce?: string): Payload {
    if (!envelope || typeof envelope.payload !== 'string' || envelope.payload.length > 24000 || typeof envelope.signature !== 'string' || envelope.signature.length > 128) throw new Error('Mensagem inválida.');
    const payload = JSON.parse(envelope.payload) as Payload;
    validateIdentity(payload);
    if (expectedKey && fingerprint(expectedKey) !== fingerprint(payload.publicKey)) throw new Error('Identidade do aparelho mudou.');
    if (!verifyPayload(envelope.payload, envelope.signature, payload.publicKey)) throw new Error('Assinatura inválida.');
    if (payload.recipient !== this.options.getDevice().id || !Number.isFinite(payload.timestamp) || Math.abs(Date.now() - payload.timestamp) > 30000 || !/^[a-f0-9]{32}$/.test(payload.nonce) || (nonce && payload.nonce !== nonce)) throw new Error('Mensagem expirada ou destinada a outro aparelho.');
    return payload;
  }
  async start(port = 47856, host = '0.0.0.0'): Promise<void> {
    if (this.server) return;
    const server = createServer({ key: this.options.identity.tlsKey, cert: this.options.identity.certificate, minVersion: 'TLSv1.2', requestTimeout: 5000, headersTimeout: 5000 }, (req, res) => { void this.handle(req, res); });
    this.server = server;
    server.maxConnections = 48;
    server.on('secureConnection', socket => { this.sockets.add(socket); socket.once('close', () => this.sockets.delete(socket)); socket.setTimeout(5000, () => socket.destroy()); });
    server.on('tlsClientError', () => {});
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => { server.removeListener('error', reject); this.port = (server.address() as { port: number }).port; resolve(); });
    }).catch(error => { this.server = null; throw error; });
  }
  async stop(): Promise<void> {
    const server = this.server; this.server = null; this.invite = null;
    for (const socket of this.sockets) socket.destroy();
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  }
  createInvite(): PairInvite {
    const local = this.publicIdentity();
    const addresses = local.device.addresses.filter(ip => isLanAddress(ip, this.options.allowLoopback));
    if (!this.server || !addresses.length) throw new Error('Conecte este computador à rede local antes de criar um convite.');
    const token = randomBytes(32).toString('hex'), expiresAt = Date.now() + 5 * 60_000;
    this.invite = { tokenHash: hash(token), expiresAt };
    const invite: Invite = { v: 1, id: local.device.id, publicKey: local.publicKey, tlsFingerprint: local.tlsFingerprint, addresses, port: this.port, token, expiresAt };
    return { code: 'HM1.' + Buffer.from(JSON.stringify(invite)).toString('base64url'), expiresAt };
  }
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const reply = (status: number, body: unknown) => { if (!res.destroyed) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); } };
    try {
      if (req.method !== 'POST' || !['/pair', '/ping'].includes(req.url ?? '')) return reply(404, { error: 'Rota desconhecida.' });
      const address = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
      if (!isLanAddress(address, this.options.allowLoopback)) return reply(403, { error: 'Disponível apenas na rede local.' });
      const now = Date.now();
      for (const [key, item] of this.attempts) if (now - item.since > 60000) this.attempts.delete(key);
      const rate = this.attempts.get(address) ?? { count: 0, since: now };
      rate.count++; this.attempts.set(address, rate);
      if (rate.count > 120 || this.attempts.size > 1024) return reply(429, { error: 'Muitas tentativas. Aguarde um minuto.' });
      const chunks: Buffer[] = []; let length = 0;
      for await (const chunk of req) {
        length += chunk.length;
        if (length > 32768) { reply(413, { error: 'Mensagem muito grande.' }); req.destroy(); return; }
        chunks.push(Buffer.from(chunk));
      }
      const payload = this.decode(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      for (const [nonce, timestamp] of this.seen) if (now - timestamp > 60000) this.seen.delete(nonce);
      const nonceKey = payload.device.id + payload.nonce;
      if (this.seen.has(nonceKey) || this.seen.size > 4096) throw new Error('Mensagem repetida.');
      if (req.url === '/pair') {
        const invite = this.invite;
        if (!invite || invite.expiresAt <= now || typeof payload.token !== 'string' || payload.token.length !== 64 || !timingSafeEqual(Buffer.from(hash(payload.token), 'hex'), Buffer.from(invite.tokenHash, 'hex'))) throw new Error('Convite expirado, inválido ou já utilizado.');
        if (payload.device.id === this.options.getDevice().id) throw new Error('Este convite pertence ao próprio computador.');
        this.invite = null;
        this.seen.set(nonceKey, now);
        await this.options.onPair({ device: { ...payload.device, addresses: [address], paired: true, online: true, lastSeen: now }, publicKey: payload.publicKey, tlsFingerprint: payload.tlsFingerprint });
      } else {
        const peer = this.options.getPeer(payload.device.id);
        if (!peer || fingerprint(peer.publicKey) !== fingerprint(payload.publicKey) || peer.tlsFingerprint !== payload.tlsFingerprint) throw new Error('Aparelho não pareado.');
        this.seen.set(nonceKey, now);
      }
      reply(200, this.envelope(payload.device.id, payload.nonce));
    } catch (error) { reply(403, { error: error instanceof Error ? error.message : 'Falha na autenticação.' }); }
  }
  async pair(code: string): Promise<TrustedPeer> {
    const invite = parseInvite(code, this.options.allowLoopback);
    if (invite.id === this.options.getDevice().id) throw new Error('Cole este convite no outro computador.');
    const nonce = randomBytes(16).toString('hex');
    const envelope = this.envelope(invite.id, nonce, invite.token);
    let lastError: unknown;
    for (const address of invite.addresses) {
      try {
        const response = this.decode(await pinnedRequest(address, invite.port, invite.tlsFingerprint, '/pair', envelope), invite.publicKey, nonce);
        if (response.tlsFingerprint !== invite.tlsFingerprint) throw new Error('Certificado inconsistente.');
        const peer = { device: { ...response.device, addresses: [address], online: true, paired: true, lastSeen: Date.now() }, publicKey: response.publicKey, tlsFingerprint: response.tlsFingerprint };
        await this.options.onPair(peer);
        return peer;
      } catch (error) { lastError = error; }
    }
    throw new Error(`Não foi possível parear. ${lastError instanceof Error ? lastError.message : 'Verifique a rede e o firewall.'}`);
  }
  async ping(peer: TrustedPeer): Promise<{ device: Device; latency: number }> {
    let lastError: unknown;
    for (const address of peer.device.addresses.filter(ip => isLanAddress(ip, this.options.allowLoopback))) {
      const nonce = randomBytes(16).toString('hex'), started = performance.now();
      try {
        const response = this.decode(await pinnedRequest(address, peer.device.controlPort, peer.tlsFingerprint, '/ping', this.envelope(peer.device.id, nonce)), peer.publicKey, nonce);
        if (response.tlsFingerprint !== peer.tlsFingerprint) throw new Error('Certificado alterado.');
        return { device: { ...response.device, addresses: [address], online: true, paired: true, lastSeen: Date.now() }, latency: Math.round((performance.now() - started) * 10) / 10 };
      } catch (error) { lastError = error; }
    }
    throw lastError ?? new Error('Aparelho sem endereço disponível.');
  }
}
