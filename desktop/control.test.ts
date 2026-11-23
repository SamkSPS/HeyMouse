import assert from 'node:assert/strict';
import test from 'node:test';
import { ControlServer } from './control';
import { decodeAnnouncement, encodeAnnouncement, type DiscoveredDevice } from './discovery';
import { certificateFingerprint, createIdentity, fingerprint, identityId, signPayload, verifyPayload } from './identity';
import type { TrustedPeer } from './store';

test('a signed LAN announcement enables one-time short-code pairing over pinned TLS', async () => {
  const makeDevice = async (name: string) => {
    const identity = await createIdentity();
    const peers = new Map<string, TrustedPeer>();
    const discovered: DiscoveredDevice[] = [];
    const getDevice = () => ({
      id: identityId(identity.publicKey), name, hostname: name, platform: 'darwin' as const,
      addresses: ['127.0.0.1'], controlPort: control.port, inputPort: 24800,
      online: true, lastSeen: Date.now(), paired: true, fingerprint: fingerprint(identity.publicKey),
      engineFingerprint: certificateFingerprint(identity.certificate), engineAvailable: true, role: 'server' as const,
    });
    const control = new ControlServer({
      identity, getDevice, allowLoopback: true,
      getDiscovered: () => discovered,
      getPeer: id => peers.get(id),
      onPair: async peer => { peers.set(peer.device.id, peer); },
    });
    return { control, identity, peers, discovered, getDevice };
  };

  const [host, joiner] = await Promise.all([makeDevice('host'), makeDevice('joiner')]);
  try {
    await Promise.all([host.control.start(0, '127.0.0.1'), joiner.control.start(0, '127.0.0.1')]);
    const invite = host.control.createInvite();
    assert.match(invite.code, /^[2-9A-HJ-NP-Z]{4}(?:-[2-9A-HJ-NP-Z]{4}){2}$/);
    const packet = encodeAnnouncement({
      ...host.getDevice(), publicKey: host.identity.publicKey, inviteProof: host.control.inviteProof(),
    }, payload => signPayload(payload, host.identity.privateKey));
    const announcement = decodeAnnouncement(packet, verifyPayload);
    assert.ok(announcement);
    const discovered = { ...host.getDevice(), ...announcement.device, paired: false };
    joiner.discovered.push({ ...discovered, engineFingerprint: '0'.repeat(64) });
    await assert.rejects(joiner.control.pair(invite.code), /Código não encontrado/);
    joiner.discovered.splice(0, 1, discovered);
    const replacement = invite.code[0] === '2' ? '3' : '2';
    await assert.rejects(joiner.control.pair(replacement + invite.code.slice(1)), /Código não encontrado/);
    const peer = await joiner.control.pair(invite.code.toLowerCase().replaceAll('-', ' '));
    assert.equal(peer.device.id, host.getDevice().id);
    assert.equal(host.peers.get(joiner.getDevice().id)?.publicKey, joiner.identity.publicKey);
    assert.equal(joiner.peers.get(host.getDevice().id)?.publicKey, host.identity.publicKey);
    assert.equal(host.control.inviteProof(), undefined);
    await assert.rejects(joiner.control.pair(invite.code), /já utilizado/);
  } finally {
    await Promise.all([host.control.stop(), joiner.control.stop()]);
  }
});
