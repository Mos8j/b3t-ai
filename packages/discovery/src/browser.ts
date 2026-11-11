import { checkHost, robotsAllows_, type FetchDeps, type FetchResult } from './fetcher';
import { dedupeKey } from '../../core/src/url';
import { analyzeHtml } from './analyze';

const hasSignupForm = (html: string) => analyzeHtml(html).forms.length > 0 && (!html.includes('<!--UCAAS-DOM signup=') || html.includes('<!--UCAAS-DOM signup=visible-->'));

/**
 * Looks at a page the way a browser does: it runs the page's JavaScript, then reads the finished page.
 * It only LOOKS. It never clicks, types, submits, downloads, or solves anything.
 * It identifies itself honestly, respects robots.txt, refuses private addresses (for the page and everything the page loads),
 * and if a site shows a "verify you are human" screen or blocks it, that is reported as "bot_blocked" and left to staff.
 * Needs Playwright (npm package) plus a browser: Microsoft Edge (already on Windows), Chrome, or Playwright's own Chromium.
 */
export interface BrowserDeps extends FetchDeps {
  launchArgs?: string[];
  /** false opens a visible window (used when a person must finish a form by hand). Default true. */
  headless?: boolean;
  /** Replaces the Playwright import (tests). */
  loader?: () => Promise<any>;
  channels?: (string | undefined)[];
}
export interface BrowserChecker { analyze(url: string): Promise<FetchResult>; close(): Promise<void> }

const UA = 'Mozilla/5.0 (compatible; UCAAS-SiteChecker/0.1; checks public sign-up pages)';
const CHALLENGE = /just a moment|attention required|access denied|verify (that )?you are (a )?human|checking your browser|are you a robot|unusual traffic|pardon our interruption|request blocked|press (and|&) hold/i;
const SIGNUP_LOOSE = /(sign[\s-]?up|join|register|subscrib|newsletter|rewards?|member(ship)?|loyalty|account|enroll|get started|apply|offers?|updates|email list|insider|club|vip)/i;
const SIGNUP_PATH = /(sign-?up|join|register|subscribe|newsletter|rewards?|member|loyalty|enroll|insider|vip|offers|email-?list)/i;
const SIGNUP_LINK = /^(sign[\s-]?up|join( now| us| free| today| the club)?|register|subscribe|create (an )?account|get started|become a member|enroll( now)?)\b/i;

/**
 * Runs inside the page: is a CAPTCHA box really SHOWN next to the sign-up (e-mail) boxes? Script text, hidden widgets, the small
 * "protected by reCAPTCHA" badge, and a CAPTCHA belonging to some other form (comments, contact) do not count.
 * Plain JS so no build tool adds helper code to it. Returns 'visible' or 'none'.
 */
export const CAPTCHA_PROBE_JS = `(function () {
  var shown = function (e) { var r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 50 && r.height > 30 && s.visibility !== 'hidden' && s.display !== 'none' && parseFloat(s.opacity || '1') > 0.1; };
  var widgets = Array.prototype.filter.call(document.querySelectorAll('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"], iframe[src*="challenges.cloudflare"], .g-recaptcha, .h-captcha, .cf-turnstile'),
    function (e) { return !e.closest('.grecaptcha-badge') && shown(e); });
  if (!widgets.length) return 'none';
  var mails = Array.prototype.filter.call(document.querySelectorAll('input'), function (i) {
    return i.getClientRects().length > 0 && (i.type === 'email' || /e-?mail/i.test((i.name || '') + (i.id || '') + (i.placeholder || '')));
  });
  if (!mails.length) return 'visible';
  return widgets.some(function (w) {
    var n = w;
    for (var k = 0; k < 7 && n && n !== document.body; k++, n = n.parentElement) { if (mails.some(function (m) { return n.contains(m); })) return true; }
    return false;
  }) ? 'visible' : 'none';
})()`;

/** The finished page as HTML, plus what a real look at it showed about CAPTCHAs (read by analyzeHtml). */
export async function renderedHtml(page: any): Promise<string> {
  const html: string = (await page.content().catch(() => '')).slice(0, 1_500_000);
  const probe: string = await page.evaluate(CAPTCHA_PROBE_JS).catch(() => '');
  const signup: boolean = await page.evaluate(`(function(){
    var visible=function(e){var r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'&&parseFloat(s.opacity||'1')>0&&!e.disabled;};
    return Array.prototype.some.call(document.querySelectorAll('input'),function(e){
      if(!visible(e)||e.type==='hidden'||e.readOnly||!(e.type==='email'||/e-?mail/i.test((e.name||'')+' '+(e.id||'')+' '+(e.getAttribute('aria-label')||'')+' '+(e.placeholder||''))))return false;
      var f=e.form||e.parentElement;
      for(var n=0;f&&f!==document.body&&n<8;n++,f=f.parentElement){
        if(Array.prototype.some.call(f.querySelectorAll('button,input[type=submit],input[type=button],[role=button]'),function(b){return visible(b)&&!(/close|cancel|dismiss|log[ -]?in|sign[ -]?in/i.test((b.textContent||'')+' '+(b.getAttribute('aria-label')||'')));}))return true;
        if(e.form)break;
      }
      return false;
    });
  })()`).catch(() => false);
  return html + '<!--UCAAS-DOM captcha=' + (probe === 'visible' ? 'visible' : 'none') + '--><!--UCAAS-DOM signup=' + (signup ? 'visible' : 'none') + '-->';
}

