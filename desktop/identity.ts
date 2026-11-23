import { createHash, createPublicKey, generateKeyPairSync, sign, verify, X509Certificate } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { generate } from 'selfsigned';

export interface Identity { publicKey: string; privateKey: string; certificate: string; tlsKey: string }
export function fingerprint(publicKey: string): string {
  const key = createPublicKey(publicKey);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Chave de identidade inválida.');
  return createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex');
}
export function certificateFingerprint(certificate: string | Buffer): string {
  return createHash('sha256').update(new X509Certificate(certificate).raw).digest('hex');
}
export function identityId(publicKey: string): string { return fingerprint(publicKey).slice(0, 32); }
export function signPayload(payload: string, privateKey: string): string {
  return sign(null, Buffer.from(payload), privateKey).toString('base64');
}
export function verifyPayload(payload: string, signature: string, publicKey: string): boolean {
  try { return verify(null, Buffer.from(payload), publicKey, Buffer.from(signature, 'base64')); }
  catch { return false; }
}
export async function createIdentity(): Promise<Identity> {
  const keys = generateKeyPairSync('ed25519', { publicKeyEncoding: { format: 'pem', type: 'spki' }, privateKeyEncoding: { format: 'pem', type: 'pkcs8' } });
  const cert = await generate([{ name: 'commonName', value: 'HeyMouse' }], {
    keySize: 2048, algorithm: 'sha256', notAfterDate: new Date(Date.now() + 10 * 365 * 86400_000),
    extensions: [ { name: 'basicConstraints', cA: false }, { name: 'keyUsage', digitalSignature: true, keyEncipherment: true }, { name: 'extKeyUsage', serverAuth: true, clientAuth: true } ],
  });
  return { ...keys, certificate: cert.cert, tlsKey: cert.private };
}
export async function loadIdentity(dataDir: string): Promise<Identity> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const path = join(dataDir, 'identity.json');
  try {
    const identity = JSON.parse(await readFile(path, 'utf8')) as Identity;
    fingerprint(identity.publicKey);
    certificateFingerprint(identity.certificate);
    if (!verifyPayload('check', signPayload('check', identity.privateKey), identity.publicKey)) throw new Error('Chaves inconsistentes.');
    return identity;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Não foi possível ler a identidade salva. Preserve identity.json para recuperar seus pareamentos.', { cause: error });
  }
  const identity = await createIdentity();
  await writeFile(path, JSON.stringify(identity), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return identity;
}
