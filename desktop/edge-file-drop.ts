import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { createInterface } from 'node:readline';
import type { Device, ScreenPlacement } from '../shared/types';

type Edge = 'left' | 'right' | 'top' | 'bottom';
const directions = [
  ['left', -1, 0], ['right', 1, 0], ['top', 0, -1], ['bottom', 0, 1],
] as const;

export function edgeTargets(localId: string, layout: ScreenPlacement[], devices: Device[]): Map<Edge, string> {
  const local = layout.find(screen => screen.deviceId === localId);
  const online = new Set(devices.filter(device => device.paired && device.online).map(device => device.id));
  const targets = new Map<Edge, string>();
  if (!local) return targets;
  for (const [edge, dx, dy] of directions) {
    let nearest: ScreenPlacement | undefined;
    let distance = Infinity;
    for (const screen of layout) {
      if (!online.has(screen.deviceId) || screen.deviceId === localId) continue;
      const x = screen.x - local.x, y = screen.y - local.y;
      const along = x * dx + y * dy;
      if (x * dy !== y * dx || along <= 0 || along >= distance) continue;
      nearest = screen;
      distance = along;
    }
    if (nearest) targets.set(edge, nearest.deviceId);
  }
  return targets;
}

export class EdgeFileDrop {
  private readonly helpers = new Map<Edge, { target: string; child: ChildProcessWithoutNullStreams }>();
  private readonly failed = new Map<Edge, string>();

  constructor(
    private readonly executable: string,
    private readonly onDrop: (target: string, path: string) => void,
    private readonly onError: (error: Error) => void,
  ) {}

  sync(targets: Map<Edge, string>): void {
    for (const [edge, current] of this.helpers) {
      if (targets.get(edge) === current.target) continue;
      this.helpers.delete(edge);
      current.child.kill();
    }
    for (const [edge, target] of this.failed) if (targets.get(edge) !== target) this.failed.delete(edge);
    for (const [edge, target] of targets) {
      if (this.helpers.has(edge) || this.failed.has(edge)) continue;
      const child = spawn(this.executable, [edge], { windowsHide: true });
      this.helpers.set(edge, { target, child });
      const isCurrent = () => this.helpers.get(edge)?.child === child;
      const fail = (error: Error) => {
        if (!isCurrent()) return;
        this.helpers.delete(edge);
        this.failed.set(edge, target);
        this.onError(error);
      };
      child.once('error', fail);
      child.once('close', code => fail(new Error(`O envio pela borda encerrou (${code ?? 'sinal'}).`)));
      child.stderr.resume();
      createInterface({ input: child.stdout }).on('line', line => {
        if (!isCurrent() || line.length > 40_000) return;
        try {
          const drop = JSON.parse(line);
          if (typeof drop?.path === 'string' && isAbsolute(drop.path)) this.onDrop(target, drop.path);
        } catch { /* Ignore diagnostic output from the helper. */ }
      });
    }
  }

  stop(): void { this.sync(new Map()); }
}
