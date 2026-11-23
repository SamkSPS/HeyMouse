import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, rmdir, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import test from 'node:test';
import type { EngineSettings, Settings, ScreenPlacement } from '../shared/types';
import { publicKeyFingerprint } from './discovery';
import { Store, validateLayout, validateSettings, type SavedState, type TrustedPeer } from './store';

const LOCAL_ID = 'a'.repeat(32);
const REMOTE_ID = 'b'.repeat(32);

function defaults(): Settings {
  return new Store('unused', LOCAL_ID).state.settings;
}

function peer(): TrustedPeer {
  const { publicKey } = generateKeyPairSync('ed25519');
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const fingerprint = publicKeyFingerprint(pem);
  return {
    publicKey: pem, tlsFingerprint: 'c'.repeat(64),
    device: {
      id: fingerprint.slice(0, 32), name: 'Notebook', platform: 'linux', hostname: 'notebook',
      addresses: ['192.168.1.20'], controlPort: 47856, inputPort: 24800,
      online: true, lastSeen: 123_000, paired: true, fingerprint,
      engineAvailable: true, engineFingerprint: 'c'.repeat(64), role: 'client',
    },
  };
}

async function temporaryStore(run: (directory: string, store: Store) => Promise<void>): Promise<void> {
  const temporaryRoot = tmpdir();
  const directory = await mkdtemp(join(temporaryRoot, 'heymouse-store-'));
  try {
    await run(directory, new Store(directory, LOCAL_ID));
  } finally {
    // This is the exact temporary directory created above, never a caller-provided path.
    assert.equal(dirname(directory), temporaryRoot);
    assert.ok(directory.startsWith(join(temporaryRoot, 'heymouse-store-')));
    await rm(directory, { recursive: true, force: true });
  }
}

test('settings merge partial updates without changing stable screen identity or mutating current state', () => {
  const current = defaults();
  const before = structuredClone(current);
  const next = validateSettings(current, { deviceName: '  Mesa principal  ', engine: { port: 25001, screenName: REMOTE_ID } as EngineSettings });
  assert.equal(next.deviceName, 'Mesa principal');
  assert.equal(next.engine.port, 25001);
  assert.equal(next.engine.role, current.engine.role);
  assert.equal(next.engine.screenName, LOCAL_ID);
  assert.equal(next.closeToTray, current.closeToTray);
  assert.deepEqual(current, before);
});

test('settings reject invalid user-visible names and malformed patch containers', () => {
  for (const name of ['', '   ', 'a'.repeat(65), 'hello\nworld', 'hello\0world', 1, null]) {
    assert.throws(() => validateSettings(defaults(), { deviceName: name } as Partial<Settings>));
  }
  for (const patch of [null, [], 1, 'text']) {
    assert.throws(() => validateSettings(defaults(), patch as unknown as Partial<Settings>));
  }
});

test('settings validate engine role, port, executable path and remote identity', () => {
  const invalid = [
    { role: 'host' }, { role: null }, { port: 0 }, { port: 1023 }, { port: 65536 },
    { port: 24800.5 }, { port: '24800' }, { port: NaN },
    { executablePath: 'bad\0path' }, { executablePath: 'a'.repeat(4097) },
    { executablePath: 1 }, { serverDeviceId: 'hostname' }, { serverDeviceId: 'g'.repeat(32) },
  ];
  for (const engine of invalid) {
    assert.throws(() => validateSettings(defaults(), { engine } as unknown as Partial<Settings>), JSON.stringify(engine));
  }
  const valid = validateSettings(defaults(), { engine: { port: 65535, serverDeviceId: REMOTE_ID, role: 'client' } as EngineSettings });
  assert.equal(valid.engine.serverDeviceId, REMOTE_ID);
  assert.equal(valid.engine.port, 65535);
});

