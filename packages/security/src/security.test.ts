import { describe, it, expect } from 'vitest';
import {
  generateMasterKey, parseMasterKey, newClientKey, unwrapClientKey, encryptProfile, decryptProfile,
  hashPassword, verifyPassword, passwordProblems, redact, redactObject, can, canAccessClient,
} from './index';

const master = parseMasterKey(generateMasterKey());
const profile = { legalName: 'Test Person', email: 'test.person@example.com' };

describe('per-client encryption', () => {
  it('round-trips a profile and never stores it readable', () => {
    const { dek } = newClientKey(master, 'client-a');
    const blob = encryptProfile(dek, 'client-a', profile);
    expect(blob.toString('utf8').includes('Test Person')).toBe(false);
    expect(decryptProfile(dek, 'client-a', blob)).toEqual(profile);
  });
  it('encrypting the same data twice gives different ciphertext', () => {
    const { dek } = newClientKey(master, 'client-a');
    expect(encryptProfile(dek, 'client-a', profile).equals(encryptProfile(dek, 'client-a', profile))).toBe(false);
  });
  it('wrapped keys unwrap with the master key only', () => {
    const { dek, wrappedDek } = newClientKey(master, 'client-a');
    expect(unwrapClientKey(master, wrappedDek, 'client-a').equals(dek)).toBe(true);
    const otherMaster = parseMasterKey(generateMasterKey());
    expect(() => unwrapClientKey(otherMaster, wrappedDek, 'client-a')).toThrow();
  });
  it('a profile copied onto another client cannot be decrypted (client isolation)', () => {
    const a = newClientKey(master, 'client-a');
    const blob = encryptProfile(a.dek, 'client-a', profile);
    expect(() => decryptProfile(a.dek, 'client-b', blob)).toThrow();
    const b = newClientKey(master, 'client-b');
    expect(() => decryptProfile(b.dek, 'client-b', blob)).toThrow();
    expect(() => unwrapClientKey(master, a.wrappedDek, 'client-b')).toThrow();
  });
  it('detects tampering', () => {
    const { dek } = newClientKey(master, 'client-a');
    const blob = encryptProfile(dek, 'client-a', profile);
    blob[blob.length - 1] ^= 1;
    expect(() => decryptProfile(dek, 'client-a', blob)).toThrow();
  });
  it('rejects a bad master key', () => {
    expect(() => parseMasterKey('c2hvcnQ=')).toThrow();
  });
});

describe('passwords', () => {
  it('verifies the right password and rejects wrong ones', () => {
    const h = hashPassword('Correct-Horse-9');
    expect(verifyPassword('Correct-Horse-9', h)).toBe(true);
    expect(verifyPassword('Correct-Horse-8', h)).toBe(false);
    expect(h.includes('Correct-Horse')).toBe(false);
  });
  it('uses a fresh salt each time and rejects malformed hashes', () => {
    expect(hashPassword('Same-Password-1') === hashPassword('Same-Password-1')).toBe(false);
    expect(verifyPassword('x', 'garbage')).toBe(false);
  });
  it('flags weak passwords', () => {
    expect(passwordProblems('short')).toHaveLength(3);
    expect(passwordProblems('Tr1cky-Enough-Pass')).toEqual([]);
  });
});

describe('redaction', () => {
  it('removes emails, phones, SSNs and card numbers from text', () => {
    expect(redact('Call 415-555-0134 or a@b.com, SSN 123-45-6789, card 4111 1111 1111 1111'))
      .toBe('Call [PHONE] or [EMAIL], SSN [SSN], card [CARD]');
  });
  it('redacts sensitive keys in objects without mutating the input', () => {
    const input = { id: 7, legalName: 'Test Person', note: 'mail a@b.com', nested: { phone: '415-555-0134', ok: 'fine' } };
    const out = redactObject(input) as any;
    expect(out).toEqual({ id: 7, legalName: '[REDACTED]', note: 'mail [EMAIL]', nested: { phone: '[REDACTED]', ok: 'fine' } });
    expect(input.legalName).toBe('Test Person');
  });
});

describe('role permissions', () => {
  const viewer = { id: 'v', role: 'viewer' as const, assignedClientIds: ['c1'] };
  const op = { id: 'o', role: 'operator' as const, assignedClientIds: ['c1'] };
  const admin = { id: 'a', role: 'admin' as const, assignedClientIds: [] };
  it('viewers read but cannot write or approve', () => {
    expect(canAccessClient(viewer, 'c1', 'client:read')).toBe(true);
    expect(canAccessClient(viewer, 'c1', 'client:write')).toBe(false);
    expect(canAccessClient(viewer, 'c1', 'approval:grant')).toBe(false);
  });
  it('operators only reach their assigned clients', () => {
    expect(canAccessClient(op, 'c1', 'client:write')).toBe(true);
    expect(canAccessClient(op, 'c2', 'client:read')).toBe(false);
    expect(can(op, 'user:manage')).toBe(false);
  });
  it('admins manage users and see every client', () => {
    expect(can(admin, 'user:manage')).toBe(true);
    expect(can(admin, 'login:read')).toBe(true);
    expect(can(op, 'login:read')).toBe(false);
    expect(canAccessClient(admin, 'c2', 'client:delete')).toBe(true);
  });
});
