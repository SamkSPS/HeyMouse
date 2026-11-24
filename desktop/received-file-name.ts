import { basename, extname } from 'node:path';

export function offeredFileName(name: string): string {
  return name.replace(/[<>:"|?*]/g, '_').replace(/[. ]+$/, '') || 'arquivo';
}

export function withOriginalExtension(destination: string, offeredName: string): string {
  const extension = extname(offeredName);
  if (!extension) return destination;
  const selectedName = basename(destination);
  // A hidden final extension can leave the earlier suffix on compound names.
  if (selectedName === basename(offeredName, extension) || !extname(selectedName)) return destination + extension;
  return destination;
}