test('settings enforce booleans for startup, discovery and tray behavior', () => {
  for (const field of ['startMinimized', 'closeToTray', 'discoveryEnabled'] as const) {
    for (const value of [0, 1, 'false', null]) {
      assert.throws(() => validateSettings(defaults(), { [field]: value } as unknown as Partial<Settings>));
    }
  }
  assert.throws(() => validateSettings(defaults(), { engine: { autoStart: 'false' } as unknown as EngineSettings }));
});

test('settings reject malformed nested engine containers', () => {
  for (const engine of [null, [], 42, 'engine']) {
    assert.throws(() => validateSettings(defaults(), { engine } as unknown as Partial<Settings>));
  }
});

test('settings ignore unknown keys and always retain the local screen name', () => {
  const updated = validateSettings(defaults(), { unknown: true, engine: { screenName: 'untrusted', unknown: true } } as unknown as Partial<Settings>);
  assert.equal(updated.engine.screenName, LOCAL_ID);
  assert.equal(Object.hasOwn(updated, 'unknown'), false);
  assert.equal(Object.hasOwn(updated.engine, 'unknown'), false);
});

test('layout accepts a usable arrangement and rejects collisions, duplicates and untrusted devices', () => {
  const known = new Set([LOCAL_ID, REMOTE_ID]);
  const good = [{ deviceId: LOCAL_ID, x: 0, y: 0 }, { deviceId: REMOTE_ID, x: 1, y: 0 }];
  assert.deepEqual(validateLayout(good, known), good);
  const invalid = [
    [{ deviceId: LOCAL_ID, x: 0, y: 0 }, { deviceId: REMOTE_ID, x: 0, y: 0 }],
    [{ deviceId: LOCAL_ID, x: 0, y: 0 }, { deviceId: LOCAL_ID, x: 1, y: 0 }],
    [{ deviceId: 'untrusted', x: 0, y: 0 }],
    [{ deviceId: LOCAL_ID, x: 8.1, y: 0 }], [{ deviceId: LOCAL_ID, x: 9, y: 0 }],
    [{ deviceId: LOCAL_ID, x: 0, y: -9 }], [{ deviceId: LOCAL_ID, x: NaN, y: 0 }],
    [{ deviceId: LOCAL_ID, x: '1', y: 0 }], [null], null,
  ];
  for (const layout of invalid) {
    assert.throws(() => validateLayout(layout as ScreenPlacement[], known));
  }
});

test('fresh store creates its directory and starts with local defaults', async () => temporaryStore(async (directory) => {
  const nested = new Store(join(directory, 'nested'), LOCAL_ID);
  await nested.load();
  assert.equal(nested.state.version, 1);
  assert.equal(nested.state.settings.engine.screenName, LOCAL_ID);
  assert.equal(nested.state.settings.engine.autoStart, false);
  assert.deepEqual(nested.state.peers, []);
  assert.deepEqual(nested.state.layout, [{ deviceId: LOCAL_ID, x: 0, y: 0 }]);
}));

test('save and load preserve settings and pairing but reset stale online state', async () => temporaryStore(async (directory, store) => {
  await store.load();
  const trusted = peer();
  store.state.settings = validateSettings(store.state.settings, { deviceName: 'Minha mesa', closeToTray: false });
  store.state.peers = [trusted];
  store.state.layout.push({ deviceId: trusted.device.id, x: 1, y: 0 });
  await store.save();
  assert.deepEqual((await readdir(directory)).sort(), ['settings.json']);
  const restored = new Store(directory, LOCAL_ID);
  await restored.load();
  assert.equal(restored.state.settings.deviceName, 'Minha mesa');
  assert.equal(restored.state.settings.closeToTray, false);
  assert.equal(restored.state.peers[0].device.online, false);
  assert.equal(restored.state.peers[0].device.paired, true);
  assert.equal(restored.state.peers[0].publicKey, trusted.publicKey);
  assert.equal(restored.state.peers[0].tlsFingerprint, trusted.tlsFingerprint);
  assert.deepEqual(restored.state.layout, store.state.layout);
}));

