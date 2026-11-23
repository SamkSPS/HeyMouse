import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createEngineConfig, engineScreenName, EngineManager, normalizeEngineFingerprint, type EngineStartOptions } from './engine';
import type { Device } from '../shared/types';

const peer = (id: string, extra: Partial<Device> = {}): Device => ({
  id, name: id, platform: 'linux', hostname: `${id}.local`, addresses: ['192.168.1.20'],
  controlPort: 24801, inputPort: 24800, online: true, lastSeen: Date.now(), paired: true,
  fingerprint: 'identity-key-is-not-the-tls-certificate', engineFingerprint: 'ab'.repeat(32),
  engineAvailable: true, role: 'client', ...extra,
});
const options = (extra: Partial<EngineStartOptions> = {}): EngineStartOptions => ({
  settings: { executablePath: '', role: 'server', port: 24800, screenName: 'ignored-ui-label', serverDeviceId: null, autoStart: false },
  localDeviceId: 'local-id', devices: [peer('paired-id')],
  layout: [{ deviceId: 'local-id', x: 0, y: 0 }, { deviceId: 'paired-id', x: 1, y: 0 }],
  certificatePem: 'test-only', ...extra,
});

test('layout creates reciprocal links and uses stable IDs, not display names or IPs', () => {
  const first = options();
  const generated = createEngineConfig(first, '/config');
  first.devices[0] = peer('paired-id', { name: 'Nome novo', addresses: ['10.0.0.8'] });
  const changed = createEngineConfig(first, '/config');
  assert.equal(changed.linksText, generated.linksText);
  assert.match(generated.linksText, new RegExp(`right = ${engineScreenName('paired-id')}`));
  assert.match(generated.linksText, new RegExp(`left = ${engineScreenName('local-id')}`));
  assert.match(generated.settingsText, new RegExp(`\\[computer_${engineScreenName('paired-id')}\\]`));
  assert.match(generated.settingsText, /tlsEnabled=true\ncheckPeerFingerprints=true/);
  assert.match(generated.settingsText, /enableClipboard=false/);
});

test('unpaired devices cannot enter topology or certificate trust', () => {
  const generated = createEngineConfig(options({ devices: [peer('paired-id'), peer('attacker', { paired: false, engineFingerprint: 'cd'.repeat(32) })],
    layout: [...options().layout, { deviceId: 'attacker', x: -1, y: 0 }] }), '/config');
  assert.ok(!generated.linksText.includes(engineScreenName('attacker')));
  assert.equal(generated.trust, `v2:sha256:${'ab'.repeat(32)}\n`);
});

test('TLS trust never falls back to the identity fingerprint', () => {
  const generated = createEngineConfig(options({ devices: [peer('paired-id', { engineFingerprint: undefined })] }), '/config');
  assert.equal(generated.trust, '\n');
  assert.throws(() => normalizeEngineFingerprint('invalid'));
  assert.equal(normalizeEngineFingerprint(Array(32).fill('AB').join(':')), 'ab'.repeat(32));
});

test('client refreshes address after DHCP changes and pins only the chosen server', () => {
  const base = options();
  base.settings = { ...base.settings, role: 'client', serverDeviceId: 'server-id' };
  base.devices = [peer('server-id', { addresses: ['10.1.0.22', 'fe80::1234%eth0'], inputPort: 25100, role: 'server' }), peer('other', { engineFingerprint: 'ef'.repeat(32) })];
  const generated = createEngineConfig(base, '/config');
  assert.match(generated.settingsText, /remoteHost="10\.1\.0\.22,\[fe80::1234%eth0\]"/);
  assert.match(generated.settingsText, /port=25100/);
  assert.equal(generated.trust, `v2:sha256:${'ab'.repeat(32)}\n`);
  base.devices[0].addresses = ['192.168.2.50'];
  assert.match(createEngineConfig(base, '/config').settingsText, /remoteHost="192\.168\.2\.50"/);
});

test('invalid ports, overlapping screens and unpaired servers are rejected', () => {
  const base = options();
  assert.throws(() => createEngineConfig({ ...base, settings: { ...base.settings, port: 0 } }, '/config'), /porta/);
  assert.throws(() => createEngineConfig({ ...base, layout: [{ deviceId: 'local-id', x: 0, y: 0 }, { deviceId: 'paired-id', x: 0, y: 0 }] }, '/config'), /posição/);
  assert.throws(() => createEngineConfig({ ...base, settings: { ...base.settings, role: 'client', serverDeviceId: 'stranger' } }, '/config'), /pareado/);
});

test('native client parses generated configuration and TLS in isolation', { skip: !process.env.HEYMOUSE_TEST_NATIVE }, async () => {
  const selfsigned = await import('selfsigned');
  const credentials = await selfsigned.generate([{ name: 'commonName', value: 'HeyMouse test' }], { keySize: 2048, algorithm: 'sha256' });
  const dir = await mkdtemp(path.join(os.tmpdir(), 'heymouse-engine-test-'));
  const manager = new EngineManager({ dataDir: dir, resourcesDir: path.resolve('resources/engine') });
  let child: ChildProcess | null = null;
  try {
    const detected = await manager.detect();
    assert.equal(detected.available, true, detected.message);
    const config = createEngineConfig(options({
      devices: [peer('test-server', { addresses: ['127.0.0.1'], inputPort: 25491, role: 'server' })],
      layout: [], settings: { ...options().settings, role: 'client', serverDeviceId: 'test-server' },
    }), dir);
    await mkdir(path.join(dir, 'tls'));
    await Promise.all([
      writeFile(config.settingsPath, config.settingsText),
      writeFile(config.linksPath, config.linksText),
      writeFile(config.certificatePath, `${credentials.private}\n${credentials.cert}`, { mode: 0o600 }),
      writeFile(path.join(dir, 'tls', 'trusted-servers'), config.trust),
    ]);
    // Client-only, loopback, no server: does not capture or send any real input.
    child = spawn(detected.path!, ['client', '--new-instance', '--settings', config.settingsPath], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout?.on('data', (data) => { output += data.toString(); });
    child.stderr?.on('data', (data) => { output += data.toString(); });
    await new Promise((resolve) => setTimeout(resolve, 1800));
    assert.equal(child.exitCode, null, output);
    assert.ok(!/cannot read configuration|unknown computer|failed to load config|no valid server addresses/i.test(output), output);
    assert.match(output, /127\.0\.0\.1|configured 1 server|connecting/i);
  } finally {
    if (child && child.exitCode === null) {
      const processToStop = child;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { processToStop.kill('SIGKILL'); resolve(); }, 1500);
        processToStop.once('exit', () => { clearTimeout(timer); resolve(); });
        processToStop.kill();
      });
    }
    assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(dir).startsWith('heymouse-engine-test-'));
    await rm(dir, { recursive: true, force: true });
  }
});
