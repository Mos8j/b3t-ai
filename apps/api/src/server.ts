import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  hashPassword, verifyPassword, passwordProblems, newClientKey, unwrapClientKey, encryptProfile, decryptProfile,
  can, canAccessClient, redactObject, redact, type Actor, type Role,
} from '../../../packages/security/src/index';
import { validateProfile, missingInfo } from './profile';
import { readClientLogins, storeClientLogin } from './logins';
import { preparationOutcome, submissionOutcome, interruptedOutcome, inProgressOutcome, type SubmissionOutcome, type Delivery } from './submission-results';
import { launchChromium } from '../../../packages/discovery/src/browser';
import type { Filler, FillSession } from '../../../packages/filler/src/index';
import type { ClientSiteStatus, ClientSiteRow, ClientRow, Repo, UserRow, Cleanup, SiteView, CandidateRow, CandidateView, NewCandidate } from './repo';
import { parseSiteList, buildEntries } from '../../../packages/importer/src/index';
import { normalizeUrl, dedupeKey, assessSiteHealth, type Outcome } from '../../../packages/core/src/index';
import {
  analyzeHtml, classify, fingerprint, type BrowserChecker, scoreAgainst, similarity, safeFetchPage, pickQueries,
  type SearchProvider, type FetchDeps, type FetchResult, type DiscoveryAi, hasConsumerSignup, publicPageText, usefulSignupHit,
} from '../../../packages/discovery/src/index';

export interface AppConfig {
  masterKey: Buffer;
  sessionSecret: string;
  secureCookies: boolean;
  setupToken?: string;
  log?: (line: object) => void;
  /** Sites you already decided to drop or re-research. Applied only to sites newly added by an import. */
  cleanup?: Cleanup;
  /** How many active sites the directory keeps. Default 2500. */
  siteCapacity?: number;
  search?: SearchProvider | null;
  discoveryAi?: DiscoveryAi | null;
  fetchDeps?: FetchDeps;
  /** A site looked at less than this long ago is not looked at again (default 6 hours). */
  checkCooldownMs?: number;
  browserCooldownMs?: number;
  /** Reads pages the way a browser does (runs their JavaScript). Null when Playwright is not installed. */
  browser?: BrowserChecker | null;
  /** Fills sign-up forms in a real browser and waits for approval. Null when Playwright is not installed. */
  filler?: Filler | null;
  /** Same, but opens a visible window so a person can finish a form (CAPTCHA, Send) by hand. */
  handFiller?: Filler | null;
}

class HttpError extends Error {
  constructor(public status: number, message: string, public extra: object = {}) { super(message); }
}

const COOKIE = 'ucaas_session';
const SESSION_HOURS = 8;
const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60_000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLES: Role[] = ['admin', 'operator', 'viewer'];
const DUMMY_HASH = hashPassword('dummy-password-for-timing-only');

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'cache-control': 'no-store',
};