/** Scrolls down and back up so pop-ups that wait for a scroll appear. Only scrolls; never clicks or types. */
export async function scrollNudge(page: any): Promise<void> {
  for (const f of [0.35, 0.7, 1]) {
    await page.evaluate("window.scrollTo(0, Math.floor((document.documentElement.scrollHeight || 0) * " + f + "))").catch(() => {});
    await page.waitForTimeout(700);
  }
  await page.evaluate("window.scrollTo(0, 0)").catch(() => {});
  await page.waitForTimeout(800);
}

/** Scrolls down the page and back, because some sign-up pop-ups only appear once a visitor scrolls. Harmless: no clicks, no typing. */
export async function scrollToWake(page: any): Promise<void> {
  await page.evaluate(`(async function () {
    var h = Math.max(document.body ? document.body.scrollHeight : 0, 1500);
    var y = 0;
    while (y < Math.min(h, 12000)) { y += 600; window.scrollTo(0, y); await new Promise(function (r) { setTimeout(r, 250); }); }
    await new Promise(function (r) { setTimeout(r, 800); });
    window.scrollTo(0, 0);
  })()`).catch(() => {});
}

export function looksLikeBotChallenge(title: string, text: string): boolean {
  return CHALLENGE.test(title) || CHALLENGE.test(text.slice(0, 600));
}

function mapError(message: string): FetchResult {
  const m = message || '';
  if (/ERR_NAME_NOT_RESOLVED/.test(m)) return { outcome: 'dns_gone' };
  if (/ERR_CERT_|ERR_SSL_PINNED|ERR_SSL_VERSION_OR_CIPHER/.test(m)) return { outcome: 'bad_certificate', detail: (m.match(/ERR_[A-Z_]+/) ?? [''])[0] };
  if (/ERR_BLOCKED_BY_CLIENT/.test(m)) return { outcome: 'blocked_address', detail: 'the address is not a public website' };
  if (/Timeout|ERR_CONNECTION_TIMED_OUT|ERR_TIMED_OUT/i.test(m)) return { outcome: 'timeout' };
  return { outcome: 'error', detail: (m.match(/ERR_[A-Z_]+/) ?? [m.split('\n')[0].slice(0, 80)])[0] };
}

/** Starts Chromium. Tries the bundled one, then Edge, then Chrome. */
export async function launchChromium(deps: BrowserDeps = {}) {
  const pw: any = await (deps.loader ?? (() => import('playwright' as string)))();
  const chromium = pw.chromium ?? pw.default?.chromium;
  if (!chromium) throw new Error('Playwright is not installed. In the project folder run: npm.cmd install');
  const failures: string[] = [];
  for (const channel of deps.channels ?? [undefined, 'msedge', 'chrome']) {
    try { return await chromium.launch({ headless: deps.headless ?? true, channel, args: deps.launchArgs ?? [] }); }
    catch (e: any) { failures.push(String(e?.message ?? e).split('\n')[0]); }
  }
  throw new Error('Could not start a browser (' + failures.join(' | ') + '). Run: npx.cmd playwright install chromium');
}

