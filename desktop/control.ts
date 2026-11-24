import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { createServer, request, Agent, type Server } from 'node:https';
import { connect, type TLSSocket } from 'node:tls';
import { isIP } from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Device, PairInvite } from '../shared/types';
import { certificateFingerprint, fingerprint, identityId, signPayload, verifyPayload, type Identity } from './identity';
import type { DiscoveredDevice } from './discovery';
import { createReadStream, createWriteStream } from 'node:fs';
import { rename, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import path from 'node:path';
import type { TrustedPeer } from './store';

interface PublicIdentity { device: Device; publicKey: string; tlsFingerprint: string }
interface Envelope { payload: string; signature: string }
interface Payload extends PublicIdentity { timestamp: number; nonce: string; recipient: string; token?: string; file?: FileOffer }
export interface FileOffer { name: string; size: number }
interface PairTarget { id: string; publicKey: string; tlsFingerprint: string; addresses: string[]; port: number; token: string }
interface ControlOptions {
  identity: Identity;
  getDevice: () => Device;
  getDiscovered: () => DiscoveredDevice[];
  getPeer: (id: string) => TrustedPeer | undefined;
  onPair: (peer: TrustedPeer) => Promise<void>;
  confirmPair: (device: Device, signal: AbortSignal) => Promise<boolean>;
  onFileReceived?: (name: string) => void;
  acceptFile?: (device: Device, file: FileOffer) => Promise<string | undefined>;
  allowLoopback?: boolean;
}
export function isLanAddress(address: string, allowLoopback = false): boolean {
  if (isIP(address) !== 4) return false;
  const parts = address.split('.').map(Number);
  return parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168) || (parts[0] === 169 && parts[1] === 254) || (allowLoopback && parts[0] === 127);
}
function hash(input: string | Buffer) { return createHash('sha256').update(input).digest('hex'); }
function pairingProof(code: string, pin: string, session: string) {
  return createHmac('sha256', code).update(`heymouse-v3:${pin}:${session}`).digest('hex');
}

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
/** The HTTPS request is created only AFTER the remote certificate has been pinned. */
async function pinnedSocket(host: string, port: number, pin: string): Promise<TLSSocket> {
  return new Promise<TLSSocket>((resolve, reject) => {
    const socket = connect({ host, port, rejectUnauthorized: false, minVersion: 'TLSv1.2' });
    const fail = (error: Error) => { socket.destroy(); reject(error); };
    socket.setNoDelay(true);
    const onTimeout = () => fail(new Error('O aparelho não respondeu na rede.'));
    socket.setTimeout(3500, onTimeout);
    socket.once('error', fail);
    socket.once('secureConnect', () => {
      const raw = socket.getPeerCertificate().raw;
      if (!raw || hash(raw) !== pin) return fail(new Error('O certificado do aparelho mudou. Refaça o pareamento para confiar nele.'));
      socket.removeListener('error', fail);
      socket.removeListener('timeout', onTimeout);
      socket.setTimeout(0);
      resolve(socket);
    });
  });
}
export async function pinnedRequest(host: string, port: number, pin: string, path: string, envelope: Envelope): Promise<Envelope> {
  const socket = await pinnedSocket(host, port, pin);
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
    req.setTimeout(path === '/file-offer' ? 120_000 : path === '/pair' ? 50_000 : 4000, () => req.destroy(new Error('O aparelho não respondeu a tempo.')));
    req.on('error', error => { cleanup(); reject(error); });
    req.end(body);
  });
}