export function createApp(repo: Repo, cfg: AppConfig): Server {
  let setupInProgress = false;
  let healthCheck: Promise<object> | null = null;
  let lastHealth: { at: number; result: object } | null = null;
  const reviewingCandidates = new Set<string>();
  const log = cfg.log ?? ((line: object) => console.log(JSON.stringify(line)));
  const failures = new Map<string, { n: number; first: number }>();
  const activeBatches = new Set<string>();
  const activeSends = new Set<string>();
  // Forms that are filled and waiting for a person to approve. Kept in memory only; they expire after 15 minutes.
  const preps = new Map<string, { id: string; clientId: string; siteId: string; session: FillSession; at: number }>();
  const dropPrep = async (id: string) => { const p = preps.get(id); preps.delete(id); await p?.session.close().catch(() => {}); };
  const sweepPreps = async () => { for (const p of [...preps.values()]) if (Date.now() - p.at > 15 * 60_000) await dropPrep(p.id); };
  const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
  const staticFiles: Record<string, { body: Buffer; type: string }> = {
    '/': { body: readFileSync(join(publicDir, 'index.html')), type: 'text/html; charset=utf-8' },
    '/app.js': { body: readFileSync(join(publicDir, 'app.js')), type: 'text/javascript; charset=utf-8' },
    '/bttt-company-logo.jpg': { body: readFileSync(join(publicDir, 'bttt-company-logo.jpg')), type: 'image/jpeg' },
  };

  const tokenHash = (token: string) => createHmac('sha256', cfg.sessionSecret).update(token).digest('hex');

  function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string | string[]> = {}) {
    res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8', ...headers });
    res.end(JSON.stringify(body));
  }

  function getCookie(req: IncomingMessage, name: string): string | null {
    for (const part of (req.headers.cookie ?? '').split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k === name) return v.join('=');
    }
    return null;
  }

  async function readJson(req: IncomingMessage, maxBytes = 1_000_000): Promise<any> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > maxBytes) throw new HttpError(413, 'Request too large');
      chunks.push(c as Buffer);
    }
    if (!size) return {};
    if (!String(req.headers['content-type'] ?? '').includes('application/json'))
      throw new HttpError(415, 'Content-Type must be application/json');
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'Invalid JSON'); }
  }

  /** Blocks cross-site form posts: browsers always send Origin on cross-site writes. */
  function checkOrigin(req: IncomingMessage) {
    if (req.method === 'GET' || req.method === 'HEAD') return;
    const origin = req.headers.origin;
    if (!origin) return;
    let host: string;
    try { host = new URL(origin).host; } catch { throw new HttpError(403, 'Bad origin'); }
    if (host !== req.headers.host) throw new HttpError(403, 'Cross-site request blocked');
  }

  async function authenticate(req: IncomingMessage) {
    const token = getCookie(req, COOKIE);
    if (!token) return null;
    const h = tokenHash(token);
    const s = await repo.findSession(h);
    if (!s) return null;
    if (s.expiresAt.getTime() < Date.now()) { await repo.deleteSession(h); return null; }
    const user = await repo.findUserById(s.userId);
    if (!user || user.disabledAt) return null;
    const actor: Actor = { id: user.id, role: user.role, assignedClientIds: await repo.assignedClientIds(user.id) };
    return { user, actor, h };
  }
  async function requireAuth(req: IncomingMessage) {
    const a = await authenticate(req);
    if (!a) throw new HttpError(401, 'Please sign in');
    return a;
  }

  const publicUser = (u: UserRow) => ({ id: u.id, email: u.email, role: u.role });
  const cookieHeader = (value: string, maxAge: number) =>
    `${COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${cfg.secureCookies ? '; Secure' : ''}`;

  const capacity = cfg.siteCapacity ?? 2500;

  /** Repeats of the same failure within 12 hours count once, so "2 or 3 failures in a row" means on different occasions. */
  const SPREAD_MS = 12 * 3_600_000;
  function spreadRuns<T extends { outcome: string; at: string }>(runs: T[]): T[] {
    const out: T[] = [];
    for (const r of runs) {
      const last = out[out.length - 1];
      if (last && last.outcome === r.outcome && Date.parse(r.at) - Date.parse(last.at) < SPREAD_MS) continue;
      out.push(r);
    }
    return out;
  }

  /** One stuck site must never freeze a whole batch. */
  function within<T>(ms: number, work: Promise<T>, onTimeout: () => T): Promise<T> {
    let timer: NodeJS.Timeout;
    return Promise.race([work, new Promise<T>(r => { timer = setTimeout(() => r(onTimeout()), ms); })]).finally(() => clearTimeout(timer));
  }
  async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]); }));
  }

  /** Fills empty directory slots with the best waiting candidates. Prefers ones shaped like `similarTo` (the site that was just removed). */
  async function refill(similarTo?: string[]): Promise<{ added: { name: string; domain: string }[]; active: number }> {
    const counts = await repo.siteCounts();
    const slots = capacity - counts.active;
    const added: { name: string; domain: string }[] = [];
    if (slots > 0) {
      let cands: CandidateRow[] = await repo.pendingSimpleCandidates(Math.max(slots * 3, 300));
      if (similarTo?.length) cands = cands.map(c => ({ c, s: similarity(similarTo, c.fingerprint) })).sort((a, b) => b.s - a.s || b.c.score - a.c.score).map(x => x.c);
      for (const c of cands) {
        if (added.length >= slots) break;
        // Legacy static-only candidates stay in review rather than refilling the directory.
        if (!c.handlingReason.startsWith('Browser verified signup: ')) continue;
        const site = await repo.promoteCandidate(c);
        if (site) added.push({ name: site.name, domain: site.domain });
      }
    }
    return { added, active: counts.active + added.length };
  }

  const titleOf = (html: string, fallback: string) => {
    const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const t = (m?.[1] ?? '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
    return (t || fallback).slice(0, 200);
  };

  /** Looks at each web address, and stores what it finds as a candidate. Staff-only and unclear sites are kept but never promoted. */
  async function findCandidates(urls: string[], source: 'search' | 'pasted', ai = false, reviewId?: string) {
    const out = { looked: 0, added: 0, alreadyKnown: 0, unreachable: 0, unreadable: {} as Record<string, number>, invalid: 0, excluded: 0, simple: 0, staff: 0, unknown: 0, reviewReasons: {} as Record<string, number> };
    const seen = new Set<string>();
    const todo: { url: string; domain: string }[] = [];
    for (const u of urls) {
      const n = normalizeUrl(u), d = n ? dedupeKey(n) : null;
      if (!n || !d) { out.invalid++; continue; }
      if (seen.has(d)) continue;
      seen.add(d); todo.push({ url: /^https?:\/\//i.test(u.trim()) ? u.trim() : n, domain: d });
    }
    const good = await repo.goodFingerprints();
    const persist = async (candidate: NewCandidate) => {
      if (!reviewId) return repo.addCandidate(candidate);
      const original = await repo.getReviewCandidate(reviewId);
      return original ? repo.updateReviewCandidate(reviewId, { ...candidate, domain: original.domain }) : false;
    };
    await pool(todo, 4, async t => {
      out.looked++;
      const r = await safeFetchPage(t.url, cfg.fetchDeps);
      if (r.outcome !== 'ok' || !r.html) {
        out.unreachable++; out.unreadable[r.outcome] = (out.unreadable[r.outcome] ?? 0) + 1;
        // Preserve failures for manual review instead of losing the candidate URL.
        const saved = await persist({ domain: t.domain, name: t.domain, url: t.url, category: 'other', handling: 'unknown', handlingReason: 'Could not read: ' + r.outcome, fingerprint: [], score: 0, source });
        if (saved) out.added++; else out.alreadyKnown++;
        return;
      }
      let a = analyzeHtml(r.html), cl = classify(a);
      let candidateHtml = r.html, candidateUrl = r.finalUrl ?? t.url;
      if (cl.handling !== 'excluded') {
        if (!cfg.browser) cl = { handling: 'unknown', reason: 'Browser verification required before promotion' };
        else {
          const rendered = await within(90_000, cfg.browser.analyze(candidateUrl), () => ({ outcome: 'timeout' }) as FetchResult).catch(() => ({ outcome: 'error' }) as FetchResult);
          if (rendered.outcome !== 'ok' || !rendered.html) cl = { handling: 'unknown', reason: 'Browser could not verify signup: ' + rendered.outcome };
          else {
            candidateHtml = rendered.html; candidateUrl = rendered.finalUrl ?? candidateUrl;
            a = analyzeHtml(candidateHtml); cl = classify(a);
            if (cl.handling === 'simple' && !hasConsumerSignup(a, candidateHtml)) cl = { handling: 'unknown', reason: 'No clear consumer signup with an email field; review required' };
            if (cl.handling === 'simple' && ai) {
              try {
                const review = await cfg.discoveryAi!.review(candidateUrl, publicPageText(candidateHtml));
                cl = review.eligible ? { handling: 'simple', reason: 'US free signup supported by AI review: ' + review.reason + ' Evidence: ' + review.evidence }
                  : { handling: 'unknown', reason: 'US/free eligibility needs review: ' + review.reason };
              } catch { cl = { handling: 'unknown', reason: 'AI eligibility check unavailable; held for review' }; }
            }
            if (cl.handling === 'simple') cl.reason = 'Browser verified signup: ' + cl.reason;
          }
        }
      }
      const fp = fingerprint(a);
      if (cl.handling === 'excluded') {
        out.excluded++;
        if (reviewId) await persist({ domain: t.domain, name: titleOf(candidateHtml, t.domain), url: candidateUrl, category: 'other', handling: 'unknown', handlingReason: 'Excluded from automatic promotion: ' + cl.reason, fingerprint: fp, score: 0, source });
        return;
      } // payments and file uploads are never promoted
      const category = buildEntries([{ line: 1, name: titleOf(r.html, t.domain), url: t.url, category: '', notes: '' }])[0].category;
      const ok = await persist({
        domain: t.domain, name: titleOf(candidateHtml, t.domain), url: candidateUrl, category, handling: cl.handling,
        handlingReason: cl.reason, fingerprint: fp, score: scoreAgainst(fp, good), source,
      });
      if (!ok) { out.alreadyKnown++; return; }
      out.added++; out[cl.handling]++;
      if (cl.handling === 'unknown') out.reviewReasons[cl.reason] = (out.reviewReasons[cl.reason] || 0) + 1;
    });
    return out;
  }

  /** Looks at the page of each site not yet checked, and keeps the health history. Removes sites the health rules say to remove. */
  async function checkSites(limit: number, userId: string, mode: 'normal' | 'recheck' | 'browser' | 'health' | 'forms' | 'captcha' = 'normal', parallel?: number) {
    const formsMode = mode === 'forms';
    const browserMode = mode === 'browser' || formsMode || mode === 'captcha', healthMode = mode === 'health';
    const queue = await repo.siteCheckQueue(limit, mode === 'captcha' ? { captchaPass: true, cooldownMs: 30 * 60_000 } : formsMode ? { formSweep: true } : mode === 'recheck' ? { recheck: true } : healthMode ? { healthPass: true, cooldownMs: cfg.checkCooldownMs ?? 6 * 3_600_000 } : browserMode ? { browserPass: true, cooldownMs: cfg.browserCooldownMs ?? 10 * 60_000 } : { cooldownMs: cfg.checkCooldownMs ?? 6 * 3_600_000 });
    const results: { id: string; domain: string; r: FetchResult }[] = [];
    await pool(queue, browserMode ? Math.min(16, Math.max(1, parallel ?? 2)) : 4, async q => { results.push({ id: q.id, domain: q.domain, r: browserMode ? await within(90_000, cfg.browser!.analyze(q.url), () => ({ outcome: 'timeout' }) as FetchResult) : await safeFetchPage(q.url, cfg.fetchDeps) }); });
    // If most of a batch failed to even connect, the problem is probably your internet, not the sites. Record nothing.
    const connectFails = results.filter(x => x.r.outcome === 'dns_gone' || x.r.outcome === 'timeout').length;
    const networkProblem = results.length >= 6 && connectFails / results.length >= 0.5;
    const out = { checked: 0, simple: 0, staff: 0, unknown: 0, excluded: 0, removed: 0, needNewAddress: 0, skipped: 0, networkProblem, replacements: [] as string[],
      reasons: {} as Record<string, number>, unreadable: {} as Record<string, number> };
    const tally = (bag: Record<string, number>, key: string) => { bag[key] = (bag[key] ?? 0) + 1; };
    if (networkProblem) { out.skipped = results.length; return out; }
    const HEALTH: Partial<Record<FetchResult['outcome'], Outcome>> = {
      ok: 'ok', dns_gone: 'dns_gone', bad_certificate: 'bad_certificate', page_missing: 'page_missing', bot_blocked: 'bot_blocked', timeout: 'timeout',
    };
    for (const { id, r } of results) {
      const outcome = HEALTH[r.outcome];
      if (!outcome) {
        if (r.outcome === 'robots_disallowed') {
          await repo.recordSiteCheck(id, { handling: 'staff', reason: 'the site asks automated tools not to read this page' });
          tally(out.reasons, 'the site asks automated tools not to read this page');
        }
        else if (r.outcome === 'sign_in_required') {
          await repo.recordSiteCheck(id, { handling: 'staff', reason: 'needs an existing account to sign in' });
          tally(out.reasons, 'needs an existing account to sign in');
        }
        else {
          out.skipped++; tally(out.unreadable, [r.outcome, r.status, r.detail].filter(Boolean).join(' '));
          // moves it to the back of the line so it cannot block the others (in the form sweep it is also set aside, never deleted)
          await repo.recordSiteCheck(id, formsMode ? { handling: 'simple', reason: 'could not be read in a browser' } : {});
          continue;
        }
        out.checked++; out.staff++; continue;
      }
      out.checked++;
      if (outcome === 'ok' && r.html) {
        const a = analyzeHtml(r.html);
        let cl = classify(a);
        if (browserMode && cl.handling === 'unknown') cl = { handling: 'unknown', reason: 'no sign-up form found, even in a browser' };
        if (formsMode && cl.handling === 'unknown') {
          // Forms from another service can sit in a frame we cannot read. Those are kept for staff, not deleted.
          const embedded = /hbspt\.forms\.create|mc-embedded-subscribe|klaviyo-form|jotform\.com\/jsform|<iframe[^>]+src=["'][^"']*(form|subscribe|signup|sign-up|register|typeform|jotform|hsforms|mailchimp|list-manage|klaviyo)/i.test(r.html);
          if (embedded) cl = { handling: 'staff', reason: 'sign-up form comes from another service inside the page; staff fill it by hand' };
          else {
            await repo.recordSiteCheck(id, {}, { outcome });
            const why = 'no sign-up form found, even in a browser';
            tally(out.reasons, 'removed: ' + why);
            const gone = await repo.setSiteRemoved(id, why);
            await repo.audit({ userId, action: 'site.auto_remove', detail: { siteId: id, reason: why } });
            out.unknown++; out.removed++;
            out.replacements.push(...(await refill(gone?.fingerprint)).added.map(x => x.domain));
            continue;
          }
        }
        if (browserMode && r.oneLinkAway && r.finalUrl && /^https?:/i.test(r.finalUrl) && cl.handling !== 'unknown') await repo.setSiteSignupUrl(id, r.finalUrl.slice(0, 2000));
        if (formsMode && cl.handling === 'simple') cl = { handling: 'simple', reason: 'sign-up form confirmed in a browser' };
        if (browserMode && cl.handling === 'simple' && r.oneLinkAway) cl = { handling: 'simple', reason: `sign-up form found one link away (${r.oneLinkAway})` };
        if (cl.handling === 'excluded') {
          await repo.recordSiteCheck(id, {}, { outcome });
          tally(out.reasons, 'dropped: ' + cl.reason);
          const gone = await repo.setSiteRemoved(id, cl.reason);
          await repo.audit({ userId, action: 'site.auto_remove', detail: { siteId: id, reason: cl.reason } });
          out.excluded++; out.removed++;
          out.replacements.push(...(await refill(gone?.fingerprint)).added.map(x => x.domain));
        } else if (healthMode) {
          // A working site only gets its health history updated. Its label is not redone from a plain fetch, which cannot see JavaScript forms.
          await repo.recordSiteCheck(id, {}, { outcome });
          out.simple++;
        } else {
          await repo.recordSiteCheck(id, { handling: cl.handling, reason: cl.reason, fingerprint: fingerprint(a) }, { outcome });
          out[cl.handling]++;
          if (cl.handling !== 'simple') tally(out.reasons, cl.reason);
        }
      } else if (outcome === 'bot_blocked') {
        const why = browserMode ? 'the site still blocks us in a browser (never bypassed)' : 'the site blocks automated checks (never bypassed)';
        await repo.recordSiteCheck(id, { handling: 'staff', reason: why }, { outcome });
        out.staff++; tally(out.reasons, why);
      } else {
        await repo.recordSiteCheck(id, formsMode ? { handling: 'simple', reason: 'could not be read in a browser' } : {}, { outcome });
        const verdict = assessSiteHealth(spreadRuns(await repo.siteRuns(id, 60)).map(x => ({ outcome: x.outcome as Outcome, at: x.at })));
        if (verdict.action === 'remove') {
          tally(out.reasons, 'removed: ' + verdict.reason);
          const gone = await repo.setSiteRemoved(id, verdict.reason);
          await repo.audit({ userId, action: 'site.auto_remove', detail: { siteId: id, reason: verdict.reason } });
          out.removed++;
          const f = await refill(gone?.fingerprint);
          out.replacements.push(...f.added.map(x => x.domain));
        } else if (verdict.action === 'needs_new_url') { await repo.setSiteResearch(id); out.needNewAddress++; }
        else tally(out.unreadable, r.outcome + ' (watching, not removed yet)');
      }
    }
    return out;
  }

  /** Fills one site and sends it if (and only if) everything could be filled safely. Nobody previews it; the result is recorded and reported. */
  async function sendOne(row: ClientRow, site: ClientSiteRow, userId: string, consents: string[]) {
    const key = row.id + ':' + site.siteId;
    if (activeSends.has(key)) return { siteId: site.siteId, name: site.name, domain: site.domain, outcome: 'unconfirmed', siteStatus: site.status,
      text: 'An attempt for this site is still running. Wait for its result before trying again.', result: inProgressOutcome() };
    activeSends.add(key);
    const attempt = { id: randomUUID(), expired: false, submitting: false };
    const work = sendOneInner(row, site, userId, consents, attempt).finally(() => activeSends.delete(key));
    const result = await within(150_000, work as Promise<Awaited<typeof work> | null>, () => { attempt.expired = true; return null; });
    if (result) return result;
    const timedOut = interruptedOutcome(!attempt.submitting, true);
    await repo.audit({ userId, clientId: row.id, action: 'submission.result', detail: { siteId: site.siteId, attemptId: attempt.id, outcome: timedOut } });
    return { siteId: site.siteId, name: site.name, domain: site.domain, outcome: timedOut.delivery === 'not_sent' ? 'not_sent' : 'unconfirmed',
      siteStatus: attempt.submitting ? 'sent' : site.status, text: timedOut.detail, result: timedOut };
  }

  async function saveSubmissionResult(clientId: string, site: ClientSiteRow, userId: string, result: SubmissionOutcome, next: ClientSiteStatus, attemptId: string = randomUUID()) {
    const tag = result.code === 'already_member' ? 'ALREADY MEMBER: ' : result.code === 'likely_sent' ? 'LIKELY SENT: ' : result.code === 'captcha' ? 'CAPTCHA: ' : result.delivery === 'confirmed' ? 'Confirmed by the site: ' : result.delivery === 'not_sent' ? 'Not sent: ' : 'Needs verification: ';
    const note = (tag + result.detail + (result.evidence ? ' Page said: ' + result.evidence : '')).slice(0, 300);
    await repo.setClientSiteStatus(clientId, site.siteId, next, note, userId);
    await repo.audit({ userId, clientId, action: 'submission.result', detail: { siteId: site.siteId, attemptId, outcome: result } });
    const legacy = result.code === 'captcha' ? 'captcha' : result.code === 'already_member' ? 'already' : result.delivery === 'confirmed' ? 'confirmed' : result.delivery === 'not_sent' ? 'not_sent' : 'unconfirmed';
    return { siteId: site.siteId, name: site.name, domain: site.domain, outcome: legacy, text: note, siteStatus: next, result };
  }
  async function reserveSubmission(clientId: string, siteId: string, userId: string, attemptId: string) {
    await repo.setClientSiteStatus(clientId, siteId, 'sent', 'Submission in progress. Verify the result before retrying.', userId);
    await repo.audit({ userId, clientId, action: 'submission.result', detail: { siteId, attemptId, outcome: inProgressOutcome() } });
  }
  /** Opens one site in a visible window with the form filled in, for a person to finish. The software sends nothing. */
  async function openForHand(row: ClientRow, site: ClientSiteRow, userId: string): Promise<{ note: string; filled: number; leftForYou: string[] }> {
    const id = row.id;
    const consents = (await repo.listConsents(id)).filter(c => !c.revokedAt).map(c => c.scope);
    const profile = decryptProfile(unwrapClientKey(cfg.masterKey, row.wrappedDek, id), id, row.encryptedProfile) as Record<string, unknown>;
    const session = await within(120_000, cfg.handFiller!.prepare(site.url!, profile, { consents, screenshot: false, handOver: true }), () => null as any);
    if (!session) throw new HttpError(504, 'The site took too long to open. Try again.');
    const rep = session.report;
    if (rep.status === 'refused' || rep.status === 'blocked' || rep.status === 'error' || !rep.filled.length) {
      await session.close().catch(() => {});
      throw new HttpError(422, 'Could not open this form: ' + rep.reason + (rep.needsHuman.length ? ' ' + rep.needsHuman.join('; ') : ''));
    }
    await session.handOver?.();
    const lead = /^CAPTCHA/i.test(site.note ?? '') || /captcha/i.test(site.handlingReason ?? '') ? 'CAPTCHA (window opened): ' : '';
    const note = (lead + 'Opened in a window on this computer and filled in by the software. A person has to solve any CAPTCHA, press Send, check the result, then press Mark done. Nothing was sent by the software.' + (rep.needsHuman.length ? ' Left for you: ' + rep.needsHuman.join('; ') : '')).slice(0, 400);
    await repo.setClientSiteStatus(id, site.siteId, 'staff_fill', note, userId);
    await repo.audit({ userId, clientId: id, action: 'send.hand_finish', detail: { siteId: site.siteId } });
    return { note, filled: rep.filled.length, leftForYou: rep.needsHuman };
  }
  async function sendOneInner(row: ClientRow, site: ClientSiteRow, userId: string, consents: string[], attempt: { id: string; expired: boolean; submitting: boolean }) {
    const id = row.id, siteId = site.siteId;
    const latest = await repo.getClientSite(id, siteId);
    if (!latest || latest.status !== 'approved') return { siteId, name: site.name, domain: site.domain, outcome: 'unconfirmed', siteStatus: latest?.status ?? site.status,
      text: 'The site is no longer approved for a new attempt. Check its latest result first.', result: interruptedOutcome(false) };
    let session: FillSession | undefined, result: SubmissionOutcome, next: ClientSiteStatus = site.status;
    try {
      const profile = decryptProfile(unwrapClientKey(cfg.masterKey, row.wrappedDek, id), id, row.encryptedProfile) as Record<string, unknown>;
      session = await cfg.filler!.prepare(site.url!, profile, {
        consents, screenshot: false,
        saveLogin: async login => { await storeClientLogin(repo, cfg.masterKey, row, siteId, login, userId); },
      });
      const rep = session.report;
      if (attempt.expired) result = interruptedOutcome(true, true);
      else if (rep.status !== 'ready_for_approval' || rep.captcha) {
        result = preparationOutcome(rep);
        next = rep.status === 'refused' ? 'skipped' : rep.status === 'blocked' || result.code === 'captcha' ? 'staff_fill' : site.status;
      } else {
        // Reserve before any send action: an interrupted process must not leave this in the automatic retry queue.
        await reserveSubmission(id, siteId, userId, attempt.id);
        if (attempt.expired) { result = interruptedOutcome(true, true); next = 'approved'; }
        else {
          attempt.submitting = true;
          const sent = await session.submit();
          result = submissionOutcome(sent);
          const captcha = (sent.status === 'blocked' || sent.status === 'failed') && /captcha|not a robot|verify (that )?you are (a )?human|prove (that )?(you|we) are (a )?human/i.test(sent.detail + ' ' + (sent.evidence ?? ''));
          if (captcha) {
            result.code = 'captcha'; result.title = 'Human check required'; result.nextAction = 'manual'; result.retryAllowed = false;
            result.guidance = 'Check the prior attempt in a visible browser before completing the human check or sending again.';
          }
          next = result.delivery === 'confirmed' ? 'done' : sent.status === 'blocked' || captcha ? 'staff_fill' : result.delivery === 'not_sent' ? 'approved' : 'sent';
        }
      }
    } catch {
      result = interruptedOutcome(!attempt.submitting);
      next = attempt.submitting ? 'sent' : site.status;
    } finally { await session?.close().catch(() => {}); }
    await repo.audit({ userId, clientId: id, action: 'send.auto', detail: { siteId, result: result.code } });
    return saveSubmissionResult(id, site, userId, result, next, attempt.id);
  }

  async function handle(req: IncomingMessage, res: ServerResponse, ctx: { userId: string | null }) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    if (method === 'GET' && staticFiles[path]) {
      res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': staticFiles[path].type });
      return res.end(staticFiles[path].body);
    }
    if (!path.startsWith('/api/')) throw new HttpError(404, 'Not found');
    checkOrigin(req);

    if (method === 'GET' && path === '/api/status') return send(res, 200, { needsSetup: (await repo.countUsers()) === 0, setupTokenRequired: !!cfg.setupToken });

    if (method === 'POST' && path === '/api/setup') {
      const b = await readJson(req);
      if (cfg.setupToken) {
        const expected = tokenHash(cfg.setupToken);
        const supplied = tokenHash(typeof b.setupToken === 'string' ? b.setupToken : '');
        if (!timingSafeEqual(Buffer.from(expected), Buffer.from(supplied))) {
          throw new HttpError(403, 'Enter the correct setup code');
        }
      }
      if (setupInProgress) throw new HttpError(409, 'Setup is already in progress');
      setupInProgress = true;
      try {
        if ((await repo.countUsers()) > 0) throw new HttpError(409, 'Setup is already complete');
        const email = String(b.email ?? '').trim().toLowerCase();
        const password = String(b.password ?? '');
        if (!EMAIL.test(email)) throw new HttpError(400, 'Enter a valid email address');
        const problems = passwordProblems(password);
        if (problems.length) throw new HttpError(400, 'Password ' + problems.join(', '), { problems });
        const user = await repo.createUser({ email, passwordHash: hashPassword(password), role: 'admin' });
        await repo.audit({ userId: user.id, action: 'setup.admin_created' });
        return send(res, 201, { user: publicUser(user) });
      } finally { setupInProgress = false; }
    }

    if (method === 'POST' && path === '/api/login') {
      const b = await readJson(req);
      const email = String(b.email ?? '').trim().toLowerCase();
      const key = `${req.socket.remoteAddress ?? 'unknown'}|${email}`;
      const f = failures.get(key);
      if (f && Date.now() - f.first < LOCKOUT_MS && f.n >= MAX_FAILURES)
        throw new HttpError(429, 'Too many failed attempts. Try again in 15 minutes.');
      const user = await repo.findUserByEmail(email);
      const active = !!user && !user.disabledAt;
      // Always run a hash check so response time doesn't reveal whether the email exists.
      const passwordOk = verifyPassword(String(b.password ?? ''), active ? user!.passwordHash : DUMMY_HASH);
      if (!active || !passwordOk) {
        const now = Date.now();
        failures.set(key, !f || now - f.first >= LOCKOUT_MS ? { n: 1, first: now } : { n: f.n + 1, first: f.first });
        await repo.audit({ userId: null, action: 'login.failed' });
        throw new HttpError(401, 'Wrong email or password');
      }
      failures.delete(key);
      const token = randomBytes(32).toString('base64url');
      await repo.createSession(tokenHash(token), user!.id, new Date(Date.now() + SESSION_HOURS * 3600_000));
      await repo.audit({ userId: user!.id, action: 'login' });
      ctx.userId = user!.id;
      return send(res, 200, { user: publicUser(user!) }, { 'set-cookie': cookieHeader(token, SESSION_HOURS * 3600) });
    }

    // ---- everything below needs a signed-in user ----
    const { user, actor, h } = await requireAuth(req);
    if (path === '/api/health' && (method === 'GET' || method === 'POST')) {
      if (user.role === 'viewer') throw new HttpError(403, 'Health checks are available to staff.');
      const checks = [
        { name: 'Database', status: 'ready', detail: 'Connected: signed-in session and user data were read successfully.', fix: 'If the app cannot start, open Docker Desktop, then run npm.cmd run db:up in C:\\ucaas.' },
        { name: 'Form-filling browser', status: cfg.filler && cfg.browser ? 'configured' : 'missing', detail: 'Browser launch is checked by Check connections.', fix: 'In C:\\ucaas run npm.cmd install and npx.cmd playwright install chromium, then restart the app.' },
        { name: 'Search service', status: cfg.search ? 'configured' : 'missing', detail: 'Search credentials have not been checked by this startup check.', fix: 'Set SEARCH_PROVIDER=brave and SEARCH_API_KEY in .env, then restart. Check your Brave account quota if requests fail.' },
        { name: 'AI connection', status: cfg.discoveryAi ? 'configured' : 'missing', detail: 'AI credentials and model access have not been checked by this startup check.', fix: 'Set LLM_PROVIDER=openai, LLM_API_KEY and LLM_MODEL in .env, then restart. Check API billing and model access if requests fail.' },
      ];
      if (method === 'GET') return send(res, 200, { checkedAt: new Date().toISOString(), checks });
      if (lastHealth && Date.now() - lastHealth.at < 60_000) return send(res, 200, lastHealth.result);
      if (!healthCheck) healthCheck = (async () => {
        const run = async (index: number, work: () => Promise<unknown>) => {
          if (checks[index].status === 'missing') return;
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([work(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), 25_000); })]);
            checks[index].status = 'ready'; checks[index].detail = 'Connection check passed.';
          } catch { checks[index].status = 'failed'; checks[index].detail = 'Connection check failed or timed out. Follow the steps below, then check again.'; }
          finally { clearTimeout(timer); }
        };
        await Promise.all([
          run(1, async () => {
            const pw: any = await import('playwright' as string);
            const chromium = pw.chromium ?? pw.default?.chromium;
            const browser = await launchChromium({ loader: async () => ({ chromium: { launch: (options: any) => chromium.launch({ ...options, timeout: 6000 }) } }) });
            try { const page = await browser.newPage(); await page.setContent('<title>B3T Ai browser check</title>'); }
            finally { await browser.close(); }
          }),
          run(2, () => cfg.search!.search('free consumer newsletter United States', 1)),
          run(3, async () => { const queries = await cfg.discoveryAi!.queries(['free consumer newsletters in the United States']); if (!queries.length) throw new Error('No valid AI response'); }),
        ]);
        const result = { checkedAt: new Date().toISOString(), checks };
        lastHealth = { at: Date.now(), result }; return result;
      })().finally(() => { healthCheck = null; });
      return send(res, 200, await healthCheck);
    }
    ctx.userId = user.id;

    if (method === 'POST' && path === '/api/logout') {
      await repo.deleteSession(h);
      await repo.audit({ userId: user.id, action: 'logout' });
      return send(res, 200, { ok: true }, { 'set-cookie': cookieHeader('', 0) });
    }
    if (method === 'POST' && path === '/api/me/account') {
      const b = await readJson(req);
      if (!verifyPassword(String(b.current ?? ''), user.passwordHash)) {
        await repo.audit({ userId: user.id, action: 'account.change_refused' });
        throw new HttpError(403, 'Your current password is not right');
      }
      const change: { email?: string; passwordHash?: string } = {};
      const wantEmail = String(b.newEmail ?? '').trim().toLowerCase();
      const wantPass = String(b.newPassword ?? '');
      if (wantEmail) {
        if (!EMAIL.test(wantEmail)) throw new HttpError(400, 'Enter a valid email address');
        change.email = wantEmail;
      }
      if (wantPass) {
        const problems = passwordProblems(wantPass);
        if (problems.length) throw new HttpError(400, 'Password ' + problems.join(', '), { problems });
        change.passwordHash = hashPassword(wantPass);
      }
      if (!change.email && !change.passwordHash) throw new HttpError(400, 'Enter a new email or a new password');
      let updated;
      try { updated = await repo.updateUserLogin(user.id, change); }
      catch (e: any) {
        if (e?.message === 'duplicate_email') throw new HttpError(409, 'That email is already used by someone else');
        throw e;
      }
      if (change.passwordHash) await repo.deleteOtherSessions(user.id, h);
      await repo.audit({ userId: user.id, action: 'account.updated', detail: { email: !!change.email, password: !!change.passwordHash } });
      return send(res, 200, { user: publicUser(updated) });
    }
    if (method === 'GET' && path === '/api/me') return send(res, 200, { user: publicUser(user) });

    if (method === 'GET' && path === '/api/users') {
      if (!can(actor, 'user:manage')) throw new HttpError(403, 'Only admins can manage staff');
      return send(res, 200, { users: (await repo.listStaff()).filter(account => account.id !== user.id).map(publicUser) });
    }

    const staffAccount = path.match(/^\/api\/users\/([^/]+)$/);
    if (method === 'PATCH' && staffAccount) {
      if (!can(actor, 'user:manage')) throw new HttpError(403, 'Only admins can edit staff');
      const id = staffAccount[1];
      const target = UUID.test(id) ? await repo.findUserById(id) : null;
      if (!target || target.disabledAt || target.role === 'admin') throw new HttpError(404, 'Active operator or viewer not found');
      const b = await readJson(req);
      const change: { email?: string; passwordHash?: string } = {};
      if (b.email !== undefined) {
        const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';
        if (email.length > 254 || !EMAIL.test(email)) throw new HttpError(400, 'Enter a valid email address');
        change.email = email;
      }
      if (b.newPassword !== undefined) {
        const password = typeof b.newPassword === 'string' ? b.newPassword : '';
        const problems = passwordProblems(password);
        if (problems.length) throw new HttpError(400, 'Password ' + problems.join(', '));
        change.passwordHash = hashPassword(password);
      }
      if (!change.email && !change.passwordHash) throw new HttpError(400, 'Enter a new email or password');
      let updated;
      try { updated = await repo.updateUserLogin(id, change); }
      catch (e: any) {
        if (e?.message === 'duplicate_email') throw new HttpError(409, 'That email is already used by someone else');
        throw e;
      }
      if (change.passwordHash) {
        await repo.deleteOtherSessions(id, '');
        await repo.audit({ userId: user.id, action: 'user.password_reset', detail: { targetUserId: id } });
      }
      if (change.email) await repo.audit({ userId: user.id, action: 'user.email_updated', detail: { targetUserId: id } });
      return send(res, 200, { user: publicUser(updated) });
    }

    if (method === 'DELETE' && staffAccount) {
      if (!can(actor, 'user:manage')) throw new HttpError(403, 'Only admins can remove staff');
      const id = staffAccount[1];
      if (id.toLowerCase() === user.id.toLowerCase()) throw new HttpError(400, 'You cannot remove your own admin account');
      if (!UUID.test(id) || !await repo.disableStaff(id, user.id)) throw new HttpError(404, 'Active account not found');
      await repo.audit({ userId: user.id, action: 'user.disable', detail: { targetUserId: id } });
      return send(res, 200, { ok: true });
    }

    if (method === 'POST' && path === '/api/users') {
      if (!can(actor, 'user:manage')) throw new HttpError(403, 'Only admins can add users');
      const b = await readJson(req);
      const email = String(b.email ?? '').trim().toLowerCase();
      const role = b.role as Role;
      const password = String(b.password ?? '');
      if (!EMAIL.test(email)) throw new HttpError(400, 'Enter a valid email address');
      if (!ROLES.includes(role)) throw new HttpError(400, 'Role must be admin, operator or viewer');
      const problems = passwordProblems(password);
      if (problems.length) throw new HttpError(400, 'Password ' + problems.join(', '), { problems });
      try {
        const created = await repo.createUser({ email, passwordHash: hashPassword(password), role });
        await repo.audit({ userId: user.id, action: 'user.create', detail: { newUserId: created.id, role } });
        return send(res, 201, { user: publicUser(created) });
      } catch (e: any) {
        if (e.message === 'duplicate_email') throw new HttpError(409, 'A user with that email already exists');
        throw e;
      }
    }

    if (path === '/api/clients' && method === 'GET') {
      if (!can(actor, 'client:read')) throw new HttpError(403, 'Not allowed');
      const rows = await repo.listClients(actor.role === 'admin' ? undefined : actor.assignedClientIds);
      return send(res, 200, { clients: user.role === "admin" ? rows : rows.map(({ id, displayName, createdAt }) => ({ id, displayName, createdAt })) });
    }

    if (path === '/api/clients' && method === 'POST') {
      if (!can(actor, 'client:write')) throw new HttpError(403, 'Not allowed to create clients');
      const b = await readJson(req);
      const displayName = String(b.displayName ?? '').trim();
      if (!displayName || displayName.length > 100) throw new HttpError(400, 'Give the client a short label (1 to 100 characters)');
      const v = validateProfile(b.profile ?? {});
      if (!v.ok) throw new HttpError(400, 'Profile has problems', { errors: v.errors });
      const consents = Array.isArray(b.consents) ? b.consents.filter((s: unknown) => typeof s === 'string' && s.length <= 100) : [];
      const id = randomUUID();
      const { dek, wrappedDek } = newClientKey(cfg.masterKey, id);
      await repo.createClient({ id, displayName, encryptedProfile: encryptProfile(dek, id, v.profile), wrappedDek, ownerId: user.id });
      for (const scope of consents) await repo.addConsent(id, scope, user.id);
      await repo.audit({ userId: user.id, clientId: id, action: 'client.create' });
      return send(res, 201, { id });
    }

    // ---- look at approved sites (only looking) and move the ones showing a CAPTCHA into the CAPTCHA list ----
    const sc = path.match(/^\/api\/clients\/([^/]+)\/sites\/scan-captcha$/);
    if (sc && method === 'POST') {
      const id = sc[1];
      const row = UUID.test(id) ? await repo.getClient(id) : null;
      if (!row || row.deletedAt || !canAccessClient(actor, id, 'approval:grant')) throw new HttpError(404, 'Client not found');
      if (!cfg.filler?.scan) throw new HttpError(400, 'Form filling is not installed. In the project folder run: npm.cmd install   then restart.');
      const b = await readJson(req);
      const n = Math.min(16, Math.max(1, Math.round(Number(b.limit) || 8)));
      const skip = new Set(Array.isArray(b.skip) ? b.skip.filter((x: unknown) => typeof x === 'string' && UUID.test(x)) : []);
      const list = await repo.listClientSites(id, { status: 'approved', limit: 100_000, offset: 0, hideStaff: true });
      const all = list.sites.filter(x => !x.needsStaff && x.url && !skip.has(x.siteId));
      const todo = all.slice(0, n);
      const results = await Promise.all(todo.map(async s => {
        const r = await within(60_000, cfg.filler!.scan!(s.url!), () => ({ captcha: false, reason: 'took too long' }));
        if (r.captcha) {
          await repo.setClientSiteStatus(id, s.siteId, 'staff_fill', ('CAPTCHA: ' + r.reason + '. Nothing was sent. Open it from the CAPTCHA section.').slice(0, 300), user.id);
        }
        return { siteId: s.siteId, name: s.name, captcha: r.captcha };
      }));
      await repo.audit({ userId: user.id, clientId: id, action: 'sites.scan_captcha', detail: { scanned: todo.length, moved: results.filter(x => x.captcha).length } });
      return send(res, 200, { results, remaining: Math.max(0, all.length - todo.length) });
    }

    // ---- sites whose old notes say "already a member / subscribed" go to their own list to verify ----
    const ma = path.match(/^\/api\/clients\/([^/]+)\/sites\/move-already$/);
    if (ma && method === 'POST') {
      const id = ma[1];
      const row = UUID.test(id) ? await repo.getClient(id) : null;
      if (!row || row.deletedAt || !canAccessClient(actor, id, 'approval:grant')) throw new HttpError(404, 'Client not found');
      const list = await repo.listClientSites(id, { status: 'approved', hasNote: true, limit: 100_000, offset: 0, hideStaff: true });
      const re = /already (registered|exists?|subscribed|a member|signed up|on (our|the|this) (list|mailing list)|have an account|in use|enrolled|part of)|(e-?mail|account|address)( \w+)? (is |has )?already|you(?:'| a)re already|is already (registered|subscribed|a member|in use|on)/i;
      const targets = list.sites.filter(s => !s.needsStaff && re.test(s.note ?? '') && !/^ALREADY MEMBER/i.test(s.note ?? ''));
      for (const s of targets) await repo.setClientSiteStatus(id, s.siteId, 'sent', ('ALREADY MEMBER: ' + (s.note ?? '')).slice(0, 400), user.id);
      await repo.audit({ userId: user.id, clientId: id, action: 'sites.move_already', detail: { count: targets.length } });
      return send(res, 200, { count: targets.length });
    }

    // ---- move approved sites whose notes show they need a CAPTCHA into the CAPTCHA list ----
    const mc = path.match(/^\/api\/clients\/([^/]+)\/sites\/move-captcha$/);
    if (mc && method === 'POST') {
      const id = mc[1];
      const row = UUID.test(id) ? await repo.getClient(id) : null;
      if (!row || row.deletedAt || !canAccessClient(actor, id, 'approval:grant')) throw new HttpError(404, 'Client not found');
      const list = await repo.listClientSites(id, { status: 'approved', hasNote: true, limit: 100_000, offset: 0, hideStaff: true });
      const targets = list.sites.filter(s => /captcha|not a robot|verify (that )?you are (a )?human|prove (that )?(you|we) are (a )?human|human verification/i.test(s.note ?? '') && !/^CAPTCHA/i.test(s.note ?? ''));
      for (const s of targets) await repo.setClientSiteStatus(id, s.siteId, 'staff_fill', ('CAPTCHA: ' + (s.note ?? '')).slice(0, 400), user.id);
      await repo.audit({ userId: user.id, clientId: id, action: 'sites.move_captcha', detail: { count: targets.length } });
      return send(res, 200, { count: targets.length });
    }

    // ---- clear out approved sites whose last try sent nothing ----
    const cf = path.match(/^\/api\/clients\/([^/]+)\/sites\/clean-failed$/);
    if (cf && method === 'POST') {
      const id = cf[1];
      const row = UUID.test(id) ? await repo.getClient(id) : null;
      if (!row || row.deletedAt || !canAccessClient(actor, id, 'approval:grant')) throw new HttpError(404, 'Client not found');
      const b = await readJson(req);
      const action = b.action === 'remove' ? 'remove' : 'skip';
      if (action === 'remove' && user.role !== 'admin') throw new HttpError(403, 'Only an admin can remove sites from the directory.');
      const ro = b.restoredOnly === true;
      const list = ro ? await repo.listClientSites(id, { limit: 100_000, offset: 0, restored: true }) : await repo.listClientSites(id, { status: 'approved', limit: 100_000, offset: 0, hasNote: true, hideStaff: true });
      if (ro) list.sites = list.sites.filter(s => s.status !== 'done' && s.status !== 'sent');   // restored sites that never went through
      // only sites where the note says NOTHING was sent: "did not accept" ones may have gone through, so they are never touched here
      const mine = ro ? list.sites : list.sites.filter(s => !s.needsStaff);
      // unless asked for everything: only sites where the note says NOTHING was sent. "Did not accept" ones may have gone through, so they are left for the person to decide.
      const targets = (b.all === true || ro) ? mine : mine.filter(s => /^Not sent|Nothing was sent/i.test(s.note ?? ''));
      for (const s of targets) {
        if (action === 'remove') { const gone = await repo.setSiteRemoved(s.siteId, b.restoredOnly === true ? 'removed for good: DO NOT WORK (still could not be sent after being restored)' : 'nothing could be sent to this site (removed by staff after a run)'); if (gone) await refill(gone.fingerprint); }   // each removed site is replaced by a waiting candidate
        else await repo.setClientSiteStatus(id, s.siteId, 'skipped', s.note, user.id);
      }
      await repo.audit({ userId: user.id, clientId: id, action: action === 'remove' ? 'sites.remove_failed' : 'sites.skip_failed', detail: { count: targets.length } });
      return send(res, 200, { count: targets.length, action, left: mine.length - targets.length });
    }

    const readiness = path.match(/^\/api\/clients\/([^/]+)\/readiness$/);
    if (readiness && method === 'GET') {
      const id = readiness[1], row = UUID.test(id) ? await repo.getClient(id) : null;
      if (!row || row.deletedAt || !canAccessClient(actor, id, 'approval:grant')) throw new HttpError(404, 'Client not found');
      const restoredOnly = url.searchParams.get('restoredOnly') === '1';
      const [sites, consentRows] = await Promise.all([
        repo.listClientSites(id, { limit: 100_000, offset: 0, hideStaff: user.role !== 'admin', restored: restoredOnly }),
        repo.listConsents(id),
      ]);
      const permissions = consentRows.filter(c => !c.revokedAt).map(c => c.scope);
      const profile = decryptProfile(unwrapClientKey(cfg.masterKey, row.wrappedDek, id), id, row.encryptedProfile) as Record<string, unknown>;
      const eligible = sites.sites.filter(s => s.status === 'approved' && !s.needsStaff && !!s.url);
      const blockers: string[] = [];
      if (!cfg.filler) blockers.push('Form filling is not installed or configured.');
      if (!permissions.includes('use_profile_for_applications')) blockers.push('The client permission to apply on their behalf is not recorded.');
      if (!eligible.length) blockers.push(restoredOnly ? 'No approved restored sites with a signup URL are ready to send.' : 'No approved sites with a signup URL are ready to send.');
      const counts = {
        total: sites.total, eligible: eligible.length,
        awaitingApproval: sites.sites.filter(s => s.status === 'proposed').length,
        skipped: sites.sites.filter(s => s.status === 'skipped').length,
        needsStaff: sites.sites.filter(s => s.needsStaff || s.status === 'staff_fill').length,
        alreadySent: sites.sites.filter(s => s.status === 'sent' || s.status === 'done').length,
        missingUrl: sites.sites.filter(s => s.status === 'approved' && !s.needsStaff && !s.url).length,
      };
      await repo.audit({ userId: user.id, clientId: id, action: 'batch.readiness', detail: { restoredOnly, eligible: counts.eligible, blockers: blockers.length } });
      return send(res, 200, { canStart: !blockers.length, blockers, counts, permissions, missingInformation: missingInfo(profile, []), restoredOnly });
    }

    // Save claims before opening sites; interrupted claims never return to the resume queue.
    const batchRoute = path.match(/^\/api\/clients\/([^/]+)\/batches(?:\/([^/]+)\/(next))?$/);
    if (batchRoute && ['GET', 'POST'].includes(method)) {
      const id = batchRoute[1], runId = batchRoute[2];
      const row = UUID.test(id) ? await repo.getClient(id) : null;
      if (!row || row.deletedAt || !canAccessClient(actor, id, 'approval:grant')) throw new HttpError(404, 'Client not found');
      if (runId && !UUID.test(runId)) throw new HttpError(400, 'Invalid batch');
      const summarize = (d: any) => ({ runId: d.runId, startedAt: d.startedAt, restoredOnly: d.restoredOnly,
        total: d.siteIds.length, remaining: d.siteIds.filter((s: string) => !d.claimed.includes(s)).length,
        finished: Object.keys(d.outcomes).length,
        confirmed: Object.values(d.outcomes).filter(x => x === 'confirmed').length,
        needsVerification: d.claimed.filter((s: string) => !d.outcomes[s] || ['unconfirmed', 'already'].includes(d.outcomes[s])).length,
        notSent: Object.values(d.outcomes).filter(x => x === 'not_sent').length,
        humanCheck: Object.values(d.outcomes).filter(x => x === 'captcha').length,
        skipped: Object.values(d.outcomes).filter(x => x === 'skipped').length,
        active: activeBatches.has(id) });
      if (method === 'GET') return send(res, 200, { entries: (await repo.batchHistory(id)).map(e => ({ ...summarize(e.detail), updatedAt: e.at })) });
      if (activeBatches.has(id)) throw new HttpError(409, 'A batch is still processing for this client. Wait before resuming.');
      activeBatches.add(id);
      try {
        const b = await readJson(req);
        if (!cfg.filler) throw new HttpError(400, 'Form filling is not configured.');
        const consents = (await repo.listConsents(id)).filter(c => !c.revokedAt).map(c => c.scope);
        if (!consents.includes('use_profile_for_applications')) throw new HttpError(403, 'Record permission to apply on the client behalf first.');
        const save = (detail: object) => repo.audit({ userId: user.id, clientId: id, action: 'batch.progress', detail: structuredClone(detail) });
        if (!runId) {
          const list = await repo.listClientSites(id, { status: 'approved', limit: 100_000, offset: 0, hideStaff: true, restored: b.restoredOnly === true });
          const siteIds = list.sites.filter(s => !s.needsStaff && s.url).map(s => s.siteId);
          if (!siteIds.length) throw new HttpError(400, 'No eligible approved sites remain.');
          const d = { runId: randomUUID(), startedAt: new Date().toISOString(), restoredOnly: b.restoredOnly === true, siteIds, claimed: [], outcomes: {} };
          await save(d); return send(res, 200, summarize(d));
        }
        const event = (await repo.batchHistory(id, runId))[0];
        if (!event) throw new HttpError(404, 'Batch not found');
        const d = structuredClone(event.detail) as { runId: string; siteIds: string[]; claimed: string[]; outcomes: Record<string, string> };
        const n = Math.min(12, Math.max(1, Math.round(Number(b.limit) || 3)));
        const pending = d.siteIds.filter(s => !d.claimed.includes(s)).slice(0, n);
        d.claimed.push(...pending);
        await save(d);
        const eligibleNow = await repo.listClientSites(id, { status: 'approved', limit: 100_000, offset: 0, hideStaff: true });
        const eligibleIds = new Set(eligibleNow.sites.map(s => s.siteId));
        const results = await Promise.all(pending.map(async siteId => {
          const site = await repo.getClientSite(id, siteId);
          if (!eligibleIds.has(siteId) || !site || site.status !== 'approved' || site.needsStaff || !site.url) return { siteId, outcome: 'skipped', name: site?.name || 'Unavailable site', text: 'No longer eligible for this batch.' };
          return sendOne(row, site, user.id, consents);
        }));
        for (const r of results) d.outcomes[r.siteId] = r.outcome;
        await save(d);
        return send(res, 200, { ...summarize(d), results });
      } finally { activeBatches.delete(id); }
    }

    // ---- send without a preview: fill, send, and report what happened ----
    const sn = path.match(/^\/api\/clients\/([^/]+)\/sites\/(send-approved|[^/]+\/send-now)$/);
    if (sn && method === 'POST') {
      const id = sn[1];
      const row = UUID.test(id) ? await repo.getClient(id) : null;
      if (!row || row.deletedAt || !canAccessClient(actor, id, 'approval:grant')) throw new HttpError(404, 'Client not found');
      if (!cfg.filler) throw new HttpError(400, 'Form filling is not installed. In the project folder run: npm.cmd install   then restart. If a browser still cannot start, the message will tell you what to run next.');
      const consents = (await repo.listConsents(id)).filter(c => !c.revokedAt).map(c => c.scope);
      if (!consents.includes('use_profile_for_applications')) throw new HttpError(403, 'Record the client\'s permission to apply on their behalf before sending anything.');
      let todo: ClientSiteRow[];
      if (sn[2] === 'send-approved') {
        const b = await readJson(req);
        const n = Math.min(12, Math.max(1, Math.round(Number(b.limit) || 3)));
        const tried = new Set(Array.isArray(b.skip) ? b.skip.filter((x: unknown) => typeof x === 'string' && UUID.test(x)) : []);
        const list = await repo.listClientSites(id, { status: 'approved', limit: 100_000, offset: 0, hideStaff: true, restored: b.restoredOnly === true });
        const all = list.sites.filter(x => !x.needsStaff && x.url && !tried.has(x.siteId));
        todo = all.slice(0, n);
        const results = await Promise.all(todo.map(s => sendOne(row, s, user.id, consents))); // a few sites at once, each in its own browser window
        let message: string | undefined;
        if (!todo.length && b.restoredOnly === true && tried.size === 0) {
          const restored = await repo.listClientSites(id, { limit: 100_000, offset: 0, restored: true, hideStaff: user.role !== 'admin' });
          const waiting = restored.sites.filter(s => !s.needsStaff && s.url && ['proposed', 'skipped'].includes(s.status)).length;
          const held = restored.sites.filter(s => ['sent', 'done'].includes(s.status)).length;
          const manual = restored.sites.filter(s => s.needsStaff || s.status === 'staff_fill').length;
          message = 'No approved restored sites are ready to send. ' + waiting + ' are suggested or skipped; use "Approve unsent restored sites" to review and approve eligible sites first. ' + held + ' are already sent or completed, and ' + manual + ' need staff. Restoring a site does not change its client approval status.';
        }
        return send(res, 200, { results, remaining: Math.max(0, all.length - todo.length), message });
      }
      const siteId = sn[2].split('/')[0];
      const site = UUID.test(siteId) ? await repo.getClientSite(id, siteId) : null;
      if (!site || !site.url) throw new HttpError(404, 'That site is not on this client\'s list');
      if (site.needsStaff) throw new HttpError(403, 'Sites that need staff are done by hand by an admin, not by the software.');
      if (site.status === 'done' || site.status === 'sent') throw new HttpError(409, 'This form was already sent for this client.');
      if (site.status !== 'approved') throw new HttpError(400, 'Approve this site for the client first.');
      return send(res, 200, { results: [await sendOne(row, site, user.id, consents)], remaining: 0 });
    }

    // ---- fill the form in a visible window and let a person finish it (CAPTCHA, Send). The software sends nothing here. ----
    const hf = path.match(/^\/api\/clients\/([^/]+)\/sites\/([^/]+)\/hand-finish$/);
    if (hf && method === 'POST') {
      const id = hf[1], siteId = hf[2];
      const row = UUID.test(id) ? await repo.getClient(id) : null;
      if (!row || row.deletedAt || !canAccessClient(actor, id, 'approval:grant')) throw new HttpError(404, 'Client not found');
      if (!cfg.handFiller) throw new HttpError(400, 'Form filling is not installed. In the project folder run: npm.cmd install   then restart.');
      const consents = (await repo.listConsents(id)).filter(c => !c.revokedAt).map(c => c.scope);
      if (!consents.includes('use_profile_for_applications')) throw new HttpError(403, 'Record the client\'s permission to apply on their behalf before opening anything.');
      const site = UUID.test(siteId) ? await repo.getClientSite(id, siteId) : null;
      if (!site || !site.url) throw new HttpError(404, 'That site is not on this client\'s list');
      if (site.needsStaff && !(user.role === 'admin' && /captcha/i.test(site.handlingReason ?? ''))) throw new HttpError(403, 'Sites that need staff are done by hand by an admin, not by the software.');
      if (site.status === 'done' || site.status === 'sent') throw new HttpError(409, 'This form was already sent for this client.');
      const r = await openForHand(row, site, user.id);
      return send(res, 200, { opened: true, note: r.note, filled: r.filled, leftForYou: r.leftForYou });
    }

    // ---- CAPTCHA section: open several filled windows at once; a person solves each CAPTCHA and presses Send ----
    const cb = path.match(/^\/api\/clients\/([^/]+)\/sites\/captcha-batch$/);
    if (cb && method === 'POST') {
      const id = cb[1];
      const row = UUID.test(id) ? await repo.getClient(id) : null;
      if (!row || row.deletedAt || !canAccessClient(actor, id, 'approval:grant')) throw new HttpError(404, 'Client not found');
      if (!cfg.handFiller) throw new HttpError(400, 'Form filling is not installed. In the project folder run: npm.cmd install   then restart.');
      const consents = (await repo.listConsents(id)).filter(c => !c.revokedAt).map(c => c.scope);
      if (!consents.includes('use_profile_for_applications')) throw new HttpError(403, 'Record the client\'s permission to apply on their behalf before opening anything.');
      const b = await readJson(req);
      const n = Math.min(10, Math.max(1, Math.round(Number(b.limit) || 5)));
      const skip = new Set(Array.isArray(b.skip) ? b.skip.filter((x: unknown) => typeof x === 'string' && UUID.test(x)) : []);
      const list = await repo.listClientSites(id, { captcha: true, limit: 100_000, offset: 0, hideStaff: user.role !== 'admin' });
      const all = list.sites.filter(x => x.url && !skip.has(x.siteId) && ['proposed', 'approved', 'staff_fill'].includes(x.status)
        && !/^CAPTCHA \(window opened/i.test(x.note ?? '') && !/^Not sent: could not be opened for the CAPTCHA/i.test(x.note ?? ''));   // not already opened, not already failed
      const todo = all.slice(0, n);
      const results = await Promise.all(todo.map(async s => {
        try { await openForHand(row, s, user.id); return { siteId: s.siteId, name: s.name, ok: true as const, text: '' }; }
        catch (e: any) {
          const text = String(e?.message ?? e).slice(0, 200);
          await repo.setClientSiteStatus(id, s.siteId, 'approved', ('Not sent: could not be opened for the CAPTCHA step (' + text + ')').slice(0, 300), user.id).catch(() => {});
          return { siteId: s.siteId, name: s.name, ok: false as const, text };
        }
      }));
      return send(res, 200, { results, remaining: Math.max(0, all.length - todo.length) });
    }

    const visibility = path.match(/^\/api\/clients\/([^/]+)\/results\/(\d+)\/(dismiss|restore)$/);
    if (visibility && method === 'POST') {
      const id = visibility[1], resultId = Number(visibility[2]);
      const row = UUID.test(id) ? await repo.getClient(id) : null;
      if (!row || row.deletedAt || !canAccessClient(actor, id, 'client:write')) throw new HttpError(404, 'Client not found');
      if (!Number.isSafeInteger(resultId)) throw new HttpError(400, 'Invalid result');
      const found = await repo.listSubmissionResults(id, { limit: 1, offset: 0, includeDismissed: true, resultId, hideStaff: user.role !== 'admin' });
      if (!found.entries.length) throw new HttpError(404, 'Result not found');
      await repo.audit({ userId: user.id, clientId: id, action: 'submission.visibility', detail: { resultId, dismissed: visibility[3] === 'dismiss' } });
      return send(res, 200, { ok: true });
    }

    const history = path.match(/^\/api\/clients\/([^/]+)\/results$/);
    if (history && method === 'GET') {
      const id = history[1], row = UUID.test(id) ? await repo.getClient(id) : null;
      if (!row || row.deletedAt || !canAccessClient(actor, id, 'client:read')) throw new HttpError(404, 'Client not found');
      const delivery = url.searchParams.get('delivery') || undefined;
      if (delivery && !['confirmed', 'unconfirmed', 'not_sent'].includes(delivery)) throw new HttpError(400, 'Unknown result filter');
      const limit = Math.min(50, Math.max(1, parseInt(url.searchParams.get('limit') || '10', 10) || 10));
      const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
      return send(res, 200, await repo.listSubmissionResults(id, { limit, offset, delivery: delivery as Delivery | undefined, includeDismissed: url.searchParams.get('includeDismissed') === '1', hideStaff: user.role !== 'admin' }));
    }

    const pr = path.match(/^\/api\/clients\/([^/]+)\/sites\/([^/]+)\/prepare$/);
    if (pr && method === 'POST') {
      const id = pr[1], siteId = pr[2];
      const row = UUID.test(id) ? await repo.getClient(id) : null;
      if (!row || row.deletedAt || !canAccessClient(actor, id, 'client:write')) throw new HttpError(404, 'Client not found');
      if (!cfg.filler) throw new HttpError(400, 'Form filling is not installed. In the project folder run: npm.cmd install   then restart. If a browser still cannot start, the message will tell you what to run next.');
      const site = UUID.test(siteId) ? await repo.getClientSite(id, siteId) : null;
      if (!site || !site.url) throw new HttpError(404, 'That site is not on this client\'s list');
      if (site.needsStaff) throw new HttpError(403, 'Sites that need staff are done by hand by an admin, not by the software.');
      if (site.status === 'done' || site.status === 'sent') throw new HttpError(409, 'This form was already sent for this client.');
      if (site.status !== 'approved') throw new HttpError(400, 'Approve this site for the client first.');
      await sweepPreps();
      for (const old of [...preps.values()]) if (old.clientId === id && old.siteId === siteId) await dropPrep(old.id);
      const profile = decryptProfile(unwrapClientKey(cfg.masterKey, row.wrappedDek, id), id, row.encryptedProfile) as Record<string, unknown>;
      const consents = (await repo.listConsents(id)).filter(c => !c.revokedAt).map(c => c.scope);
      const session = await cfg.filler.prepare(site.url, profile, {
        consents,
        saveLogin: async login => { await storeClientLogin(repo, cfg.masterKey, row, siteId, login, user.id); },
      });
      const rep = session.report;
      await repo.audit({ userId: user.id, clientId: id, action: 'prep.start', detail: { siteId, status: rep.status } });
      let prepId: string | null = null;
      if (rep.status === 'ready_for_approval') { prepId = randomUUID(); preps.set(prepId, { id: prepId, clientId: id, siteId, session, at: Date.now() }); }
      else await session.close();
      // Remember what happened on the site's line, and move sites that must not be automated out of the automatic path.
      const stopped = rep.status === 'ready_for_approval' ? undefined : preparationOutcome(rep);
      const next: ClientSiteStatus = rep.status === 'refused' ? 'skipped' : rep.status === 'blocked' || stopped?.code === 'captcha' ? 'staff_fill' : site.status;
      if (stopped) await saveSubmissionResult(id, site, user.id, stopped, next);
      return send(res, 200, { prepId, status: rep.status, reason: rep.reason, filled: rep.filled.map(f => f.label), aiMapped: rep.aiMapped ?? [], ticked: rep.ticked, needsHuman: rep.needsHuman, skipped: rep.skipped, createsLogin: !!rep.createsLogin, hasScreenshot: !!rep.screenshot });
    }

    const pp = path.match(/^\/api\/preps\/([^/]+)\/(screenshot|approve|cancel)$/);
    if (pp) {
      const prep = UUID.test(pp[1]) ? preps.get(pp[1]) : undefined;
      if (!prep || !canAccessClient(actor, prep.clientId, 'approval:grant')) throw new HttpError(404, 'This prepared form is no longer available. Prepare it again.');
      if (pp[2] === 'screenshot' && method === 'GET') {
        const png = prep.session.report.screenshot;
        if (!png) throw new HttpError(404, 'No picture');
        res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'image/png' });
        return res.end(png);
      }
      if (method !== 'POST') throw new HttpError(404, 'Not found');
      if (pp[2] === 'cancel') { await dropPrep(prep.id); return send(res, 200, { ok: true }); }
      const site = await repo.getClientSite(prep.clientId, prep.siteId);
      const key = prep.clientId + ':' + prep.siteId;
      if (!site || site.status !== 'approved' || activeSends.has(key)) throw new HttpError(409, 'This site is no longer ready to send. Check its latest result before preparing it again.');
      // approve: the form is used once, so a double click cannot send it twice.
      preps.delete(prep.id);
      activeSends.add(key);
      const approvalAttemptId = randomUUID();
      let result: Awaited<ReturnType<FillSession['submit']>>;
      let started = false;
      try {
        await reserveSubmission(prep.clientId, prep.siteId, user.id, approvalAttemptId);
        started = true;
        result = await prep.session.submit();
      } catch (e) {
        if (!started) throw e;
        result = { status: 'sent_unconfirmed', attempted: true, detail: 'The attempt stopped without a reliable final result. Check the site before retrying.' };
      } finally { await prep.session.close().catch(() => {}); activeSends.delete(key); }
      const classified = submissionOutcome(result);
      const next: ClientSiteStatus = classified.delivery === 'confirmed' ? 'done' : result.status === 'blocked' ? 'staff_fill'
        : classified.delivery === 'not_sent' ? 'approved' : 'sent';
      const saved = await saveSubmissionResult(prep.clientId, site, user.id, classified, next, approvalAttemptId);
      await repo.audit({ userId: user.id, clientId: prep.clientId, action: 'prep.approve', detail: { siteId: prep.siteId, result: result.status } });
      return send(res, 200, { result, siteStatus: next, submission: saved.result });
    }

    const cs = path.match(/^\/api\/clients\/([^/]+)\/sites(?:\/(propose|[^/]+))?$/);
    if (cs) {
      const id = cs[1], sub = cs[2];
      const row = UUID.test(id) ? await repo.getClient(id) : null;
      if (!row || row.deletedAt || !canAccessClient(actor, id, 'client:read')) throw new HttpError(404, 'Client not found');
      if (!sub && method === 'GET') {
        const st = url.searchParams.get('status') ?? '';
        const status = (['proposed', 'approved', 'skipped', 'staff_fill', 'done', 'sent'] as const).find(x => x === st);
        const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '50', 10) || 50, 1), 200);
        const offset = Math.max(parseInt(url.searchParams.get('offset') ?? '0', 10) || 0, 0);
        return send(res, 200, { ...(await repo.listClientSites(id, { status, limit, offset, hideStaff: user.role !== 'admin', hasNote: url.searchParams.get('hasNote') === '1', captcha: url.searchParams.get('captcha') === '1', restored: url.searchParams.get('restored') === '1', notePrefixes: ({ already: ['ALREADY MEMBER'], likely: ['LIKELY SENT'] } as Record<string, string[]>)[url.searchParams.get('tag') ?? ''] })), staffSitesVisible: user.role === 'admin' });
      }
      if (method === 'POST') {
        if (!canAccessClient(actor, id, 'client:write')) throw new HttpError(403, 'Not allowed');
        const b = await readJson(req);
        if (sub === 'propose') {
          const profile = decryptProfile(unwrapClientKey(cfg.masterKey, row.wrappedDek, id), id, row.encryptedProfile) as Record<string, unknown>;
          const chosen = b.count !== undefined ? String(b.count) : String(profile.siteCount ?? '');
          if (!chosen) throw new HttpError(400, 'Choose how many sites this client wants to join first (on the client form), then try again.');
          const target = chosen === 'all' ? null : parseInt(chosen, 10);
          if (target !== null && !(Number.isInteger(target) && target >= 1 && target <= 5000)) throw new HttpError(400, 'The number of sites must be "all" or a whole number from 1 to 5000');
          const added = await repo.proposeClientSites(id, target, user.role === 'admin');
          await repo.audit({ userId: user.id, clientId: id, action: 'clientsites.propose', detail: { added } });
          return send(res, 200, { added });
        }
        if (sub === 'approve-restored') {
          if (!canAccessClient(actor, id, 'approval:grant')) throw new HttpError(403, 'Not allowed to approve sites');
          const list = await repo.listClientSites(id, { limit: 100_000, offset: 0, restored: true, hideStaff: true });
          let approved = 0;
          for (const candidate of list.sites) {
            if (candidate.needsStaff || !candidate.url || !['proposed', 'skipped'].includes(candidate.status)) continue;
            if (/ALREADY MEMBER|LIKELY SENT|Needs verification|sent[, ]+not confirmed/i.test(candidate.note || '')) continue;
            const current = await repo.getClientSite(id, candidate.siteId);
            if (!current || current.status !== candidate.status || current.needsStaff || !current.restored || !current.url) continue;
            if (/ALREADY MEMBER|LIKELY SENT|Needs verification|sent[, ]+not confirmed/i.test(current.note || '')) continue;
            await repo.setClientSiteStatus(id, candidate.siteId, 'approved', current.note, user.id);
            approved++;
          }
          await repo.audit({ userId: user.id, clientId: id, action: 'clientsites.approve_restored', detail: { approved } });
          return send(res, 200, { approved });
        }
        if (sub === 'approve-all') {
          const approved = await repo.approveProposedClientSites(id, user.id);
          await repo.audit({ userId: user.id, clientId: id, action: 'clientsites.approve_all', detail: { approved } });
          return send(res, 200, { approved });
        }
        if (sub && UUID.test(sub)) {
          const site = await repo.getClientSite(id, sub);
          if (!site || (site.needsStaff && user.role !== 'admin')) throw new HttpError(404, 'That site is not on this client\'s list');
          const status = String(b.status ?? '');
          const note = typeof b.note === 'string' ? b.note.trim().slice(0, 300) : '';
          if (!['proposed', 'approved', 'skipped', 'staff_fill', 'done'].includes(status)) throw new HttpError(400, 'Unknown status');
          if (status === 'approved' && site.needsStaff) throw new HttpError(400, 'This site needs staff. Choose "Staff will fill this" or "Skip".');
          if (status === 'staff_fill' && !site.needsStaff) throw new HttpError(400, 'This site does not need staff. Choose "Approve" or "Skip".');
          if (status === 'done') {
            if (!['approved', 'staff_fill', 'sent'].includes(site.status)) throw new HttpError(400, 'Approve the site (or choose "Staff will fill this") before marking it done.');
            if (note.length < 3) throw new HttpError(400, 'Write a short note on how you know it is done (for example the confirmation message). Do not include personal details.');
          }
          await repo.setClientSiteStatus(id, sub, status as ClientSiteStatus, note || null, user.id);
          await repo.audit({ userId: user.id, clientId: id, action: 'clientsite.status', detail: { siteId: sub, status } });
          return send(res, 200, { ok: true });
        }
      }
      throw new HttpError(404, 'Not found');
    }

    const lg = path.match(/^\/api\/clients\/([^/]+)\/logins$/);
    if (lg && method === 'GET') {
      const id = lg[1];
      const row = UUID.test(id) ? await repo.getClient(id) : null;
      if (!row || row.deletedAt) throw new HttpError(404, 'Client not found');
      if (!can(actor, 'login:read')) throw new HttpError(403, 'Only admins can see the usernames and passwords made for clients');
      const logins = await readClientLogins(repo, cfg.masterKey, row);
      await repo.audit({ userId: user.id, clientId: id, action: 'logins.read', detail: { count: logins.length } });
      return send(res, 200, { logins });
    }

    const m = path.match(/^\/api\/clients\/([^/]+)(?:\/(assign|consents))?$/);
    if (m) {
      const id = m[1], sub = m[2];
      const row = UUID.test(id) ? await repo.getClient(id) : null;
      // Not found and not allowed look identical, so nobody can probe which clients exist.
      if (!row || row.deletedAt || !canAccessClient(actor, id, 'client:read')) throw new HttpError(404, 'Client not found');

      if (!sub && method === 'GET') {
        const profile = decryptProfile(unwrapClientKey(cfg.masterKey, row.wrappedDek, id), id, row.encryptedProfile) as Record<string, unknown>;
        const cats = (url.searchParams.get('categories') ?? '').split(',').filter(Boolean);
        await repo.audit({ userId: user.id, clientId: id, action: 'client.read' });
        return send(res, 200, {
          id, displayName: row.displayName, profile, missing: missingInfo(profile, cats),
          consents: await repo.listConsents(id),
        });
      }
      if (!sub && method === 'PUT') {
        if (!canAccessClient(actor, id, 'client:write')) throw new HttpError(403, 'Not allowed to edit clients');
        const b = await readJson(req);
        const v = validateProfile(b.profile ?? {});
        if (!v.ok) throw new HttpError(400, 'Profile has problems', { errors: v.errors });
        const displayName = b.displayName === undefined ? row.displayName : String(b.displayName).trim();
        if (!displayName || displayName.length > 100) throw new HttpError(400, 'Give the client a short label (1 to 100 characters)');
        const dek = unwrapClientKey(cfg.masterKey, row.wrappedDek, id);
        await repo.updateClient(id, displayName, encryptProfile(dek, id, v.profile));
        await repo.audit({ userId: user.id, clientId: id, action: 'client.update', detail: { fields: Object.keys(v.profile) } });
        return send(res, 200, { ok: true });
      }
      if (!sub && method === 'DELETE') {
        if (!canAccessClient(actor, id, 'client:delete')) throw new HttpError(403, 'You do not have permission to delete this client');
        await repo.softDeleteClient(id);
        await repo.audit({ userId: user.id, clientId: id, action: 'client.delete' });
        return send(res, 200, { ok: true });
      }
      if (sub === 'consents' && method === 'POST') {
        if (!canAccessClient(actor, id, 'client:write')) throw new HttpError(403, 'Not allowed');
        const b = await readJson(req);
        const scope = String(b.scope ?? '').trim();
        if (!scope || scope.length > 100) throw new HttpError(400, 'Describe what the client agreed to (1 to 100 characters)');
        if (b.revoke === true) {
          const done = await repo.revokeConsent(id, scope);
          await repo.audit({ userId: user.id, clientId: id, action: 'consent.revoke', detail: { scope } });
          return send(res, 200, { ok: done });
        }
        await repo.addConsent(id, scope, user.id);
        await repo.audit({ userId: user.id, clientId: id, action: 'consent.add', detail: { scope } });
        return send(res, 201, { ok: true });
      }

    }

    if (path === '/api/sites' || path.startsWith('/api/sites/')) {
      if (path === '/api/sites' && method === 'GET') {
        if (!can(actor, 'site:read')) throw new HttpError(403, 'Not allowed');
        const view = (url.searchParams.get('view') ?? 'active') as SiteView;
        if (!['active', 'staff', 'research', 'removed', 'all'].includes(view)) throw new HttpError(400, 'Bad view');
        const category = url.searchParams.get('category') || undefined;
        if (category && !['subscription', 'rewards', 'membership', 'employment', 'other'].includes(category)) throw new HttpError(400, 'Bad category');
        const q = (url.searchParams.get('q') ?? '').trim().slice(0, 100) || undefined;
        const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '50', 10) || 50, 1), 100);
        const offset = Math.max(parseInt(url.searchParams.get('offset') ?? '0', 10) || 0, 0);
        const [list, counts, candidates] = await Promise.all([repo.listSites({ q, category, view, limit, offset }), repo.siteCounts(), repo.candidateCounts()]);
        const reliability = await repo.siteReliability(list.sites.map(site => site.id));
        const rated = { ...list, sites: list.sites.map(site => ({ ...site, reliability: reliability[site.id] || { score: 50, label: 'Untested', attempts: 0, confirmed: 0, siteIssues: 0, unconfirmed: 0, lastAttempt: null } })) };
        return send(res, 200, { ...rated, counts, candidates, capacity, searchReady: !!cfg.search, browserReady: !!cfg.browser, aiDiscoveryReady: !!cfg.discoveryAi, limit, offset });
      }
      if (path === '/api/sites/import' && method === 'POST') {
        if (!can(actor, 'site:write')) throw new HttpError(403, 'Not allowed');
        const b = await readJson(req, 8_000_000);
        const filename = String(b.filename ?? '').slice(0, 200) || 'import';
        if (typeof b.content !== 'string' || !b.content.trim()) throw new HttpError(400, 'The file is empty');
        let rows;
        try { rows = parseSiteList(filename, b.content); } catch (e: any) { throw new HttpError(400, String(e?.message ?? 'Could not read this file')); }
        const entries = buildEntries(rows);
        const good = entries.filter(e => e.status === 'ok' && e.domain);
        const sites = good.map(e => ({
          name: (e.name || e.domain!).slice(0, 300), domain: e.domain!,
          url: /^https?:\/\//i.test(e.originalUrl) ? e.originalUrl : e.normalizedUrl!,
          category: e.category, automationPolicy: e.suggestedAutomationPolicy, notes: e.notes.slice(0, 1000),
        }));
        const r = await repo.importSites(filename, rows, sites, cfg.cleanup ?? { removed: {}, research: [] }, user.id);
        const summary = {
          rowsRead: entries.length, added: r.added, alreadyInDirectory: r.alreadyThere,
          duplicatesInFile: entries.filter(e => e.status === 'duplicate').length,
          unreadable: entries.filter(e => e.status === 'unparseable').length,
          markedManualOnly: good.filter(e => e.sensitive).length,
          alreadyRemovedFromEarlierCheck: r.cleanedRemoved, needNewAddress: r.cleanedResearch,
        };
        await repo.audit({ userId: user.id, action: 'sites.import', detail: { filename, ...summary } });
        return send(res, 201, summary);
      }
      const um = path.match(/^\/api\/sites\/([^/]+)\/signup-page$/);
      if (um && method === 'POST') {
        if (!can(actor, 'site:write')) throw new HttpError(403, 'Not allowed');
        if (!UUID.test(um[1])) throw new HttpError(404, 'Not found');
        const b = await readJson(req);
        let u: URL;
        try { u = new URL(String(b.url ?? '').trim()); } catch { throw new HttpError(400, 'Paste the full web address, starting with https://'); }
        if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new HttpError(400, 'The address must start with https:// or http://');
        if (u.username || u.password) throw new HttpError(400, 'Do not put a user name or password in the address');
        u.hash = '';
        const done = await repo.setSiteSignupPage(um[1], u.toString().slice(0, 2000));
        if (done === 'not_found') throw new HttpError(404, 'Site not found');
        if (done === 'other_site') throw new HttpError(400, 'That address is on a different website than this one. Add it as its own site instead.');
        await repo.audit({ userId: user.id, action: 'site.signup_page_set', detail: { siteId: um[1] } });
        return send(res, 200, { ok: true });
      }
      const dn = path.match(/^\/api\/sites\/([^/]+)\/do-not-work$/);
      if (dn && method === 'POST') {   // for a site that is already in Removed: change its note so nobody tries to restore it
        if (!can(actor, 'site:write')) throw new HttpError(403, 'Not allowed');
        if (!UUID.test(dn[1])) throw new HttpError(404, 'Not found');
        const b = await readJson(req);
        const why = String(b.reason ?? '').trim().slice(0, 200);
        if (!(await repo.setSiteDoNotWork(dn[1], 'removed for good: DO NOT WORK' + (why ? ' (' + why + ')' : '')))) throw new HttpError(400, 'Only a removed site can be marked this way.');
        await repo.audit({ userId: user.id, action: 'site.do_not_work', detail: { siteId: dn[1] } });
        return send(res, 200, { ok: true });
      }
      const m = path.match(/^\/api\/sites\/([^/]+)\/(remove|restore)$/);
      if (m && method === 'POST') {
        if (!can(actor, 'site:write')) throw new HttpError(403, 'Not allowed');
        if (!UUID.test(m[1])) throw new HttpError(404, 'Not found');
        let reason: string | null = null;
        if (m[2] === 'remove') {
          const b = await readJson(req);
          reason = String(b.reason ?? '').trim().slice(0, 300) || 'removed by staff';
        }
        let done: { fingerprint: string[] } | null;
        if (m[2] === 'restore') { done = (await repo.restoreSiteForRetry(m[1])) ? { fingerprint: [] } : null; }   // remembered as "restored" so it can be retried from the client pages
        else done = await repo.setSiteRemoved(m[1], reason);
        if (!done) throw new HttpError(404, 'Site not found');
        await repo.audit({ userId: user.id, action: m[2] === 'remove' ? 'site.remove' : 'site.restore', detail: { siteId: m[1] } });
        const replaced = m[2] === 'remove' ? (await refill(done.fingerprint)).added : [];
        if (replaced.length) await repo.audit({ userId: user.id, action: 'site.replace', detail: { removed: m[1], added: replaced.map(x => x.domain) } });
        return send(res, 200, { ok: true, replacedBy: replaced.map(x => x.name) });
      }
      throw new HttpError(404, 'Not found');
    }

    if (path === '/api/discovery/history') {
      if (!can(actor, 'site:write')) throw new HttpError(403, 'Not allowed');
      if (method === 'GET') {
        const limit = Math.min(50, Math.max(1, parseInt(url.searchParams.get('limit') || '20', 10) || 20));
        const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
        const history = await repo.discoveryHistory(limit, offset);
        return send(res, 200, { total: history.total, entries: history.entries.map(e => ({ id: e.id, at: e.at, ...e.detail as object })) });
      }
      if (method === 'POST') {
        const b = await readJson(req, 100_000);
        if (!b || typeof b !== 'object' || Array.isArray(b) || typeof b.runId !== 'string' || !UUID.test(b.runId)) throw new HttpError(400, 'Invalid discovery run');
        const statuses = ['running', 'full', 'stopped', 'no_finds', 'error'];
        if (!statuses.includes(b.status)) throw new HttpError(400, 'Invalid run status');
        const number = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 100000000) : 0;
        const bag = (value: unknown) => {
          const result: Record<string, number> = {};
          if (value && typeof value === 'object' && !Array.isArray(value)) for (const [key, n] of Object.entries(value).slice(0, 50)) {
            const clean = redact(key).slice(0, 400);
            if (!['__proto__', 'constructor', 'prototype'].includes(clean)) result[clean] = number(n);
          }
          return result;
        };
        const totals: Record<string, number> = {};
        for (const key of ['looked','simple','unknown','staff','excluded','unreachable','addedToDirectory','filteredSearchHits']) totals[key] = number(b.totals?.[key]);
        const started = new Date(typeof b.startedAt === 'string' ? b.startedAt : '');
        await repo.audit({ userId: user.id, action: 'discovery.run', detail: {
          runId: b.runId, startedAt: Number.isFinite(started.getTime()) ? started.toISOString() : new Date().toISOString(), ai: b.ai === true,
          status: b.status, batches: number(b.batches), requests: number(b.requests), active: number(b.active), capacity: number(b.capacity),
          noFindLimit: number(b.noFindLimit), empty: number(b.empty), totals, unreadable: bag(b.unreadable), reviewReasons: bag(b.reviewReasons),
          note: typeof b.note === 'string' ? redact(b.note).slice(0, 1000) : '',
        } });
        return send(res, 200, { ok: true });
      }
      throw new HttpError(404, 'Not found');
    }
    if (path === '/api/discovery/review' && method === 'GET') {
      if (!can(actor, 'site:write')) throw new HttpError(403, 'Not allowed');
      const view = url.searchParams.get('view') || 'held';
      if (!['held', 'blocked', 'staff', 'qualified', 'dismissed'].includes(view)) throw new HttpError(400, 'Unknown candidate view');
      const limit = Math.min(50, Math.max(1, parseInt(url.searchParams.get('limit') || '20', 10) || 20));
      const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
      return send(res, 200, await repo.listReviewCandidates({ view: view as CandidateView, q: (url.searchParams.get('q') || '').slice(0, 200), limit, offset }));
    }
    const candidateAction = path.match(/^\/api\/discovery\/review\/([^/]+)\/(recheck|dismiss|restore|signup-page)$/);
    if (candidateAction && method === 'POST') {
      if (!can(actor, 'site:write')) throw new HttpError(403, 'Not allowed');
      const id = candidateAction[1], action = candidateAction[2];
      const candidate = UUID.test(id) ? await repo.getReviewCandidate(id) : null;
      if (!candidate) throw new HttpError(404, 'Candidate not found');
      if (candidate.state === 'promoted') throw new HttpError(409, 'This candidate is already in the directory');
      if (reviewingCandidates.has(id)) throw new HttpError(409, 'A check is already running for this candidate');
      if (action === 'signup-page') {
        if (candidate.state !== 'pending') throw new HttpError(409, 'Restore this candidate before editing its signup page');
        const body = await readJson(req);
        const raw = typeof body.url === 'string' ? body.url.trim() : '';
        if (!raw || raw.length > 2000) throw new HttpError(400, 'Enter a full signup address of up to 2000 characters');
        let target: URL;
        try { target = new URL(raw); } catch { throw new HttpError(400, 'Paste the full address starting with https://'); }
        if (!['https:', 'http:'].includes(target.protocol) || !normalizeUrl(raw)) throw new HttpError(400, 'Use a public http:// or https:// website address');
        if (target.username || target.password) throw new HttpError(400, 'Do not include a username or password in the address');
        if (!/^#\//.test(target.hash)) target.hash = '';
        const nextUrl = target.toString();
        if (nextUrl === candidate.url) return send(res, 200, { ok: true, unchanged: true });
        const ok = await repo.updateReviewCandidate(id, { ...candidate, url: nextUrl, handling: 'unknown', handlingReason: 'Signup page updated by staff; browser and US/free eligibility recheck required.', fingerprint: [], score: 0 });
        if (!ok) throw new HttpError(409, 'Candidate state changed; refresh and try again');
        await repo.audit({ userId: user.id, action: 'candidate.signup_page', detail: { candidateId: id, previousUrl: candidate.url, url: nextUrl } });
        return send(res, 200, { ok: true });
      }
      if (action !== 'recheck') {
        const ok = await repo.setCandidateReviewState(id, action === 'dismiss' ? 'rejected' : 'pending');
        if (!ok) throw new HttpError(409, 'Candidate state changed; refresh this page');
        await repo.audit({ userId: user.id, action: 'candidate.' + action, detail: { candidateId: id } });
        return send(res, 200, { ok: true });
      }
      if (candidate.state !== 'pending') throw new HttpError(409, 'Restore this candidate before rechecking');
      if (/bot_blocked|robots_disallowed|automated.*block|blocked.*automated/i.test(candidate.handlingReason)) throw new HttpError(400, 'This site blocks automated access or disallows it in robots.txt. Inspect it manually; automatic rechecks are disabled.');
      if (!cfg.browser || !cfg.discoveryAi) throw new HttpError(400, 'Rechecking requires browser verification and AI discovery configuration');
      reviewingCandidates.add(id);
      try {
        const result = await findCandidates([candidate.url], candidate.source, true, id);
        const promoted = await refill();
        const updated = await repo.getReviewCandidate(id);
        await repo.audit({ userId: user.id, action: 'candidate.recheck', detail: { candidateId: id, qualified: result.simple, excluded: result.excluded } });
        return send(res, 200, { result, candidate: updated, addedToDirectory: promoted.added.length });
      } finally { reviewingCandidates.delete(id); }
    }

    if (path.startsWith('/api/discovery/') || path === '/api/directory/refill') {
      if (method !== 'POST') throw new HttpError(404, 'Not found');
      if (!can(actor, 'site:write')) throw new HttpError(403, 'Not allowed');
      if (path === '/api/discovery/check') {
        const b = await readJson(req);
        const limit = Math.min(Math.max(parseInt(String(b.limit ?? 30), 10) || 30, 1), 100);
        if ((b.browser === true || b.forms === true || b.captcha === true || b.removed === true) && !cfg.browser) throw new HttpError(400, 'The browser check is not installed. In the project folder run: npm.cmd install   then restart. If a browser still cannot start, the page will tell you what to run next.');
        const par = Math.min(16, Math.max(1, parseInt(String(b.parallel ?? 2), 10) || 2));
        if (b.removed === true) {
          // look again, in a browser, at sites that were removed for "no sign-up form": put back the ones that turn out to have one (while there is room)
          const queue = await repo.removedCheckQueue(limit, 12 * 3_600_000);
          const out = { looked: 0, restored: 0, noRoom: 0, stillNoForm: 0, skipped: 0 };
          const counts = await repo.siteCounts();
          let room = Math.max(0, (cfg.siteCapacity ?? 2500) - counts.active);
          const looks: { id: string; r: FetchResult }[] = [];
          await pool(queue, par, async q => { looks.push({ id: q.id, r: await within(90_000, cfg.browser!.analyze(q.url), () => ({ outcome: 'timeout' }) as FetchResult) }); });
          for (const { id, r } of looks) {
            out.looked++;
            if (r.outcome !== 'ok' || !r.html) { out.skipped++; await repo.recordSiteCheck(id, {}); continue; }
            const a = analyzeHtml(r.html), cl = classify(a);
            if (cl.handling === 'simple' || cl.handling === 'staff') {
              if (room > 0) {
                await repo.restoreSiteForRetry(id);
                await repo.recordSiteCheck(id, { handling: cl.handling, reason: cl.reason, fingerprint: fingerprint(a) }, { outcome: 'ok' });
                await repo.audit({ userId: user.id, action: 'site.auto_restore', detail: { siteId: id } });
                room--; out.restored++;
              } else { out.noRoom++; await repo.recordSiteCheck(id, {}); }
            } else { out.stillNoForm++; await repo.recordSiteCheck(id, {}); }
          }
          return send(res, 200, out);
        }
        const r = await checkSites(limit, user.id, b.captcha === true ? 'captcha' : b.forms === true ? 'forms' : b.browser === true ? 'browser' : b.recheck === true ? 'recheck' : b.health === true ? 'health' : 'normal', par);
        await repo.audit({ userId: user.id, action: 'discovery.check', detail: { ...r, replacements: r.replacements.length } });
        return send(res, 200, { ...r, remaining: (await repo.siteCounts()).unchecked });
      }
      if (path === '/api/discovery/candidates') {
        const b = await readJson(req);
        const urls = Array.isArray(b.urls) ? b.urls.filter((x: unknown) => typeof x === 'string').slice(0, 200) as string[] : [];
        if (!urls.length) throw new HttpError(400, 'Paste at least one website address');
        const r = await findCandidates(urls, 'pasted');
        const f = await refill();
        await repo.audit({ userId: user.id, action: 'discovery.candidates', detail: { ...r, addedToDirectory: f.added.length } });
        return send(res, 200, { ...r, addedToDirectory: f.added.length });
      }
      if (path === '/api/discovery/remove-unclear') {
        const ids = await repo.browserUnclearIds();
        const added: string[] = [];
        for (const id of ids) {
          const gone = await repo.setSiteRemoved(id, 'no sign-up form found, even in a browser (removed by staff)');
          if (gone) added.push(...(await refill(gone.fingerprint)).added.map(x => x.domain));
        }
        await repo.audit({ userId: user.id, action: 'directory.remove_unclear', detail: { removed: ids.length, replaced: added.length } });
        return send(res, 200, { removed: ids.length, replaced: added.length });
      }
      if (path === '/api/discovery/search') {
        const searchStartedAt = new Date().toISOString();
        if (!cfg.search) throw new HttpError(400, 'Searching is not set up. Add SEARCH_PROVIDER=brave and SEARCH_API_KEY to the .env file, then restart. You can also paste website addresses instead.');
        const b = await readJson(req);
        const ai = b.ai === true;
        if (ai && !cfg.discoveryAi) throw new HttpError(400, 'AI discovery is not configured. Set LLM_PROVIDER=openai and LLM_API_KEY in .env, then restart. Keep keys private; do not paste them into chat.');
        if (!cfg.browser) throw new HttpError(400, 'Browser verification is required for discovery. Install Playwright and a supported browser, then restart.');
        const urls: string[] = [];
        let filteredSearchHits = 0, totalSearchHits = 0;
        let queries = pickQueries(6).map(q => q + ' United States -jobs -careers -contest');
        if (ai) {
          try { queries = await cfg.discoveryAi!.queries(pickQueries(6)); }
          catch { throw new HttpError(502, 'AI search planning failed. No searches were run. Check the AI configuration or try standard search.'); }
        }
        try {
          for (const q of queries) for (const h of await cfg.search.search(q, 20)) {
            totalSearchHits++;
            if (!usefulSignupHit(h)) { filteredSearchHits++; continue; }
            urls.push(h.url);
          }
        } catch (e: any) { throw new HttpError(502, 'The search service failed: ' + String(e?.message ?? 'unknown error').slice(0, 200)); }
        const keys = [...new Set(urls.map(u => dedupeKey(u)).filter((d): d is string => !!d))];
        const known = await repo.knownDomains(keys);
        const used = new Set<string>();
        const fresh = urls.sort((a, b) => Number(/signup|sign-up|join|register|newsletter|rewards|loyalty|subscribe/i.test(b)) - Number(/signup|sign-up|join|register|newsletter|rewards|loyalty|subscribe/i.test(a)))
          .filter(u => { const d = dedupeKey(u); if (!d || known.has(d) || used.has(d)) return false; used.add(d); return true; }).slice(0, 12);
        const r = await findCandidates(fresh, 'search', ai);
        r.alreadyKnown += known.size;
        const f = await refill();
        const runId = typeof b.runId === 'string' && UUID.test(b.runId) ? b.runId : null;
        await repo.audit({ userId: user.id, action: 'discovery.search', detail: { runId, aiAssisted: ai, searchRequests: queries.length, found: urls.length, ...r, addedToDirectory: f.added.length } });
        if (!runId) await repo.audit({ userId: user.id, action: 'discovery.run', detail: {
          runId: randomUUID(), startedAt: searchStartedAt, ai, status: 'completed', batches: 1, requests: queries.length,
          totals: { ...r, addedToDirectory: f.added.length, filteredSearchHits }, active: f.active, capacity, unreadable: r.unreadable, reviewReasons: r.reviewReasons,
          note: 'Single search batch completed.', noFindLimit: 0,
        } });
        return send(res, 200, { aiAssisted: ai, searchRequests: queries.length, filteredSearchHits, totalSearchHits, region: 'US', found: urls.length, ...r, addedToDirectory: f.added.length, active: (await repo.siteCounts()).active, capacity });
      }
      if (path === '/api/directory/refill') {
        const f = await refill();
        await repo.audit({ userId: user.id, action: 'directory.refill', detail: { added: f.added.length } });
        return send(res, 200, { added: f.added.length, active: f.active, capacity, waitingCandidates: (await repo.candidateCounts()).simple });
      }
      throw new HttpError(404, 'Not found');
    }

    if (method === 'GET' && path === '/api/audit') {
      if (!can(actor, 'audit:read')) throw new HttpError(403, 'Only admins can view the activity log');
      const clientId = url.searchParams.get('clientId') ?? undefined;
      if (clientId && !UUID.test(clientId)) throw new HttpError(400, 'Bad client id');
      return send(res, 200, { entries: await repo.listAudit(clientId) });
    }

    throw new HttpError(404, 'Not found');
  }

  return createServer((req, res) => {
    const started = Date.now();
    const ctx = { userId: null as string | null };
    res.on('finish', () => {
      log(redactObject({ at: new Date().toISOString(), method: req.method, path: (req.url ?? '').split('?')[0],
        status: res.statusCode, ms: Date.now() - started, actor: ctx.userId }) as object);
    });
    handle(req, res, ctx).catch(err => {
      if (res.headersSent) return res.end();
      if (err instanceof HttpError) return send(res, err.status, { error: err.message, ...err.extra });
      log({ level: 'error', message: redact(String(err?.message ?? err)) });
      if (err?.code === '42703' || err?.code === '42P01') return send(res, 500, { error: 'The database is out of date. Stop the app, run: npm.cmd run db:migrate   then start it again.' });
      send(res, 500, { error: 'Something went wrong' });
    });
  });
}
