export type DragEvent =
  | { type: 'file-drag-move'; dx: number; dy: number }
  | { type: 'file-drag-released' | 'file-drag-cancelled' };

export function isDragSessionId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

export async function* readDragEvents(stream: AsyncIterable<Buffer | string>): AsyncGenerator<DragEvent> {
  let line = '';
  let events = 0;
  for await (const chunk of stream) {
    for (const char of chunk.toString('utf8')) {
      if (char !== '\n') {
        line += char;
        if (line.length > 200) throw new Error('Evento de arraste excedeu o limite.');
        continue;
      }
      const event = JSON.parse(line);
      line = '';
      if (++events > 16_000 || !event || typeof event !== 'object') throw new Error('Sessão de arraste inválida.');
      if (event.type === 'file-drag-released' || event.type === 'file-drag-cancelled') {
        yield { type: event.type };
        return;
      }
      if (event.type !== 'file-drag-move' || !Number.isInteger(event.dx) || !Number.isInteger(event.dy) ||
          Math.abs(event.dx) > 2048 || Math.abs(event.dy) > 2048) throw new Error('Movimento de arraste inválido.');
      yield { type: event.type, dx: event.dx, dy: event.dy };
    }
  }
  throw new Error('Sessão de arraste encerrada antes da soltura.');
}
