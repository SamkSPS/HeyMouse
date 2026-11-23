import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Pinned upstream release. Checksum is from its official GitHub release metadata.
const version = '1.27.0';
const windowsChecksums = {
  x64: '8d19004cc3625623489d96580c1b58fd13ee78185689907fd4478595f93fab9a',
  arm64: '86d9a02f9f2f747023de7f9808065bf4d7f922ffde67c7308061a5865d367ac2',
};
const macChecksums = {
  x64: '8aca3c77a1b16b9a3d6b8a380e5e38a0e6abf6d241bb32dcf3cf8b67abbff5d8',
  arm64: 'dd21e79e566314394214906d3338c505d337af536fc580c022ee3fadffad0c97',
};
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arch = process.argv.find((arg) => arg.startsWith('--arch='))?.split('=')[1] ?? process.arch;

const isMac = process.platform === 'darwin';
if (process.platform !== 'win32' && !isMac) {
  console.log('Instale Deskflow 1.27.x para seu sistema: https://github.com/deskflow/deskflow/releases/tag/v1.27.0');
  console.log('O HeyMouse detecta /usr/bin/deskflow-core e /Applications/Deskflow.app/Contents/MacOS/deskflow-core.');
  process.exit(0);
}
const checksums = isMac ? macChecksums : windowsChecksums;
if (!checksums[arch]) throw new Error(`Arquitetura não suportada: ${arch}`);
const filename = isMac ? `deskflow-${version}-macos-${arch === 'x64' ? 'x86_64' : arch}.dmg` : `deskflow-${version}-win-${arch}-portable.zip`;
const url = `https://github.com/deskflow/deskflow/releases/download/v${version}/${filename}`;
const engineDir = path.join(root, 'resources', 'engine');
const cacheDir = path.join(root, '.cache');
await mkdir(cacheDir, { recursive: true });
await mkdir(engineDir, { recursive: true });
console.log(`Baixando Deskflow ${version} (${arch})...`);
const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
if (!response.ok) throw new Error(`Falha no download oficial: HTTP ${response.status}`);
const bytes = Buffer.from(await response.arrayBuffer());
const digest = createHash('sha256').update(bytes).digest('hex');
if (digest !== checksums[arch]) throw new Error('Checksum SHA-256 inválido. O arquivo não será extraído.');
const zipPath = path.join(cacheDir, filename);
await writeFile(zipPath, bytes);
if (isMac) {
  const mount = path.join(cacheDir, 'deskflow-mount');
  const run = (command, args) => {
    const result = spawnSync(command, args, { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Falha ao executar ${command}.`);
  };
  run('hdiutil', ['attach', zipPath, '-mountpoint', mount, '-readonly', '-nobrowse']);
  try {
    run('ditto', [path.join(mount, 'Deskflow.app'), path.join(engineDir, 'Deskflow.app')]);
  } finally {
    run('hdiutil', ['detach', mount]);
  }
} else {
// Environment variables avoid interpolating paths into PowerShell code.
const extraction = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  'Expand-Archive -LiteralPath $env:HEYMOUSE_ENGINE_ARCHIVE -DestinationPath $env:HEYMOUSE_ENGINE_OUTPUT -Force'], {
  env: { ...process.env, HEYMOUSE_ENGINE_ARCHIVE: zipPath, HEYMOUSE_ENGINE_OUTPUT: engineDir },
  stdio: 'inherit', windowsHide: true,
});
if (extraction.error) throw extraction.error;
if (extraction.status !== 0) throw new Error('Falha ao extrair o motor Deskflow.');
}
await writeFile(path.join(engineDir, 'upstream.json'), JSON.stringify({
  project: 'Deskflow', version, arch, url, sha256: digest,
  source: `https://github.com/deskflow/deskflow/tree/v${version}`,
  license: 'GPL-2.0-only WITH LicenseRef-OpenSSL-Exception',
}, null, 2));
console.log(`Motor verificado e extraído em ${engineDir}`);