export function createBrowserChecker(deps: BrowserDeps = {}): BrowserChecker {
  let browserP: Promise<any> | null = null;
  const timeoutMs = deps.timeoutMs ?? 20_000;

  const launch = () => launchChromium(deps);
  const getBrowser = () => (browserP ??= launch().then((b: any) => { try { b.on?.('disconnected', () => { browserP = null; }); } catch { /* ignore */ } return b; }).catch(e => { browserP = null; throw e; }));

  async function visit(page: any, url: string): Promise<FetchResult> {
    let u: URL;
    try { u = new URL(url); } catch { return { outcome: 'error', detail: 'not a web address' }; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return { outcome: 'error', detail: 'only http and https are allowed' };
    const h = await checkHost(u.hostname, deps);
    if (h.kind === 'dns_gone') return { outcome: 'dns_gone' };
    if (h.kind === 'dns_error') return { outcome: 'error', detail: 'name lookup failed (try again later)' };
    if (h.kind === 'blocked') return { outcome: 'blocked_address', detail: `the name points to ${h.address}, a private address (your router or DNS filter may be blocking it)` };
    if (!(await robotsAllows_(u, deps))) return { outcome: 'robots_disallowed', detail: 'the site asks automated tools not to read this page' };
    let resp: any;
    try { resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs }); }
    catch (e: any) { return mapError(String(e?.message ?? e)); }
    await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});
    await page.waitForTimeout(400);
    const status: number = resp?.status?.() ?? 0;
    if (status === 404 || status === 410) return { outcome: 'page_missing', status };
    if (status === 401) return { outcome: 'sign_in_required', status };
    if (status === 429 || status === 503) return { outcome: 'busy', status, detail: 'the site is busy or limiting requests; try again later' };
    const title: string = await page.title().catch(() => '');
    const text: string = await page.evaluate(() => document.body?.innerText?.slice(0, 2000) ?? '').catch(() => '');
    const html: string = await renderedHtml(page);
    const hasForm = hasSignupForm(html) || /<input[\s>]/i.test(html);
    if (status === 403 || (!hasForm && looksLikeBotChallenge(title, text))) return { outcome: 'bot_blocked', status: status || undefined };
    if (status >= 400) return { outcome: 'error', status };
    return { outcome: 'ok', status, html, finalUrl: page.url() };
  }

  return {
    async analyze(url) {
      let ctx: any;
      const work = (async (): Promise<FetchResult> => {
        let browser: any;
        try { browser = await getBrowser(); } catch (e: any) { return { outcome: 'error', detail: String(e?.message ?? e) }; }
        ctx = await browser.newContext({ userAgent: UA, acceptDownloads: false, serviceWorkers: 'block', locale: 'en-US', viewport: { width: 1280, height: 900 } });
        const page = await ctx.newPage();
        const okHost = new Map<string, Promise<boolean>>();
        await page.route('**/*', (route: any) => {
          const req = route.request();
          let q: URL;
          try { q = new URL(req.url()); } catch { return route.abort(); }
          if (q.protocol !== 'http:' && q.protocol !== 'https:') return route.abort();
          if (['image', 'media', 'font'].includes(req.resourceType())) return route.abort();
          if (!okHost.has(q.hostname)) okHost.set(q.hostname, checkHost(q.hostname, deps).then(r => r.kind === 'ok'));
          return okHost.get(q.hostname)!.then(ok => (ok ? route.continue() : route.abort('blockedbyclient')));
        });
        const first = await visit(page, url);
        if (first.outcome !== 'ok' || !first.html) return first;
        if (hasSignupForm(first.html)) return first;
        // Many sites open their sign-up form as a pop-up a few seconds after loading: wait, then read the page again.
        await page.waitForTimeout(3500);
        await scrollNudge(page);
        const later: string = await renderedHtml(page);
        if (later && hasSignupForm(later)) return { ...first, html: later };
        // No form on this page: sign-up often lives on another page of the same website. Read up to 5 likely pages (reading only, no clicking).
        const links: { t: string; h: string }[] = await page.evaluate(() =>
          [...document.querySelectorAll('a[href]')].map(a => ({ t: ((a as HTMLElement).innerText || a.getAttribute('aria-label') || a.getAttribute('title') || '').trim(), h: (a as HTMLAnchorElement).href })))
          .catch(() => []);
        const here = (first.finalUrl ?? url).split('#')[0];
        const home = dedupeKey(here);
        const scored = new Map<string, number>();
        for (const l of links) {
          if (!/^https?:/i.test(l.h) || dedupeKey(l.h) !== home) continue;
          const h = l.h.split('#')[0];
          if (h === here || /\.(pdf|jpe?g|png|zip)(\?|$)/i.test(h) || /\/(blog|news|press|careers|jobs|login|log-in|signin|sign-in|cart|search)(\/|$|\?)/i.test(new URL(h).pathname + '/')) continue;
          let score = 0;
          if (SIGNUP_LINK.test(l.t)) score += 3;
          else if (SIGNUP_LOOSE.test(l.t)) score += 2;
          if (SIGNUP_PATH.test(new URL(h).pathname)) score += 2;
          if (score > 0) scored.set(h, Math.max(scored.get(h) ?? 0, score));
        }
        const tries = [...scored.entries()].sort((x, y) => y[1] - x[1]).slice(0, 5).map(x => x[0]);
        for (const next of tries) {
          const second = await visit(page, next);
          if (second.outcome !== 'ok' || !second.html) continue;
          let html2 = second.html;
          if (!hasSignupForm(html2)) { await page.waitForTimeout(2000); await scrollNudge(page); html2 = await renderedHtml(page); }
          if (hasSignupForm(html2)) return { ...second, html: html2, oneLinkAway: new URL(next).pathname || '/' };
        }
        return first;
      })();
      try {
        return await Promise.race([work, new Promise<FetchResult>(r => setTimeout(() => r({ outcome: 'timeout' }), timeoutMs * 2))]);
      } catch (e: any) { return mapError(String(e?.message ?? e)); }
      finally { await ctx?.close().catch(() => {}); }
    },
    async close() { const b = browserP; browserP = null; if (b) await (await b.catch(() => null))?.close().catch(() => {}); },
  };
}
