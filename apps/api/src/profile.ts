import { isSensitiveField } from '../../../packages/core/src/mapping';

export type StoredProfile = Record<string, unknown>;

const STRING_FIELDS = [
  'firstName', 'lastName', 'preferredName', 'email', 'phone', 'dateOfBirth',
  'addressLine1', 'addressLine2', 'city', 'state', 'postalCode', 'country',
];
const STRING_LISTS = ['membershipInterests', 'rewardsPrograms', 'subscriptionPreferences'];
const OBJECT_LISTS: Record<string, string[]> = {};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE = /^[+()\d\s.-]{7,20}$/;

export function validateProfile(input: unknown): { ok: true; profile: StoredProfile } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, errors: ['profile must be an object'] };
  const out: StoredProfile = {};

  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (isSensitiveField(key)) {
      errors.push(`"${key}": numbers like this are never stored. A person types them directly into the website.`);
    } else if (STRING_FIELDS.includes(key)) {
      if (typeof value !== 'string') { errors.push(`"${key}" must be text`); continue; }
      let v = value.trim();
      if (v.length > 500) { errors.push(`"${key}" is too long`); continue; }
      if (!v) continue; // empty means not provided
      if (key === 'email' && !EMAIL.test(v)) { errors.push('"email" is not a valid email address'); continue; }
      if (key === 'phone' && !PHONE.test(v)) { errors.push('"phone" is not a valid phone number'); continue; }
      if (key === 'dateOfBirth') {
        const us = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(v);   // MM-DD-YYYY is what people type; it is stored as YYYY-MM-DD
        if (us) v = `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`;
        const d = new Date(v + 'T00:00:00Z');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v || d > new Date())
          { errors.push('"dateOfBirth" must be a real past date like 04-25-1990'); continue; }
      }
      out[key] = v;
    } else if (key === 'siteCount') {
      const v = String(value).trim().toLowerCase();
      const n = Number(v);
      if (v !== 'all' && !(Number.isInteger(n) && n >= 1 && n <= 5000)) { errors.push('"siteCount" must be "all" or a whole number from 1 to 5000'); continue; }
      out[key] = v;
    } else if (STRING_LISTS.includes(key)) {
      if (!Array.isArray(value) || value.length > 50 || value.some(x => typeof x !== 'string' || x.length > 200))
        { errors.push(`"${key}" must be a list of short text items (max 50)`); continue; }
      const items = value.map(x => (x as string).trim()).filter(Boolean);
      if (items.length) out[key] = items;
    } else if (key in OBJECT_LISTS) {
      const allowed = OBJECT_LISTS[key];
      if (!Array.isArray(value) || value.length > 30) { errors.push(`"${key}" must be a list (max 30 entries)`); continue; }
      const entries: Record<string, string>[] = [];
      let bad = false;
      for (const item of value) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) { bad = true; break; }
        const e: Record<string, string> = {};
        for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
          if (!allowed.includes(k) || typeof v !== 'string' || v.length > 2000) { bad = true; break; }
          if (v.trim()) e[k] = v.trim();
        }
        if (bad) break;
        if (Object.keys(e).length) entries.push(e);
      }
      if (bad) errors.push(`"${key}" has an invalid entry (allowed fields: ${allowed.join(', ')})`);
      else if (entries.length) out[key] = entries;
    } else {
      errors.push(`"${key}" is not a known profile field`);
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, profile: out };
}

const BASE_REQUIRED: [string, string][] = [
  ['firstName', 'first name'], ['lastName', 'last name'], ['email', 'email'], ['phone', 'phone'],
  ['addressLine1', 'street address'], ['city', 'city'], ['state', 'state'], ['postalCode', 'postal code'],
  ['siteCount', 'how many sites the client wants to join'],
];
const BY_CATEGORY: Record<string, [string, string][]> = {
  membership: [['membershipInterests', 'membership interests']],
  rewards: [['rewardsPrograms', 'preferred rewards programs']],
  subscription: [['subscriptionPreferences', 'subscription preferences']],
};

/** Missing-information alerts: what is still needed before applications in these categories can be filled. */
export function missingInfo(profile: StoredProfile, categories: string[] = []): string[] {
  const needed = [...BASE_REQUIRED, ...categories.flatMap(c => BY_CATEGORY[c] ?? [])];
  return needed.filter(([key]) => {
    const v = profile[key];
    return v === undefined || (Array.isArray(v) && v.length === 0);
  }).map(([, label]) => label);
}
