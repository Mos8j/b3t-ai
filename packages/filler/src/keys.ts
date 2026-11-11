import { canonicalKey, isSensitiveField } from '../../core/src/mapping';

/** What the software can read about one form control on the page. */
export interface ControlInfo {
  idx: number; tag: string; type: string; name: string; id: string; label: string; placeholder: string;
  autocomplete: string; required: boolean; options: { value: string; text: string }[];
}

const AUTOCOMPLETE: Record<string, string> = {
  'given-name': 'firstName', 'family-name': 'lastName', 'name': 'fullName', 'email': 'email', 'tel': 'phone', 'tel-national': 'phone',
  'street-address': 'addressLine1', 'address-line1': 'addressLine1', 'address-line2': 'addressLine2', 'address-level2': 'city',
  'address-level1': 'state', 'postal-code': 'postalCode', 'country': 'country', 'country-name': 'country', 'bday': 'dateOfBirth',
};
const EXTRA: [string, RegExp][] = [
  ['fullName', /^(full[\s_-]?name|your[\s_-]?name|name)$/i],
  ['dateOfBirth', /^(date[\s_-]?of[\s_-]?birth|dob|birth[\s_-]?date|birthday)$/i],
  ['addressLine2', /^(address[\s_-]?line[\s_-]?2|apt|apartment|suite|unit|address[\s_-]?2)$/i],
  ['country', /^(country)$/i],
  ['username', /^(user[\s_-]?name|login|login[\s_-]?name|screen[\s_-]?name|handle|user[\s_-]?id|choose a username)$/i],
];

export type Resolution = { kind: 'sensitive' } | { kind: 'password'; confirm: boolean } | { kind: 'key'; key: string } | { kind: 'unknown' };

/** Decides which stored profile field (if any) a form control is asking for. Never guesses beyond clear names. */
export function resolveControl(c: ControlInfo): Resolution {
  const names = [c.label, c.name, c.id, c.placeholder].map(x => x.trim()).filter(Boolean);
  if (names.some(isSensitiveField)) return { kind: 'sensitive' };
  if (c.type === 'password') return { kind: 'password', confirm: /(confirm|re-?type|repeat|again|verify)/i.test(names.join(' ')) };
  const ac = c.autocomplete.split(/\s+/).pop() ?? '';
  if (AUTOCOMPLETE[ac]) return { kind: 'key', key: AUTOCOMPLETE[ac] };
  if (c.type === 'email') return { kind: 'key', key: 'email' };
  if (c.type === 'tel') return { kind: 'key', key: 'phone' };
  for (const n of names) {
    const k = canonicalKey(n);
    if (k) return { kind: 'key', key: k };
    for (const [key, re] of EXTRA) if (re.test(n)) return { kind: 'key', key };
  }
  return { kind: 'unknown' };
}