test('queued atomic saves serialize snapshots and leave the last complete document', async () => temporaryStore(async (directory, store) => {
  await store.load();
  const pending: Promise<void>[] = [];
  for (let index = 0; index < 25; index++) {
    store.state.settings.deviceName = `Device ${index}`;
    pending.push(store.save());
  }
  store.state.settings.deviceName = 'Unsaved mutation';
  await Promise.all(pending);
  const persisted = JSON.parse(await readFile(join(directory, 'settings.json'), 'utf8')) as SavedState;
  assert.equal(persisted.settings.deviceName, 'Device 24');
  assert.deepEqual((await readdir(directory)).sort(), ['settings.json']);
}));

test('a failed save does not poison subsequent saves', async () => temporaryStore(async (directory, store) => {
  await store.load();
  const destination = join(directory, 'settings.json');
  await mkdir(destination);
  await assert.rejects(store.save());
  await rmdir(destination);
  store.state.settings.deviceName = 'Recovered';
  await store.save();
  const persisted = JSON.parse(await readFile(destination, 'utf8')) as SavedState;
  assert.equal(persisted.settings.deviceName, 'Recovered');
}));

test('load reports corrupt and incompatible saved files without overwriting them', async () => temporaryStore(async (directory, store) => {
  const path = join(directory, 'settings.json');
  for (const content of ['{broken', '{"version":2,"peers":[],"layout":[]}', 'null']) {
    await writeFile(path, content, 'utf8');
    await assert.rejects(store.load());
    assert.equal(await readFile(path, 'utf8'), content);
    assert.equal(store.state.settings.engine.screenName, LOCAL_ID);
  }
}));

test('load rejects a persisted layout that overlaps or references an unpaired device', async () => temporaryStore(async (directory, store) => {
  await store.load();
  const trusted = peer();
  store.state.peers = [trusted];
  const invalid = [
    [{ deviceId: LOCAL_ID, x: 0, y: 0 }, { deviceId: trusted.device.id, x: 0, y: 0 }],
    [{ deviceId: LOCAL_ID, x: 0, y: 0 }, { deviceId: REMOTE_ID, x: 1, y: 0 }],
  ];
  for (const layout of invalid) {
    await writeFile(join(directory, 'settings.json'), JSON.stringify({ ...store.state, layout }), 'utf8');
    await assert.rejects(new Store(directory, LOCAL_ID).load());
  }
}));

test('load rejects invalid pairing identities instead of trusting corrupt persisted entries', async () => temporaryStore(async (directory, store) => {
  await store.load();
  for (const trusted of [
    { ...peer(), publicKey: 'not-a-key' },
    { ...peer(), tlsFingerprint: 'not-a-certificate' },
    { ...peer(), device: { ...peer().device, id: REMOTE_ID } },
    { ...peer(), device: { ...peer().device, engineFingerprint: 'd'.repeat(64) } },
  ]) {
    await writeFile(join(directory, 'settings.json'), JSON.stringify({ ...store.state, peers: [trusted] }), 'utf8');
    await assert.rejects(new Store(directory, LOCAL_ID).load());
  }
}));

test('load normalizes certificate pins, rejects duplicate peers and requires the local screen', async () => temporaryStore(async (directory, store) => {
  await store.load();
  const trusted = peer();
  trusted.device.engineFingerprint = 'CC:'.repeat(31) + 'CC';
  store.state.peers = [trusted];
  await store.save();
  const restored = new Store(directory, LOCAL_ID);
  await restored.load();
  assert.equal(restored.state.peers[0].device.engineFingerprint, 'c'.repeat(64));
  for (const changed of [
    { ...store.state, peers: [trusted, trusted] },
    { ...store.state, layout: [{ deviceId: trusted.device.id, x: 0, y: 0 }] },
    { ...store.state, layout: [] },
  ]) {
    await writeFile(join(directory, 'settings.json'), JSON.stringify(changed), 'utf8');
    await assert.rejects(new Store(directory, LOCAL_ID).load());
  }
}));
