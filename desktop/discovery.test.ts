import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, verify } from 'node:crypto';
import test from 'node:test';
import {
  Discovery, MAX_PACKET_BYTES, OFFLINE_AFTER, decodeAnnouncement,
  encodeAnnouncement, publicKeyFingerprint, type Announcement, type DiscoveredDevice,
} from './discovery.js';

function identity(name = 'Desktop'): { announcement: Announcement; sign: (payload: string) => string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const fingerprint = publicKeyFingerprint(pem);
  return {
    announcement: {
      id: fingerprint.slice(0, 32), name, platform: 'win32', hostname: 'desktop',
      controlPort: 47856, inputPort: 24800, fingerprint, publicKey: pem,
      engineAvailable: true, role: 'server',
    },
    sign: (payload) => sign(null, Buffer.from(payload), privateKey).toString('base64'),
  };
}

const verifyPayload = (payload: string, signature: string, publicKey: string) =>
  verify(null, Buffer.from(payload), publicKey, Buffer.from(signature, 'base64'));

function resignPacket(packet: Buffer, mutate: (payload: Record<string, unknown>) => void, signer: (value: string) => string): Buffer {
  const envelope = JSON.parse(packet.toString());
  const payload = JSON.parse(envelope.payload);
  mutate(payload);
  const text = JSON.stringify(payload);
  return Buffer.from(JSON.stringify({ payload: text, signature: signer(text) }));
}

test('announcement binds stable ID to its Ed25519 public key', () => {
  const a = identity();
  const packet = encodeAnnouncement(a.announcement, a.sign, 123_000);
  const decoded = decodeAnnouncement(packet, verifyPayload, 123_001);
  assert.equal(decoded?.device.id, a.announcement.id);
  assert.equal(decoded?.device.name, 'Desktop');
  assert.equal(decoded?.device.fingerprint, a.announcement.fingerprint);
});

test('rejects a valid signature when ID and public key do not match', () => {
  const a = identity();
  const b = identity();
  const packet = encodeAnnouncement(a.announcement, a.sign, 123_000);
  const changed = resignPacket(packet, (payload) => { (payload.device as Announcement).id = b.announcement.id; }, a.sign);
  assert.equal(decodeAnnouncement(changed, verifyPayload, 123_001), null);
});

test('rejects forged signatures, stale announcements, oversized and malformed datagrams', () => {
  const a = identity();
  const b = identity();
  const packet = encodeAnnouncement(a.announcement, a.sign, 123_000);
  const forged = resignPacket(packet, (payload) => { (payload.device as Announcement).name = 'Forged'; }, b.sign);
  assert.equal(decodeAnnouncement(forged, verifyPayload, 123_001), null);
  assert.equal(decodeAnnouncement(packet, verifyPayload, 500_000), null);
  assert.equal(decodeAnnouncement(Buffer.alloc(MAX_PACKET_BYTES + 1), verifyPayload), null);
  assert.equal(decodeAnnouncement(Buffer.from('{oops'), verifyPayload), null);
  assert.equal(decodeAnnouncement(Buffer.from('null'), verifyPayload), null);
});

test('rejects malicious announcement fields and non-Ed25519 identities', () => {
  const a = identity();
  const packet = encodeAnnouncement(a.announcement, a.sign, 123_000);
  for (const [key, value] of [['controlPort', -1], ['platform', 'injected'], ['name', 'bad\nname'], ['engineFingerprint', 'not-a-certificate']] as const) {
    const changed = resignPacket(packet, (payload) => { (payload.device as Record<string, unknown>)[key] = value; }, a.sign);
    assert.equal(decodeAnnouncement(changed, verifyPayload, 123_001), null);
  }
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 1024 });
  assert.throws(() => publicKeyFingerprint(publicKey.export({ type: 'spki', format: 'pem' }).toString()), /Ed25519/);
});

