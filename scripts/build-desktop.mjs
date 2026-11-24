import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
await build({ entryPoints: ['desktop/main.ts'], outfile: 'dist-desktop/main.cjs', bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'], sourcemap: true });
await build({ entryPoints: ['desktop/preload.ts'], outfile: 'dist-desktop/preload.cjs', bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'] });
if (process.platform === 'win32') {
  const csc = join(process.env.WINDIR ?? 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  execFileSync(csc, ['/nologo', '/target:exe', '/out:' + resolve('dist-desktop/edge-drop.exe'),
    '/reference:System.Drawing.dll', '/reference:System.Windows.Forms.dll', '/reference:System.Web.Extensions.dll',
    resolve('native/windows/EdgeFileDrop.cs')], { stdio: 'inherit', windowsHide: true });
}
