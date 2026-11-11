import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

/**
 * Envelope encryption: every client gets their own random data key (DEK). The DEK encrypts that client's
 * profile; the master key (kept outside the database) encrypts the DEK. Both layers are AES-256-GCM and are
 * bound to the client's id, so a ciphertext copied onto another client's row will refuse to decrypt.
 */
const ALG = 'aes-256-gcm';
const VERSION = 1;

export function generateMasterKey(): string {
  return randomBytes(32).toString('base64');
}

export function parseMasterKey(b64: string): Buffer {
  const k = Buffer.from(b64, 'base64');
  if (k.length !== 32) throw new Error('MASTER_ENCRYPTION_KEY must be 32 random bytes, base64-encoded');
  return k;
}

function seal(key: Buffer, plaintext: Buffer, aad: string): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv(ALG, key, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, c.getAuthTag(), ct]); // [1][12 iv][16 tag][ciphertext]
}

function open(key: Buffer, blob: Buffer, aad: string): Buffer {
  if (blob.length < 30 || blob[0] !== VERSION) throw new Error('unrecognized ciphertext format');
  const d = createDecipheriv(ALG, key, blob.subarray(1, 13));
  d.setAuthTag(blob.subarray(13, 29));
  d.setAAD(Buffer.from(aad));
  return Buffer.concat([d.update(blob.subarray(29)), d.final()]); // throws if key, client id or data is wrong
}

export function newClientKey(master: Buffer, clientId: string): { dek: Buffer; wrappedDek: Buffer } {
  const dek = randomBytes(32);
  return { dek, wrappedDek: seal(master, dek, `dek:${clientId}`) };
}

export function unwrapClientKey(master: Buffer, wrappedDek: Buffer, clientId: string): Buffer {
  return open(master, wrappedDek, `dek:${clientId}`);
}

export function encryptProfile(dek: Buffer, clientId: string, profile: unknown): Buffer {
  return seal(dek, Buffer.from(JSON.stringify(profile), 'utf8'), `profile:${clientId}`);
}

export function decryptProfile(dek: Buffer, clientId: string, blob: Buffer): unknown {
  return JSON.parse(open(dek, blob, `profile:${clientId}`).toString('utf8'));
}

/** Logins made for a client are sealed with that client's own key, separately from the profile. */
export function encryptLogin(dek: Buffer, clientId: string, login: unknown): Buffer {
  return seal(dek, Buffer.from(JSON.stringify(login), 'utf8'), `login:${clientId}`);
}
export function decryptLogin(dek: Buffer, clientId: string, blob: Buffer): unknown {
  return JSON.parse(open(dek, blob, `login:${clientId}`).toString('utf8'));
}
