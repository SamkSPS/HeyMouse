import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rmdir, stat, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import type { Device } from '../shared/types';
import type { TrustedPeer } from './store';
import type { ControlServer, FileOffer } from './control';
import { isDragSessionId, type DragEvent } from '../native/drag-handoff';

const MAX_STAGED_BYTES = 8 * 1024 * 1024;

interface Staging {
  id: string;
  directory: string;
  file: string;
  watchdog: ReturnType<typeof setTimeout>;
  child?: ChildProcessWithoutNullStreams;
  ready: boolean;
  connected: boolean;
}

export class NativeDrag {
  private receiver?: Staging;
  private source?: ChildProcessWithoutNullStreams;
  private stopped = false;
  private readonly peerId = process.env.HEYMOUSE_EXPERIMENTAL_DRAG_PEER;
  private readonly helper = process.env.HEYMOUSE_EXPERIMENTAL_DRAG_HELPER;

  constructor(
    private readonly control: ControlServer,
    private readonly dataDir: string,
    private readonly peer: (id: string) => TrustedPeer | undefined,
    private readonly report: (message: string) => void,
  ) {}

  async accept(device: Device, offer: FileOffer): Promise<string | undefined> {
    if (this.stopped || process.platform !== 'darwin' || !this.helper || !isAbsolute(this.helper) ||
        device.id !== this.peerId || !isDragSessionId(offer.dragSession) ||
        offer.size > MAX_STAGED_BYTES || this.receiver) return;
    const root = join(this.dataDir, 'native-drag-staging');
    await mkdir(root, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(join(root, 'drag-'));
    const name = offer.name.replace(/[<>:"|?*]/g, '_').replace(/^[. ]+|[. ]+$/g, '') || 'arquivo';
    const staging: Staging = {
      directory, id: offer.dragSession, file: join(directory, name), ready: false, connected: false,
      watchdog: setTimeout(() => void this.clearReceiver(), 65_000),
    };
    this.receiver = staging;
    return staging.file;
  }

  async stage(peer: TrustedPeer, id: string, path: string): Promise<void> {
    const staging = this.receiver;
    if (!staging || staging.id !== id || staging.file !== path || peer.device.id !== this.peerId || !this.helper) {
      throw new Error('Sessão nativa expirou.');
    }
    clearTimeout(staging.watchdog);
    staging.watchdog = setTimeout(() => void this.clearReceiver(), 125_000);
    const child = spawn(this.helper, [path, '--handoff'], { windowsHide: true });
    staging.child = child;
    child.stdin.on('error', () => {});
    const output = createInterface({ input: child.stdout });
    child.stderr.on('data', (chunk: Buffer) => this.report(chunk.toString().trim().slice(0, 240)));
    await new Promise<void>((resolve, reject) => {
      const startup = setTimeout(() => reject(new Error('Não foi possível iniciar o arraste no Finder.')), 6000);
      child.once('error', reject);
      child.once('close', () => {
        clearTimeout(startup);
        if (!staging.ready) reject(new Error('O auxiliar do Finder encerrou.'));
        if (this.receiver === staging) void this.clearReceiver();
      });
      output.on('line', line => {
        if (line === 'finder-drag-ready') {
          clearTimeout(startup);
          staging.ready = true;
          resolve();
        } else if (line === 'finder-drop-saved' || line === 'finder-drag-cancelled') {
          if (this.receiver === staging) void this.clearReceiver();
        }
      });
    }).catch(async error => { await this.clearReceiver(); throw error; });
  }

  open(peer: TrustedPeer, id: string): ((event: DragEvent) => void) | undefined {
    const staging = this.receiver;
    if (!staging?.ready || staging.connected || staging.id !== id || peer.device.id !== this.peerId) return;
    const input = staging.child?.stdin;
    if (!input?.writable) return;
    staging.connected = true;
    return event => {
      if (!input.writable) throw new Error('O Finder encerrou a sessão.');
      input.write(JSON.stringify(event) + '\n');
      if (event.type !== 'file-drag-move') input.end();
    };
  }

  startSource(): void {
    const edge = process.env.HEYMOUSE_EXPERIMENTAL_DRAG_EDGE;
    if (process.platform !== 'win32' || this.stopped || !this.helper || !isAbsolute(this.helper) ||
        !this.peerId || !edge || !['left', 'right', 'top', 'bottom'].includes(edge)) return;
    const child = spawn(this.helper, [edge, '--track'], { windowsHide: true });
    this.source = child;
    const lines = createInterface({ input: child.stdout });
    let events: PassThrough | undefined;
    let forwarding = false;
    let busy = false;
    let ended = false;
    child.on('error', error => this.report(error.message));
    child.once('close', () => {
      if (events && !ended) events.end({ type: 'file-drag-cancelled' } satisfies DragEvent);
      if (this.source === child) this.source = undefined;
    });
    child.stderr.on('data', (chunk: Buffer) => this.report(chunk.toString().trim().slice(0, 240)));
    lines.on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (!message || typeof message !== 'object') return;
      if (message.type === 'file-drag-enter' && !busy && typeof message.path === 'string' &&
          isAbsolute(message.path) && typeof message.name === 'string') {
        const peer = this.peer(this.peerId!);
        if (!peer?.device.online || peer.device.platform !== 'darwin') return;
        busy = true;
        ended = false;
        const queue = new PassThrough({ objectMode: true, highWaterMark: 128 });
        events = queue;
        const path = message.path as string;
        const name = message.name as string;
        const id = randomUUID();
        void (async () => {
          const info = await stat(path);
          if (!info.isFile() || info.size > MAX_STAGED_BYTES) throw new Error('O teste de arraste aceita arquivos de até 8 MB.');
          if (ended) return;
          await this.control.sendFile(peer, path, { name, size: info.size, dragSession: id }, () => {});
          forwarding = true;
          await this.control.forwardDrag(peer, id, queue as AsyncIterable<DragEvent>);
        })().catch(error => this.report(error.message)).finally(() => {
          queue.destroy();
          events = undefined;
          busy = forwarding = false;
        });
      } else if (events && !ended) {
        if (message.type === 'file-drag-released' || message.type === 'file-drag-cancelled') {
          ended = true;
          events.end({ type: forwarding ? message.type : 'file-drag-cancelled' });
        } else if (forwarding && message.type === 'file-drag-move' && Number.isInteger(message.dx) && Number.isInteger(message.dy)) {
          if (events.writableLength < 128) events.write({ type: message.type, dx: message.dx, dy: message.dy });
        }
      }
    });
  }

  stop(): void {
    this.stopped = true;
    this.source?.kill();
    void this.clearReceiver();
  }

  private async clearReceiver(): Promise<void> {
    const staging = this.receiver;
    if (!staging) return;
    this.receiver = undefined;
    clearTimeout(staging.watchdog);
    if (staging.child) {
      const child = staging.child;
      child.stdin.end();
      setTimeout(() => child.kill(), 750).unref();
    }
    await unlink(staging.file).catch(() => {});
    await rmdir(staging.directory).catch(() => {});
  }
}
