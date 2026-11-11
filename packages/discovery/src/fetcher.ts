import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * Polite, safe page fetcher. Used to look at public sign-up pages.
 * - Only http/https. Refuses addresses inside your own computer or network (so a bad list entry can't aim it at your machine).
 * - Identifies itself, checks robots.txt, gives up after 10 seconds, reads at most 1.5 MB, follows at most 4 redirects.
 * - Never solves or bypasses CAPTCHAs or blocks: a block is reported as "bot_blocked".
 * Limitation: the address check happens before the request, so a site that changes its DNS answer between the two could slip past it.
 */
export type FetchOutcome = 'ok' | 'dns_gone' | 'bad_certificate' | 'page_missing' | 'bot_blocked' | 'timeout' | 'busy' | 'sign_in_required' | 'robots_disallowed' | 'blocked_address' | 'error';
export interface FetchResult { outcome: FetchOutcome; status?: number; html?: string; finalUrl?: string; detail?: string; /** browser check only: the sign-up form was one link away, at this path */ oneLinkAway?: string }
export interface FetchDeps {
  fetchImpl?: typeof fetch;
  lookup?: (host: string) => Promise<{ address: string }[]>;
  allowPrivate?: boolean; // tests only
  timeoutMs?: number;
}
const UA = 'UCAAS-SiteChecker/0.1 (checks public sign-up pages; contact the site operator who runs it)';
const MAX_BYTES = 1_500_000;

export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b, c] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0 && (c === 0 || c === 2)) ||  // only the reserved 192.0.0.x and 192.0.2.x; the rest of 192.0.x is public (WordPress.com uses it)
       a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateAddress(v.slice(7));
  return v === '::' || v === '::1' || v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb') || v.startsWith('fc') || v.startsWith('fd');
}

export type HostCheck = { kind: 'ok' | 'dns_gone' | 'blocked' | 'dns_error'; address?: string };
export async function checkHost(host: string, d: FetchDeps): Promise<HostCheck> {
  if (d.allowPrivate) return { kind: 'ok' };
  if (isIP(host)) return isPrivateAddress(host) ? { kind: 'blocked', address: host } : { kind: 'ok' };
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return { kind: 'blocked', address: host };
  try {
    const addrs = await (d.lookup ?? ((h: string) => dnsLookup(h, { all: true })))(host);
    if (!addrs.length) return { kind: 'dns_gone' };
    const bad = addrs.find(a => isPrivateAddress(a.address));
    return bad ? { kind: 'blocked', address: bad.address } : { kind: 'ok' };
  } catch (e: any) {
    return { kind: e?.code === 'ENOTFOUND' || e?.code === 'ENODATA' ? 'dns_gone' : 'dns_error' };
  }
}

function robotsAllows(robots: string, path: string): boolean {
  let applies = false, sawAgent = false;
  const rules: { allow: boolean; p: string }[] = [];
  for (const raw of robots.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const k = m[1].toLowerCase(), v = m[2].trim();
    if (k === 'user-agent') { if (sawAgent && rules.length) { /* new group */ } applies = v === '*'; sawAgent = true; }
    else if (applies && (k === 'disallow' || k === 'allow') && v) rules.push({ allow: k === 'allow', p: v });
  }
  let best: { allow: boolean; p: string } | null = null;
  for (const r of rules) if (path.startsWith(r.p.replace(/\*$/, '')) && (!best || r.p.length > best.p.length)) best = r;
  return best ? best.allow : true;
}

/** True unless robots.txt asks automated tools to stay away from this page. A missing or unreadable robots.txt means allowed. */
export async function robotsAllows_(url: URL, d: FetchDeps): Promise<boolean> {
  try {
    const rr = await once(new URL('/robots.txt', url), d, 'text/plain');
    if (rr.status !== 200) return true;
    return robotsAllows((await rr.text()).slice(0, 200_000), url.pathname + url.search);
  } catch { return true; }
}

async function once(url: URL, d: FetchDeps, accept: string): Promise<Response> {
  const f = d.fetchImpl ?? fetch;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), d.timeoutMs ?? 10_000);
  try { return await f(url, { redirect: 'manual', signal: ctl.signal, headers: { 'user-agent': UA, accept } }); }
  finally { clearTimeout(t); }
}

function classifyError(e: any): FetchResult {
  const code = String(e?.cause?.code ?? e?.code ?? '');
  if (e?.name === 'AbortError' || code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ETIMEDOUT') return { outcome: 'timeout' };
  if (code === 'ENOTFOUND') return { outcome: 'dns_gone' };
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS/i.test(code)) return { outcome: 'bad_certificate', detail: code };
  return { outcome: 'error', detail: code || 'request failed' };
}

export async function safeFetchPage(startUrl: string, d: FetchDeps = {}): Promise<FetchResult> {
  let url: URL;
  try { url = new URL(startUrl); } catch { return { outcome: 'error', detail: 'not a web address' }; }
  for (let hop = 0; hop <= 4; hop++) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return { outcome: 'error', detail: 'only http and https are allowed' };
    const h = await checkHost(url.hostname, d);
    if (h.kind === 'dns_gone') return { outcome: 'dns_gone' };
    if (h.kind === 'dns_error') return { outcome: 'error', detail: 'name lookup failed (try again later)' };
    if (h.kind === 'blocked') return { outcome: 'blocked_address', detail: `the name points to ${h.address}, a private address (your router or DNS filter may be blocking it)` };
    if (hop === 0) { // robots.txt once, for the first host
      try {
        const rr = await once(new URL('/robots.txt', url), d, 'text/plain');
        if (rr.status === 200) {
          const txt = (await rr.text()).slice(0, 200_000);
          if (!robotsAllows(txt, url.pathname + url.search)) return { outcome: 'robots_disallowed', detail: 'the site asks automated tools not to read this page' };
        }
      } catch (e: any) { const r = classifyError(e); if (r.outcome !== 'error') return r; }
    }
    let res: Response;
    try { res = await once(url, d, 'text/html,application/xhtml+xml'); } catch (e: any) { return classifyError(e); }
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get('location');
      if (!loc) return { outcome: 'error', status: res.status, detail: 'redirected without saying where' };
      try { url = new URL(loc, url); } catch { return { outcome: 'error', detail: 'bad redirect' }; }
      continue;
    }
    if (res.status === 404 || res.status === 410) return { outcome: 'page_missing', status: res.status };
    if (res.status === 401) return { outcome: 'sign_in_required', status: res.status };
    if (res.status === 403) return { outcome: 'bot_blocked', status: res.status };
    if (res.status === 429 || res.status === 503) return { outcome: 'busy', status: res.status, detail: 'the site is busy or limiting requests; try again later' };
    if (res.status >= 400) return { outcome: 'error', status: res.status };
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = []; let size = 0;
    if (reader) {
      while (size < MAX_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value); size += value.length;
      }
      reader.cancel().catch(() => {});
    }
    return { outcome: 'ok', status: res.status, finalUrl: url.toString(), html: Buffer.concat(chunks).toString('utf8').slice(0, MAX_BYTES) };
  }
  return { outcome: 'error', detail: 'too many redirects' };
}
