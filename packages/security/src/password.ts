import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';

const N = 16384, R = 8, P = 1, KEYLEN = 64;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [n, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  if (![n, r, p].every(Number.isInteger)) return false;
  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');
  if (!expected.length) return false;
  const actual = scryptSync(password, salt, expected.length, { N: n, r, p });
  return timingSafeEqual(actual, expected);
}

/** Returns a list of problems; empty means acceptable. */
export function passwordProblems(password: string): string[] {
  const problems: string[] = [];
  if (password.length < 12) problems.push('must be at least 12 characters');
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password)) problems.push('must mix upper and lower case letters');
  if (!/\d/.test(password)) problems.push('must include a number');
  if (/^(.)\1+$/.test(password) || /password|123456|qwerty/i.test(password)) problems.push('is too easy to guess');
  return problems;
}