export class ControlServer {
  private incomingFile: { token: string; sender: string; path: string; size: number; expires: number } | null = null;
  private decidingFile = false;
  private receivingFile = false;
  private server: Server | null = null;
  private invite: { tokenHash: string; expiresAt: number; session: string; remaining: number } | null = null;
  private pendingPair = false;
  private seen = new Map<string, number>();
  private attempts = new Map<string, { count: number; since: number }>();
  private sockets = new Set<TLSSocket>();
  port = 0;
  constructor(private options: ControlOptions) {}
  publicIdentity(): PublicIdentity {
    return { device: this.options.getDevice(), publicKey: this.options.identity.publicKey, tlsFingerprint: certificateFingerprint(this.options.identity.certificate) };
  }
  private envelope(recipient: string, nonce: string, token?: string, file?: FileOffer): Envelope {
    const payload = JSON.stringify({ ...this.publicIdentity(), recipient, nonce, timestamp: Date.now(), token, file });
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
    const server = createServer({ key: this.options.identity.tlsKey, cert: this.options.identity.certificate, minVersion: 'TLSv1.2', requestTimeout: 0, headersTimeout: 5000 }, (req, res) => { void this.handle(req, res); });
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
  pairingSession(): string | undefined {
    return this.invite && this.invite.expiresAt > Date.now() ? this.invite.session : undefined;
  }
  createInvite(): PairInvite {
    const local = this.publicIdentity();
    if (!this.server || !local.device.addresses.some(ip => isLanAddress(ip, this.options.allowLoopback))) {
      throw new Error('Conecte este computador à rede local antes de gerar um código.');
    }
    if (this.pendingPair) throw new Error('Responda à solicitação de pareamento aberta.');
    const code = String(randomInt(1_000_000)).padStart(6, '0');
    const session = randomBytes(32).toString('hex');
    const expiresAt = Date.now() + 5 * 60_000;
    this.invite = {
      tokenHash: hash(pairingProof(code, local.tlsFingerprint, session)),
      session, expiresAt, remaining: 8,
    };
    return { code, expiresAt };
  }
  private resolveCode(code: string): PairTarget {
    const normalized = code.trim();
    if (!/^\d{6}$/.test(normalized)) throw new Error('Digite os seis números do código de pareamento.');
    const candidates: PairTarget[] = [];
    for (const device of this.options.getDiscovered()) {
      const pin = device.engineFingerprint?.replace(/:/g, '').toLowerCase();
      if (!pin || !device.pairingSession) continue;
      const addresses = device.addresses.filter(ip => isLanAddress(ip, this.options.allowLoopback));
      if (!addresses.length) continue;
      candidates.push({
        id: device.id, publicKey: device.publicKey, tlsFingerprint: pin, addresses,
        port: device.controlPort, token: pairingProof(normalized, pin, device.pairingSession),
      });
    }
    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1) throw new Error('Mais de um computador está oferecendo pareamento. Deixe apenas um código ativo.');
    throw new Error('Nenhum computador com código ativo foi encontrado. Confira a rede e a descoberta automática.');
  }
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const reply = (status: number, body: unknown) => { if (!res.destroyed) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); } };
    try {
      if (req.method !== 'POST' || !['/pair', '/ping', '/file-offer', '/file'].includes(req.url ?? '')) return reply(404, { error: 'Rota desconhecida.' });
      const address = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
      if (!isLanAddress(address, this.options.allowLoopback)) return reply(403, { error: 'Disponível apenas na rede local.' });
      const now = Date.now();
      for (const [key, item] of this.attempts) if (now - item.since > 60000) this.attempts.delete(key);
      const rate = this.attempts.get(address) ?? { count: 0, since: now };
      rate.count++; this.attempts.set(address, rate);
      if (rate.count > 120 || this.attempts.size > 1024) return reply(429, { error: 'Muitas tentativas. Aguarde um minuto.' });
      if (req.url === '/file') {
        await this.receiveFile(req);
        return reply(200, { ok: true });
      }
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
        if (this.pendingPair) throw new Error('Já existe uma solicitação aguardando resposta.');
        if (!invite || invite.expiresAt <= Date.now()) throw new Error('Código expirado ou já utilizado.');
        if (typeof payload.token !== 'string' || payload.token.length !== 64 || !timingSafeEqual(Buffer.from(hash(payload.token), 'hex'), Buffer.from(invite.tokenHash, 'hex'))) {
          if (--invite.remaining === 0) this.invite = null;
          throw new Error('Código incorreto. Confira os seis números ou gere outro código.');
        }
        if (payload.device.id === this.options.getDevice().id) throw new Error('Este convite pertence ao próprio computador.');
        this.invite = null;
        this.seen.set(nonceKey, now);
        this.pendingPair = true;
        const disconnected = new AbortController();
        const abort = () => disconnected.abort();
        res.once('close', abort);
        const signal = AbortSignal.any([disconnected.signal, AbortSignal.timeout(40_000)]);
        const device = { ...payload.device, addresses: [address], paired: true, online: true, lastSeen: now };
        req.socket.setTimeout(45_000);
        try {
          const approved = await this.options.confirmPair(device, signal);
          if (signal.aborted) throw new Error('Tempo de confirmação esgotado.');
          if (!approved) throw new Error('Pareamento recusado no outro computador.');
          await this.options.onPair({ device, publicKey: payload.publicKey, tlsFingerprint: payload.tlsFingerprint });
        } finally {
          res.removeListener('close', abort);
          this.pendingPair = false;
          req.socket.setTimeout(5000);
        }
      } else {
        const peer = this.options.getPeer(payload.device.id);
        if (!peer || fingerprint(peer.publicKey) !== fingerprint(payload.publicKey) || peer.tlsFingerprint !== payload.tlsFingerprint) throw new Error('Aparelho não pareado.');
        this.seen.set(nonceKey, now);
        if (req.url === '/file-offer') {
          const file = payload.file;
          if (!file || typeof file.name !== 'string' || !file.name || file.name.length > 255 ||
              /[\\/\x00-\x1f]/.test(file.name) || ['.', '..'].includes(file.name) ||
              !Number.isSafeInteger(file.size) || file.size < 0) throw new Error('Arquivo inválido.');
          if (!this.options.acceptFile) throw new Error('O recebimento está indisponível.');
          if (this.decidingFile || this.receivingFile || (this.incomingFile && this.incomingFile.expires > Date.now())) throw new Error('Já existe uma transferência em andamento.');
          this.decidingFile = true;
          req.socket.setTimeout(115_000);
          try {
            const destination = await this.options.acceptFile(peer.device, file);
            if (!destination || res.destroyed || !this.options.getPeer(peer.device.id)) throw new Error('Transferência recusada ou cancelada.');
            const token = randomBytes(32).toString('hex');
            this.incomingFile = { token, sender: peer.device.id, size: file.size, path: destination, expires: Date.now() + 60_000 };
            return reply(200, this.envelope(peer.device.id, payload.nonce, token));
          } finally {
            this.decidingFile = false;
          }
        }
      }
      reply(200, this.envelope(payload.device.id, payload.nonce));
    } catch (error) { reply(403, { error: error instanceof Error ? error.message : 'Falha na autenticação.' }); }
  }
  private async receiveFile(req: IncomingMessage): Promise<void> {
    const header = req.headers['x-heymouse-transfer'];
    if (typeof header !== 'string') throw new Error('Transferência inválida.');
    const payload = this.decode(JSON.parse(Buffer.from(header, 'base64url').toString('utf8')));
    const peer = this.options.getPeer(payload.device.id);
    const file = this.incomingFile;
    if (!peer || fingerprint(peer.publicKey) !== fingerprint(payload.publicKey) || peer.tlsFingerprint !== payload.tlsFingerprint ||
        !file || file.expires <= Date.now() || file.sender !== peer.device.id || file.token !== payload.token ||
        req.headers['content-length'] !== String(file.size)) throw new Error('Transferência não autorizada ou expirada.');
    this.incomingFile = null;
    this.receivingFile = true;
    const temp = file.path + '.heymouse-' + randomBytes(12).toString('hex');
    let bytes = 0;
    req.socket.setTimeout(30_000);
    try {
      await pipeline(req, new Transform({
        transform(chunk, _encoding, callback) {
          bytes += chunk.length;
          if (bytes > file.size) return callback(new Error('O arquivo excedeu o tamanho informado.'));
          callback(null, chunk);
        },
      }), createWriteStream(temp, { flags: 'wx', mode: 0o600 }));
      if (bytes !== file.size) throw new Error('Transferência incompleta.');
      await rename(temp, file.path);
      this.options.onFileReceived?.(path.basename(file.path));
    } finally {
      this.receivingFile = false;
      await unlink(temp).catch(() => {});
    }
  }
  async sendFile(peer: TrustedPeer, source: string, file: FileOffer, onProgress: (sent: number) => void): Promise<void> {
    if (!Number.isSafeInteger(file.size) || file.size < 0) throw new Error('Tamanho de arquivo inválido.');
    const address = peer.device.addresses.find(ip => isLanAddress(ip, this.options.allowLoopback));
    if (!address) throw new Error('O aparelho está sem endereço na rede local.');
    const { id, controlPort } = peer.device;
    const nonce = randomBytes(16).toString('hex');
    const response = this.decode(await pinnedRequest(address, controlPort, peer.tlsFingerprint, '/file-offer', this.envelope(id, nonce, undefined, file)), peer.publicKey, nonce);
    if (response.tlsFingerprint !== peer.tlsFingerprint || !response.token || !/^[a-f0-9]{64}$/.test(response.token)) throw new Error('O destino não autorizou o arquivo.');
    const header = Buffer.from(JSON.stringify(this.envelope(id, randomBytes(16).toString('hex'), response.token))).toString('base64url');
    const socket = await pinnedSocket(address, controlPort, peer.tlsFingerprint);
    const agent = new Agent({ keepAlive: false, maxSockets: 1 });
    agent.createConnection = () => socket;
    try {
      let sent = 0;
      let lastUpdate = 0;
      const result = new Promise<void>((resolve, reject) => {
        const req = request({ host: address, port: controlPort, path: '/file', method: 'POST', agent,
          headers: { 'content-length': file.size, 'x-heymouse-transfer': header, connection: 'close' } }, res => {
          res.resume();
          res.once('error', reject);
          res.once('end', () => res.statusCode === 200 ? resolve() : reject(new Error('O destino não conseguiu salvar o arquivo.')));
        });
        req.setTimeout(30_000, () => req.destroy(new Error('A transferência parou de responder.')));
        req.once('error', reject);
        const input = createReadStream(source);
        const meter = new Transform({ transform(chunk, _encoding, done) {
          sent += chunk.length;
          if (sent > file.size) return done(new Error('O arquivo foi alterado durante o envio.'));
          if (Date.now() - lastUpdate > 200) { lastUpdate = Date.now(); onProgress(sent); }
          done(null, chunk);
        } });
        void pipeline(input, meter, req).catch(reject);
      });
      await result;
    } finally {
      agent.destroy();
      socket.destroy();
    }
  }
  async pair(code: string): Promise<TrustedPeer> {
    if (typeof code !== 'string' || code.length > 12000) throw new Error('Código de pareamento inválido.');
    const invite = this.resolveCode(code);
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
