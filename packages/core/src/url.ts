const TRACKING = /^(utm_|fbclid$|gclid$|mc_|ref$|ref_$)/i;
// Minimal multi-part public suffix handling; replace with `psl` in production.
const TWO_PART_SUFFIX = new Set(['co.uk', 'org.uk', 'com.au', 'co.nz', 'co.jp', 'com.br', 'co.in']);

export function normalizeUrl(input: string): string | null {
  let raw = input.trim();
  if (!raw) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = 'https://' + raw;
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!u.hostname.includes('.')) return null;
  u.protocol = 'https:';
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
  // Keep single-page-app routes like "#/registration"; drop ordinary anchors like "#top".
  if (!/^#\/./.test(u.hash)) u.hash = '';
  for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
  u.searchParams.sort();
  let path = u.pathname.replace(/\/+$/, '');
  u.pathname = path === '' ? '/' : path;
  const s = u.toString();
  return u.pathname === '/' && !u.search ? s.replace(/\/$/, '') : s;
}

export function registrableDomain(url: string): string | null {
  const n = normalizeUrl(url);
  if (!n) return null;
  const parts = new URL(n).hostname.split('.');
  if (parts.length <= 2) return parts.join('.');
  const last2 = parts.slice(-2).join('.');
  return TWO_PART_SUFFIX.has(last2) ? parts.slice(-3).join('.') : last2;
}

/** Key identifying a site/program; subdomains of same registrable domain collapse together. */
export function dedupeKey(url: string): string | null {
  return registrableDomain(url);
}

export function dedupeSites<T extends { url: string }>(items: T[]): { unique: T[]; duplicates: { item: T; of: T }[] } {
  const seen = new Map<string, T>();
  const unique: T[] = [];
  const duplicates: { item: T; of: T }[] = [];
  for (const it of items) {
    const k = dedupeKey(it.url);
    if (!k) { unique.push(it); continue; } // keep unparseable entries; never silently drop user data
    const prior = seen.get(k);
    if (prior) duplicates.push({ item: it, of: prior });
    else { seen.set(k, it); unique.push(it); }
  }
  return { unique, duplicates };
}
