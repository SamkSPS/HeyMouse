import assert from 'node:assert/strict';
import test from 'node:test';
import { ControlServer } from './control';
import { decodeAnnouncement, encodeAnnouncement, type DiscoveredDevice } from './discovery';
import { certificateFingerprint, createIdentity, fingerprint, identityId, signPayload, verifyPayload } from './identity';
import type { TrustedPeer } from './store';

test('six-digit pairing persists trust only after the host confirms', async () => {
  let respond: ((approved: boolean) => void) | undefined;
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
      confirmPair: async () => new Promise<boolean>(resolve => { respond = resolve; }),
    });
    return { control, identity, peers, discovered, getDevice };
  };

  const [host, joiner] = await Promise.all([makeDevice('host'), makeDevice('joiner')]);
  try {
    await Promise.all([host.control.start(0, '127.0.0.1'), joiner.control.start(0, '127.0.0.1')]);
    const advertise = () => {
      const invite = host.control.createInvite();
      assert.match(invite.code, /^\d{6}$/);
      const packet = encodeAnnouncement({
        ...host.getDevice(), publicKey: host.identity.publicKey, pairingSession: host.control.pairingSession(),
      }, payload => signPayload(payload, host.identity.privateKey));
      const announcement = decodeAnnouncement(packet, verifyPayload);
      assert.ok(announcement);
      joiner.discovered.splice(0, 1, { ...host.getDevice(), ...announcement.device, paired: false });
      return invite.code;
    };
    const answer = async (approved: boolean) => {
      for (let i = 0; i < 100 && !respond; i++) await new Promise(resolve => setTimeout(resolve, 10));
      assert.ok(respond);
      assert.equal(host.peers.size, 0);
      assert.equal(joiner.peers.size, 0);
      respond(approved);
      respond = undefined;
    };
    const code = advertise();
    const replacement = code[0] === '0' ? '1' : '0';
    await assert.rejects(joiner.control.pair(replacement + code.slice(1)), /Código incorreto/);
    assert.equal(respond, undefined);
    const rejected = assert.rejects(joiner.control.pair(code), /Pareamento recusado/);
    await answer(false);
    await rejected;
    assert.equal(host.peers.size, 0);
    assert.equal(joiner.peers.size, 0);
    const newCode = advertise();
    const pending = joiner.control.pair(newCode);
    await answer(true);
    const peer = await pending;
    assert.equal(peer.device.id, host.getDevice().id);
    assert.equal(host.peers.get(joiner.getDevice().id)?.publicKey, joiner.identity.publicKey);
    assert.equal(joiner.peers.get(host.getDevice().id)?.publicKey, host.identity.publicKey);
    assert.equal(host.control.pairingSession(), undefined);
    await assert.rejects(joiner.control.pair(newCode), /já utilizado/);
  } finally {
    await Promise.all([host.control.stop(), joiner.control.stop()]);
  }
});