test('rediscovers the same identity after an IP change without trusting payload addresses', () => {
  const local = identity('Local');
  const peer = identity('Notebook');
  let now = 100_000;
  const discovery = new Discovery({ getAnnouncement: () => local.announcement, sign: local.sign, verify: verifyPayload, now: () => now });
  const devices: DiscoveredDevice[] = [];
  discovery.on('device', (device: DiscoveredDevice) => devices.push(device));
  const first = encodeAnnouncement(peer.announcement, peer.sign, now);
  discovery.acceptPacket(first, '192.168.1.20');
  now += OFFLINE_AFTER + 1;
  const moved = resignPacket(encodeAnnouncement(peer.announcement, peer.sign, now), (payload) => {
    (payload.device as unknown as Record<string, unknown>).addresses = ['203.0.113.1'];
  }, peer.sign);
  discovery.acceptPacket(moved, '192.168.1.90');
  assert.equal(devices.length, 2);
  assert.equal(devices[0].id, devices[1].id);
  assert.deepEqual(devices[1].addresses, ['192.168.1.90']);
  assert.equal(devices[1].paired, false);
});

test('replays cannot keep a disconnected device online', () => {
  const local = identity('Local');
  const peer = identity('Notebook');
  let now = 100_000;
  const discovery = new Discovery({ getAnnouncement: () => local.announcement, sign: local.sign, verify: verifyPayload, now: () => now });
  const offline: string[] = [];
  let seen = 0;
  discovery.on('device', () => { seen += 1; });
  discovery.on('offline', (id: string) => offline.push(id));
  const packet = encodeAnnouncement(peer.announcement, peer.sign, now);
  discovery.acceptPacket(packet, '192.168.1.20');
  now += OFFLINE_AFTER - 1;
  discovery.acceptPacket(packet, '192.168.1.20');
  discovery.expire();
  assert.deepEqual(offline, []);
  now += 1;
  discovery.expire();
  assert.equal(seen, 1);
  assert.deepEqual(offline, [peer.announcement.id]);
  discovery.expire();
  assert.equal(offline.length, 1);
});

test('newly observed IP is preferred immediately, while older interfaces remain available', () => {
  const local = identity('Local');
  const peer = identity('Notebook');
  let now = 100_000;
  const discovery = new Discovery({ getAnnouncement: () => local.announcement, sign: local.sign, verify: verifyPayload, now: () => now });
  const devices: DiscoveredDevice[] = [];
  discovery.on('device', (device: DiscoveredDevice) => devices.push(device));
  discovery.acceptPacket(encodeAnnouncement(peer.announcement, peer.sign, now), '192.168.1.20');
  now += 1_000;
  discovery.acceptPacket(encodeAnnouncement(peer.announcement, peer.sign, now), '192.168.1.90');
  assert.deepEqual(devices[1].addresses, ['192.168.1.90', '192.168.1.20']);
});

test('ignores own identity, invalid sources and rollback announcements', () => {
  const local = identity('Local');
  const peer = identity('Notebook');
  let now = 100_000;
  const discovery = new Discovery({ getAnnouncement: () => local.announcement, sign: local.sign, verify: verifyPayload, now: () => now });
  const devices: DiscoveredDevice[] = [];
  discovery.on('device', (device: DiscoveredDevice) => devices.push(device));
  discovery.acceptPacket(encodeAnnouncement(local.announcement, local.sign, now), '192.168.1.20');
  discovery.acceptPacket(encodeAnnouncement(peer.announcement, peer.sign, now), '255.255.255.255');
  discovery.acceptPacket(encodeAnnouncement(peer.announcement, peer.sign, now), '127.0.0.1');
  discovery.acceptPacket(encodeAnnouncement(peer.announcement, peer.sign, now), 'hostname.example');
  const older = encodeAnnouncement(peer.announcement, peer.sign, now);
  now += 3_000;
  discovery.acceptPacket(encodeAnnouncement(peer.announcement, peer.sign, now), '192.168.1.90');
  discovery.acceptPacket(older, '192.168.1.20');
  assert.equal(devices.length, 1);
  assert.deepEqual(devices[0].addresses, ['192.168.1.90']);
});