const STATES: Record<string, string> = { AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', DC: 'District of Columbia' };

/** Finds the option of a dropdown that means the same as the stored value, or null. */
export function matchOption(options: { value: string; text: string }[], stored: string, key: string): string | null {
  const want = new Set([stored.trim().toLowerCase()]);
  if (key === 'state') {
    const up = stored.trim().toUpperCase();
    if (STATES[up]) want.add(STATES[up].toLowerCase());
    const abbr = Object.entries(STATES).find(([, n]) => n.toLowerCase() === stored.trim().toLowerCase())?.[0];
    if (abbr) want.add(abbr.toLowerCase());
  }
  if (key === 'country' && /^(us|usa|united states( of america)?)$/i.test(stored.trim())) for (const x of ['us', 'usa', 'united states', 'united states of america']) want.add(x);
  const hit = options.find(o => want.has(o.value.trim().toLowerCase()) || want.has(o.text.trim().toLowerCase()));
  return hit ? hit.value : null;
}

/** Date of birth in the shape the control expects. The stored form is always YYYY-MM-DD. */
export function formatDate(iso: string, c: ControlInfo): string {
  if (c.type === 'date') return iso;
  const [y, m, d] = iso.split('-');
  const hint = `${c.placeholder} ${c.label}`;
  if (/mm\s*-\s*dd\s*-\s*y/i.test(hint)) return `${m}-${d}-${y}`;
  if (/mm\s*\/\s*dd\s*\/\s*y/i.test(hint)) return `${m}/${d}/${y}`;
  if (/dd\s*\/\s*mm\s*\/\s*y/i.test(hint)) return `${d}/${m}/${y}`;
  return iso;
}

export type BoxPlan = { action: 'tick'; consent: string } | { action: 'human'; why: string } | { action: 'leave' };
const MONEY = /(charge|bill(ed|ing)|auto-?renew|recurring|payment|credit card|free trial|membership fee|authori[sz]e)/i;
const SHARING = /(third[\s-]?part|partners?|affiliates?|share (my|your)|\bsell\b|\bsold\b)/i;
const PHONE_MARKETING = /(\bsms\b|text message|text me|call me|phone call|autodial|robocall)/i;
const AGE = /(\b(\d{2})\b\s*(\+|or older|years? (old|of age)|and over)|legal age|\badult\b)/i;
const TERMS = /\b(terms(?:\s*(?:and|&)\s*conditions|\s+of\s+(?:service|use))?|conditions|privacy\s+(?:policy|notice|statement)|user agreement|license agreement|rules of use)\b/i;
const MARKETING = /\b(offers?|promotions?|promotional|newsletter|marketing|deals?|coupons?|rewards? program|advertising)\b/i;
const AMBIGUOUS_COMMUNICATION = /\b(communications?|correspondence|updates?|contact me|mailings?|subscribe|send me|email me|e-?mail me)\b/i;
const NEGATED = /\b(not|do not|don't|decline|opt[\s-]?out|without|never)\b/i;

/** Decides what to do with a checkbox. Ticking needs the client's recorded permission; money, sharing and phone marketing always go to a person. */
export function planCheckbox(label: string, required: boolean, dateOfBirth?: string, today = new Date()): BoxPlan {
  const l = label.trim();
  const human = (why: string): BoxPlan => ({ action: 'human', why });
  const skip: BoxPlan = required ? human('not recognized') : { action: 'leave' };
  if (/(not a robot|i'?m human|i am human)/i.test(l)) return human('proof that you are human is never done by software');
  if (MONEY.test(l)) return human('mentions money, a trial or renewal; the client must approve that separately');
  if (PHONE_MARKETING.test(l)) return required ? human('phone or text marketing needs the client\'s own decision') : { action: 'leave' };
  if (SHARING.test(l)) return required ? human('shares information with other companies') : { action: 'leave' };
  const terms = TERMS.test(l);
  const marketing = MARKETING.test(l);
  if ((terms && marketing) || (AMBIGUOUS_COMMUNICATION.test(l) && !marketing)) {
    return required ? human('the checkbox mixes or ambiguously describes legal or communication consent; a person must decide') : { action: 'leave' };
  }
  if ((terms || marketing) && NEGATED.test(l)) return required ? human('the checkbox wording declines or opts out of consent; a person must decide') : { action: 'leave' };
  if (marketing) return { action: 'tick', consent: 'marketing_opt_in' };
  if (terms) return { action: 'tick', consent: 'accept_site_terms' };
  const age = AGE.exec(l);
  if (age) {
    const need = Number(age[2] ?? 18) || 18;
    if (!dateOfBirth) return human('confirms an age, but no date of birth is on file');
    const dob = new Date(dateOfBirth + 'T00:00:00Z');
    const years = today.getUTCFullYear() - dob.getUTCFullYear() - (today < new Date(Date.UTC(today.getUTCFullYear(), dob.getUTCMonth(), dob.getUTCDate())) ? 1 : 0);
    return years >= need ? { action: 'tick', consent: 'accept_site_terms' } : human('the date of birth on file does not meet this age');
  }
  return skip;
}

const SETS = ['abcdefghijkmnopqrstuvwxyz', 'ABCDEFGHJKLMNPQRSTUVWXYZ', '23456789', '!@#$%^*-_'];
/** A long random password with upper, lower, digit and symbol. Uses the system's secure random source. */
export function generatePassword(rand: (n: number) => number, length = 20): string {
  const all = SETS.join('');
  const chars = SETS.map(set => set[rand(set.length)]);
  while (chars.length < length) chars.push(all[rand(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) { const j = rand(i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; }
  return chars.join('');
}
export function makeUsername(first: string, last: string, rand: (n: number) => number): string {
  const base = (first + last).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 14) || 'member';
  return base + String(1000 + rand(9000));
}
