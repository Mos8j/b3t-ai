/**
 * Fills a sign-up form for one client and STOPS. Nothing is sent until submit() is called after a person approved.
 * Rules this file keeps:
 *  - Only fills text-like boxes and dropdowns it can match to stored client data. It never invents an answer.
 *  - Never ticks a checkbox or radio button (terms, marketing opt-ins): a person decides those.
 *  - Never types sensitive numbers, passwords, or anything on a payment or file-upload form.
 *  - Never solves or bypasses a CAPTCHA or a "verify you are human" screen.
 *  - Says "confirmed" only when the page itself shows a success message; otherwise "sent, not confirmed".
 *  - Reports field NAMES only, never the client's values.
 */
import { analyzeHtml, classify } from '../../discovery/src/analyze';
import { checkHost, robotsAllows_, type FetchDeps } from '../../discovery/src/fetcher';
import { launchChromium, scrollToWake, looksLikeBotChallenge, CAPTCHA_PROBE_JS, renderedHtml, type BrowserDeps } from '../../discovery/src/browser';
import { randomInt } from 'node:crypto';
import { resolveControl, matchOption, formatDate, planCheckbox, generatePassword, makeUsername, type ControlInfo } from './keys';
import type { AiFieldMapper } from './ai-mapper';

export type Profile = Record<string, unknown>;
export type FillStatus = 'ready_for_approval' | 'needs_human' | 'refused' | 'blocked' | 'error';
export interface FillReport {
  status: FillStatus;
  reason: string;
  filled: { label: string; key: string }[];
  /** Fields matched by the optional AI mapper, which only suggests existing profile keys. */
  aiMapped?: string[];
  /** Things a person has to do or decide before this can be sent. */
  needsHuman: string[];
  /** Optional boxes left empty on purpose. */
  skipped: string[];
  /** Boxes the software ticked because the client's recorded permission covers them. */
  ticked: string[];
  /** A login was made up for this site and will be saved just before sending. */
  createsLogin?: boolean;
  /** The page shows a CAPTCHA box next to the form. It is never solved by the software: a person finishes these in a window. */
  captcha?: boolean;
  /** Picture of the filled form, for the approver. Contains client details: keep it private. */
  screenshot?: Buffer;
}
export type SubmitStatus = 'confirmed' | 'confirm_email' | 'sent_unconfirmed' | 'already_member' | 'failed' | 'blocked';
export interface SubmitResult { status: SubmitStatus; detail: string; /** True once an action that could send the form has started. False only when stopped beforehand. */ attempted?: boolean; /** sent_unconfirmed only: the site answered the send with a success code and the form went away or the page changed, so it very probably went through. */ likely?: boolean; /** Text copied from the page, with client details removed. */ evidence?: string }
export interface FillSession { report: FillReport; submit(): Promise<SubmitResult>; close(): Promise<void>;
  /** Hand-finish mode only: leaves the filled form open in a visible window for a person to finish (CAPTCHA, Send). The software sends nothing. */
  handOver?(): Promise<void> }
/** A login the software made up for a site. The caller must store it safely (encrypted, per client). */
export interface NewLogin { site: string; username?: string; password: string }
export interface FillOptions {
  /** What the client has permitted, as recorded on the client: accept_site_terms, marketing_opt_in, create_accounts. Anything else is left to a person. */
  consents?: string[];
  /** Called with a newly made login just BEFORE the form is sent. If it throws, nothing is sent. Without it the software will not create accounts. */
  saveLogin?: (login: NewLogin) => Promise<void>;
  /** Take a picture of the filled form (default true). Off for fully automatic sending, where nobody looks at it. */
  screenshot?: boolean;
  /** A person will finish this form by hand in a visible window: no login is made up (the person types passwords) and nothing is sent by the software. */
  handOver?: boolean;
}
export interface Filler {
  prepare(url: string, profile: Profile, options?: FillOptions): Promise<FillSession>;
  /** Only looks: opens the page, waits for pop-ups, and reports whether a CAPTCHA (or a "prove you are human" screen) is there. Types nothing, sends nothing. */
  scan?(url: string): Promise<{ captcha: boolean; reason: string }>;
  close(): Promise<void>;
}
export interface FillerDeps extends BrowserDeps { sessionMs?: number; /** Wait for late pop-ups (default 4000). Tests set 0. */ popupWaitMs?: number; aiMapper?: AiFieldMapper }

const UA = 'Mozilla/5.0 (compatible; UCAAS-Filler/0.1; fills sign-up forms for clients who authorized it)';
const POPUP_WAIT_MS = 4000;
/** Dismisses an overlay only through an explicit close/dismiss control; never clicks the form or its send button. */
const CLEAR_POPUP_JS = `(function () {
  var f = document.querySelector('[data-ucaas-form], [data-ucaas-overlay-target]'); if (!f) return false;
  var b = document.querySelector('[data-ucaas-submit]') || (f.hasAttribute('data-ucaas-overlay-target') ? f : f.querySelector('button[type=submit], input[type=submit], button, input[type=button]')); if (!b) return false;
  var visible = function(e) { var r=e.getBoundingClientRect(), s=getComputedStyle(e); return r.width>0 && r.height>0 && s.visibility!=='hidden' && s.display!=='none'; };
  var r = b.getBoundingClientRect();
  // Use the visible intersection, as browser clicks do, rather than a point outside a clipped frame.
  var left=Math.max(0,r.left), right=Math.min(innerWidth,r.right), topEdge=Math.max(0,r.top), bottom=Math.min(innerHeight,r.bottom);
  var top = right>left && bottom>topEdge ? document.elementFromPoint((left+right)/2, (topEdge+bottom)/2) : null;
  if (!top || top === b || b.contains(top) || f.contains(top)) return false;
  var box = null;
  for (var n = top; n && n !== document.body; n = n.parentElement) {
    if (n.contains(f)) break;
    var cs = getComputedStyle(n);
    if (cs.position === 'fixed' || n.getAttribute('role') === 'dialog' || n.getAttribute('aria-modal') === 'true') box = n;
  }
  if (!box) return false;
  if (box.querySelector('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"], .g-recaptcha, .h-captcha, .cf-turnstile') || /captcha|verify (that )?you are human|not a robot/i.test(box.innerText || '')) return false;
  var words = /^(x|\\u00d7|\\u2715|close(?: (?:this )?(?:popup|pop-up|dialog|modal|window))?|no,? thanks|not now|dismiss|maybe later)$/i;
  var cands = box.querySelectorAll('button, [role=button], a, [aria-label], [data-dismiss], [data-bs-dismiss], .close, .modal-close, .popup-close');
  for (var i = 0; i < cands.length; i++) {
    var c = cands[i]; if (!visible(c) || c.disabled || c.getAttribute('aria-disabled') === 'true') continue;
    // A close-looking submit button can send a different form. Never activate it.
    if (c.form && (c.type === 'submit' || c.type === 'image')) continue;
    if (c.tagName === 'A' && c.getAttribute('href') && c.getAttribute('href') !== '#') continue;
    var name = (c.getAttribute('aria-label') || c.getAttribute('title') || c.textContent || '').trim();
    var dismiss = c.getAttribute('data-dismiss') || c.getAttribute('data-bs-dismiss');
    if (!words.test(name) && !/^(modal|dialog|popup)$/.test(dismiss || '')) continue;
    var cr=c.getBoundingClientRect(), hit=document.elementFromPoint(cr.left+cr.width/2, cr.top+cr.height/2);
    if (!hit || !(hit===c || c.contains(hit))) continue;
    c.click(); return true;
  }
  return false;
})()`;
/** Any remaining obstruction stops sending before an action is attempted. */
const LATE_POPUP_JS = `(function () {
  var f = document.querySelector('[data-ucaas-form], [data-ucaas-overlay-target]'); if (!f) return false;
  var b = document.querySelector('[data-ucaas-submit]') || (f.hasAttribute('data-ucaas-overlay-target') ? f : f.querySelector('button[type=submit], input[type=submit], button, input[type=button]')); if (!b) return false;
  var r = b.getBoundingClientRect();
  // Use the visible intersection, as browser clicks do, rather than a point outside a clipped frame.
  var left=Math.max(0,r.left), right=Math.min(innerWidth,r.right), topEdge=Math.max(0,r.top), bottom=Math.min(innerHeight,r.bottom);
  var top = right>left && bottom>topEdge ? document.elementFromPoint((left+right)/2, (topEdge+bottom)/2) : null;
  return !!top && top !== b && !b.contains(top) && !f.contains(top);
})()`;
const BOILERPLATE = /(accessibility|screen reader|control-f1|skip to (main )?content|cookie|privacy policy|terms (of|and)|all rights reserved|menu|log ?in|sign ?in|javascript)/i;
/** The few lines of the page most likely to say what happened: skips menus, cookie and accessibility notices. */
function resultLines(text: string): string[] {
  const lines = text.split(/\n+/).map(x => x.trim()).filter(Boolean);
  const useful = lines.filter(l => l.length >= 12 && !BOILERPLATE.test(l));
  return (useful.length ? useful : lines).slice(0, 3);
}
const SUCCESS = /(you(?:'re| are) (now )?(subscribed|signed up|registered|a member|on the list)|you(?:'ve| have) joined|welcome( back)?[,!]|sign-?up (successful|complete)|submission (received|successful)|we(?:'ve| have) received (your|the)|request (has been )?received|congratulations|thank you|thanks for (signing|subscribing|joining|registering)|you(?:'| a)re (all )?set|successfully (subscribed|registered|signed up|joined)|welcome (to|aboard)|you(?:'ve| have) (been )?(subscribed|signed up|joined|registered)|subscription confirmed|registration (is )?complete|you(?:'re| are) in\b)/i;
const CONFIRM_EMAIL = /(almost (done|there)|one more step|pending confirmation|click the (link|button) (in|we)|check your (e-?mail|inbox)|confirm(ation)? (link|e-?mail)|verify your e-?mail|we(?:'ve| have) sent (you )?(an? )?(e-?mail|message|link))/i;
const PROBLEM = /(invalid|please (enter|fill|correct|provide)|something went wrong|try again|there (was|were) (an )?errors?|failed to (submit|send))/i;
/** The site says this person is already on its list: the sign-up exists (maybe from an earlier try), so it needs a person to verify, not a retry. */
const ALREADY = /(already (registered|exists?|subscribed|a member|signed up|on (our|the|this) (list|mailing list)|have an account|in use|enrolled|part of|been (used|registered|subscribed))|(e-?mail|account|address|user)( \w+)? (is |has )?already|you(?:'| a)re already|is already (registered|subscribed|a member|in use|on)|already (taken|used))/i;

function strOf(profile: Profile, key: string): string {
  if (key === 'fullName') return [strOf(profile, 'firstName'), strOf(profile, 'lastName')].filter(Boolean).join(' ');
  const v = profile[key];
  return typeof v === 'string' ? v.trim() : '';
}

/** Removes client details from text taken from a page. */
function scrub(text: string, profile: Profile): string {
  let out = text;
  for (const v of Object.values(profile)) {
    for (const x of Array.isArray(v) ? v : [v]) {
      if (typeof x === 'string' && x.trim().length >= 3) out = out.replace(new RegExp(x.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '[client detail]');
    }
  }
  return out.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]').replace(/\+?\d[\d\s().-]{7,}\d/g, '[number]');
}

/** Runs inside the web page. Kept as plain text so no build tool adds helper code to it. */
const READ_FORM_JS = `(function () {
  var visible = function (e) { var r = e.getClientRects(); var s = getComputedStyle(e); return r.length > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  var skip = ['hidden', 'submit', 'button', 'image', 'reset'];
  var isControl = function (e) { return /^(INPUT|SELECT|TEXTAREA)$/.test(e.tagName); };
  var shown = function (f) { return Array.prototype.filter.call(f.elements, function (e) { return isControl(e) && visible(e) && skip.indexOf(e.type) < 0; }); };
  var hasEmailIn = function (c) { return c.some(function (e) { return e.type === 'email' || /e-?mail/i.test((e.name || '') + (e.id || '') + (e.placeholder || '')); }); };
  var isSearch = function (f) {
    var a = (f.getAttribute('action') || '') + ' ' + (f.getAttribute('role') || '') + ' ' + (f.id || '') + ' ' + (f.className || '');
    var c = shown(f);
    if (/comment/i.test(a) || f.querySelector('textarea[name=comment], textarea#comment, #commentform')) return true;
    return (/search/i.test(a) && !hasEmailIn(c)) || (c.length > 0 && c.every(function (e) { return e.type === 'search' || /^(q|s|search|query|keyword|keywords)$/i.test(e.name || ''); }));
  };
  var hasEmail = function (f) { return shown(f).some(function (e) { return e.type === 'email' || /e-?mail/i.test((e.name || '') + (e.id || '') + (e.placeholder || '')); }); };
  var inPopup = function (f) {
    for (var n = f; n && n !== document.body; n = n.parentElement) {
      var cs = getComputedStyle(n);
      if (n.getAttribute && (n.getAttribute('role') === 'dialog' || n.getAttribute('aria-modal') === 'true')) return true;
      if ((cs.position === 'fixed') && parseInt(cs.zIndex || '0', 10) >= 10 && n.getClientRects().length > 0) return true;
    }
    return false;
  };
  var score = function (f) { return shown(f).length + (hasEmail(f) ? 100 : 0) + (hasEmail(f) && inPopup(f) ? 500 : 0) - (isSearch(f) ? 1000 : 0); };
  var forms = Array.prototype.slice.call(document.forms).sort(function (a, b) { return score(b) - score(a); });
  var form = forms[0];
  var useFallback = false;
  if (!form || isSearch(form) || !hasEmail(form)) {
    // no real <form> with an e-mail box: many pages are just boxes and a button. Use the smallest block around a loose e-mail box that also holds a button.
    var mails = Array.prototype.filter.call(document.querySelectorAll('input'), function (i) {
      return !i.form && visible(i) && skip.indexOf(i.type) < 0 && (i.type === 'email' || /e-?mail/i.test((i.name || '') + (i.id || '') + (i.placeholder || '')));
    });
    var box = null;
    if (mails.length) {
      var n = mails[0];
      for (var k = 0; k < 8 && n.parentElement && n.parentElement !== document.body; k++) {
        n = n.parentElement;
        if (n.querySelector('button, input[type=submit], input[type=button], [role=button]')) { box = n; break; }
      }
    }
    if (box) { form = box; useFallback = true; }
    else if (!form || isSearch(form)) return [];
  }
  document.querySelectorAll('[data-ucaas]').forEach(function (n) { n.removeAttribute('data-ucaas'); });
  document.querySelectorAll('[data-ucaas-form]').forEach(function (n) { n.removeAttribute('data-ucaas-form'); });
  form.setAttribute('data-ucaas-form', '1');
  var out = [];
  var i = 0;
  var controlList = useFallback ? Array.prototype.slice.call(form.querySelectorAll('input, select, textarea')) : Array.prototype.slice.call(form.elements);
  controlList.forEach(function (el) {
    if (!isControl(el) || skip.indexOf(el.type) >= 0 || !visible(el) || el.matches(':disabled') || el.readOnly || el.getAttribute('aria-disabled') === 'true' || el.getAttribute('aria-readonly') === 'true') return;
    el.setAttribute('data-ucaas', String(i));
    var closestLabel = el.closest('label');
    // aria-labelledby points to the actual accessible name, not generic help text.
    var labelledBy = (el.getAttribute('aria-labelledby') || '').trim().split(/\\s+/).filter(Boolean).map(function(id) {
      var target = document.getElementById(id); return target ? (target.textContent || '').trim() : '';
    }).filter(Boolean).join(' ');
    var nativeLabels = el.labels ? Array.prototype.map.call(el.labels, function(label) { return label.textContent || ''; }).join(' ') : '';
    var lab = labelledBy || el.getAttribute('aria-label') || nativeLabels || (closestLabel && closestLabel.textContent) || '';
    // A trailing required marker is decoration, rather than part of the field name.
    if (el.type !== 'checkbox' && el.type !== 'radio') lab = lab.replace(/\\s*\\(required\\)\\s*$/i, '');
    out.push({
      idx: i++, tag: el.tagName.toLowerCase(), type: el.tagName === 'SELECT' ? 'select' : String(el.type || 'text').toLowerCase(),
      name: el.name || '', id: el.id || '', label: lab.replace(/[\\s*:]+$/g, '').replace(/\\s+/g, ' ').trim(), placeholder: el.getAttribute('placeholder') || '',
      autocomplete: el.getAttribute('autocomplete') || '', required: !!el.required || el.getAttribute('aria-required') === 'true',
      options: el.tagName === 'SELECT' ? Array.prototype.map.call(el.options, function (o) { return { value: o.value, text: o.text }; }) : []
    });
  });
  return out;
})()`;

/** Reads link text only. Navigation below is restricted to likely sign-up links on the exact same host. */
const SIGNUP_LINKS_JS = `Array.prototype.slice.call(document.querySelectorAll('a[href]')).map(function (a) {
  return { text: ((a.innerText || a.getAttribute('aria-label') || a.getAttribute('title') || '') + '').trim().slice(0, 160), href: a.href };
}).slice(0, 500)`;
const SIGNUP_LINK_TEXT = /^(sign[\s-]?up|join( now| us| free| today| the club)?|register|subscribe|create (an )?account|get started|become a member|enroll( now)?)\b/i;
const SIGNUP_LINK_HINT = /(sign[\s-]?up|join|register|subscrib|newsletter|rewards?|member(ship)?|loyalty|account|enroll|get started|apply|offers?|updates|email list|insider|club|vip)/i;
const SIGNUP_PATH_HINT = /(sign-?up|join|register|subscribe|newsletter|rewards?|member|loyalty|enroll|insider|vip|offers|email-?list)/i;
const EXCLUDED_PATH = /\/(blog|news|press|careers|jobs|login|log-in|signin|sign-in|cart|search)(\/|$|\?)/i;

function likelySignupTargets(links: { text: string; href: string }[], pageUrl: string): string[] {
  const current = new URL(pageUrl);
  const scores = new Map<string, number>();
  for (const link of links) {
    try {
      const target = new URL(link.href, current);
      if (!['http:', 'https:'].includes(target.protocol) || target.host !== current.host || (current.protocol === 'https:' && target.protocol !== 'https:')) continue;
      if (target.username || target.password || target.pathname === current.pathname && target.search === current.search) continue;
      if (/\.(pdf|jpe?g|png|zip|docx?)(\?|$)/i.test(target.pathname + target.search) || EXCLUDED_PATH.test(target.pathname + '/')) continue;
      let score = 0;
      if (SIGNUP_LINK_TEXT.test(link.text)) score += 3;
      else if (SIGNUP_LINK_HINT.test(link.text)) score += 2;
      if (SIGNUP_PATH_HINT.test(target.pathname)) score += 2;
      if (score) scores.set(target.href, Math.max(scores.get(target.href) ?? 0, score));
    } catch { /* ignore malformed or non-web links */ }
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([href]) => href);
}

export function createFiller(deps: FillerDeps = {}): Filler {
  let browserP: Promise<any> | null = null;
  const getBrowser = () => (browserP ??= launchChromium(deps).then((b: any) => { try { b.on?.('disconnected', () => { browserP = null; }); } catch { /* ignore */ } return b; }).catch(e => { browserP = null; throw e; }));
  const sessionMs = deps.sessionMs ?? 15 * 60_000;
  const fetchDeps: FetchDeps = deps;

  const fail = (status: FillStatus, reason: string, extra: Partial<FillReport> = {}): FillReport => ({ status, reason, filled: [], needsHuman: [], skipped: [], ticked: [], ...extra });
  const dead = (report: FillReport, close: () => Promise<void> = async () => {}): FillSession => ({
    report, close,
    async submit() { return { status: 'failed', detail: 'Nothing was sent: ' + report.reason }; },
  });

  return {
    async scan(url) {
      let u: URL;
      try { u = new URL(url); } catch { return { captcha: false, reason: 'not a web address' }; }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return { captcha: false, reason: 'not a web address' };
      const host = await checkHost(u.hostname, fetchDeps);
      if (host.kind !== 'ok') return { captcha: false, reason: 'could not be reached' };
      if (!(await robotsAllows_(u, fetchDeps))) return { captcha: false, reason: 'the site asks automated tools not to use this page' };
      let browser: any;
      try { browser = await getBrowser(); } catch (e: any) { return { captcha: false, reason: String(e?.message ?? e) }; }
      const ctx = await browser.newContext({ userAgent: UA, acceptDownloads: false, serviceWorkers: 'block', locale: 'en-US', viewport: { width: 1280, height: 1000 } });
      try {
        const page = await ctx.newPage();
        const okHost = new Map<string, Promise<boolean>>();
        await page.route('**/*', (route: any) => {
          let q: URL;
          try { q = new URL(route.request().url()); } catch { return route.abort(); }
          if (q.protocol !== 'http:' && q.protocol !== 'https:') return route.abort();
          if (route.request().resourceType() === 'media') return route.abort();
          if (!okHost.has(q.hostname)) okHost.set(q.hostname, checkHost(q.hostname, fetchDeps).then(r => r.kind === 'ok'));
          return okHost.get(q.hostname)!.then(ok => (ok ? route.continue() : route.abort('blockedbyclient')));
        });
        let resp: any;
        try { resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 }); } catch { return { captcha: false, reason: 'the page did not load' }; }
        await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});
        const popupWait = deps.popupWaitMs ?? POPUP_WAIT_MS;
        if (popupWait > 0) { await page.waitForTimeout(popupWait); await scrollToWake(page); await page.waitForTimeout(1000); }
        const status: number = resp?.status?.() ?? 0;
        const title: string = await page.title().catch(() => '');
        const bodyText: string = await page.evaluate(() => document.body?.innerText?.slice(0, 2000) ?? '').catch(() => '');
        if (looksLikeBotChallenge(title, bodyText) || status === 403 || status === 429) return { captcha: true, reason: 'the site asks visitors to prove they are human' };
        const has = (await page.evaluate(CAPTCHA_PROBE_JS).catch(() => 'none')) === 'visible';
        return has ? { captcha: true, reason: 'a CAPTCHA box is on the page' } : { captcha: false, reason: 'no CAPTCHA seen' };
      } catch (e: any) { return { captcha: false, reason: 'something went wrong: ' + String(e?.message ?? e).split('\n')[0].slice(0, 100) }; }
      finally { await ctx.close().catch(() => {}); }
    },
    async prepare(url, profile, options = {}) {
      const consents = new Set(options.consents ?? []);
      const rand = (n: number) => randomInt(n);
      let login: NewLogin | null = null;
      let u: URL;
      try { u = new URL(url); } catch { return dead(fail('error', 'that is not a web address')); }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return dead(fail('error', 'only http and https addresses are allowed'));
      const host = await checkHost(u.hostname, fetchDeps);
      if (host.kind === 'blocked') return dead(fail('refused', 'the address points to a private network'));
      if (host.kind !== 'ok') return dead(fail('error', 'the website could not be reached'));
      if (!(await robotsAllows_(u, fetchDeps))) return dead(fail('refused', 'the site asks automated tools not to use this page'));

      let browser: any;
      try { browser = await getBrowser(); } catch (e: any) { return dead(fail('error', String(e?.message ?? e))); }
      const ctx = await browser.newContext({ userAgent: UA, acceptDownloads: false, serviceWorkers: 'block', locale: 'en-US', viewport: { width: 1280, height: 1000 } });
      const close = async () => { clearTimeout(timer); await ctx.close().catch(() => {}); };
      const timer = setTimeout(() => { void close(); }, sessionMs); timer.unref?.();
      try {
        const page = await ctx.newPage();
        const okHost = new Map<string, Promise<boolean>>();
        await page.route('**/*', (route: any) => {
          let q: URL;
          try { q = new URL(route.request().url()); } catch { return route.abort(); }
          if (q.protocol !== 'http:' && q.protocol !== 'https:') return route.abort();
          if (route.request().resourceType() === 'media') return route.abort();
          if (!okHost.has(q.hostname)) okHost.set(q.hostname, checkHost(q.hostname, fetchDeps).then(r => r.kind === 'ok'));
          return okHost.get(q.hostname)!.then(ok => (ok ? route.continue() : route.abort('blockedbyclient')));
        });
        let resp: any;
        try { resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 }); }
        catch { await close(); return dead(fail('error', 'the page did not load')); }
        await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});
        const popupWait = deps.popupWaitMs ?? POPUP_WAIT_MS;
        if (popupWait > 0) {
          await page.waitForTimeout(popupWait);
          await scrollToWake(page); // some pop-ups only appear after scrolling
          await page.waitForTimeout(1200);
        }
        // some pop-ups only appear after the page is scrolled: scroll down and back up (only scrolling, nothing clicked)
        for (const f of [0.35, 0.7, 1]) { await page.evaluate('window.scrollTo(0, Math.floor((document.documentElement.scrollHeight || 0) * ' + f + '))').catch(() => {}); await page.waitForTimeout(600); }
        await page.evaluate('window.scrollTo(0, 0)').catch(() => {});
        await page.waitForTimeout(1000); // many sites show their sign-up pop-up a few seconds after loading
        const status: number = resp?.status?.() ?? 0;
        const title: string = await page.title().catch(() => '');
        const bodyText: string = await page.evaluate(() => document.body?.innerText?.slice(0, 2000) ?? '').catch(() => '');
        if (status === 403 || status === 429 || looksLikeBotChallenge(title, bodyText)) { await close(); return dead(fail('blocked', 'the site blocks automated visits (never bypassed); staff must do this one by hand')); }
        if (status >= 400) { await close(); return dead(fail('error', `the site answered ${status}`)); }

        // Stop before touching anything if the page is one we must not automate.
        let cl = classify(analyzeHtml(await renderedHtml(page)));
        if (cl.handling === 'excluded') { await close(); return dead(fail('refused', cl.reason)); }
        if (cl.handling === 'staff' && !(options.handOver && /captcha/i.test(cl.reason))) { await close(); return dead(fail('needs_human', cl.reason + '; staff do this one by hand')); }

        // Read the page first. If it is a landing page, follow only clearly labeled same-host sign-up links, using GET.
        let formScope: any = page;
        // Frames have their own document. Inspect only visible same-origin frames.
        const readControls = async (): Promise<ControlInfo[]> => {
          formScope = page;
          const main: ControlInfo[] = await page.evaluate(READ_FORM_JS);
          if (main.length) return main;
          const frames = typeof page.frames === 'function' ? page.frames().slice(1, 13) : [];
          for (const frame of frames) {
            try {
              const frameUrl = new URL(frame.url());
              if (frameUrl.origin !== new URL(page.url()).origin || !/^https?:$/.test(frameUrl.protocol)) continue;
              const owner = await frame.frameElement();
              const visible = await owner.isVisible();
              await owner.dispose();
              if (!visible || !(await robotsAllows_(frameUrl, fetchDeps))) continue;
              const text: string = await frame.evaluate(() => document.body?.innerText?.slice(0, 2000) ?? '');
              if (looksLikeBotChallenge(await frame.title(), text)) continue;
              const classification = classify(analyzeHtml(await frame.content()));
              if (classification.handling === 'excluded' || (classification.handling === 'staff' && !(options.handOver && /captcha/i.test(classification.reason)))) continue;
              const found: ControlInfo[] = await frame.evaluate(READ_FORM_JS);
              if (!found.length || new URL(frame.url()).origin !== new URL(page.url()).origin) continue;
              formScope = frame;
              return found;
            } catch { /* Detached or inaccessible frame: try the next one. */ }
          }
          return [];
        };
        let controls: ControlInfo[] = await readControls();
        let followedSignupLink = false;
        if (!controls.length) {
          const links: { text: string; href: string }[] = await page.evaluate(SIGNUP_LINKS_JS).catch(() => []);
          const targets = likelySignupTargets(links, page.url());
          for (const targetUrl of targets) {
            const target = new URL(targetUrl);
            const targetHost = await checkHost(target.hostname, fetchDeps);
            if (targetHost.kind !== 'ok' || !(await robotsAllows_(target, fetchDeps))) continue;
            let targetResponse: any;
            try { targetResponse = await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 }); }
            catch { continue; }
            // Redirects may leave the approved host. Do not inspect or fill the redirected page.
            let landed: URL;
            try { landed = new URL(page.url()); } catch { continue; }
            if (landed.host !== u.host || (u.protocol === 'https:' && landed.protocol !== 'https:')) continue;
            await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});
            const targetStatus: number = targetResponse?.status?.() ?? 0;
            const targetTitle: string = await page.title().catch(() => '');
            const targetText: string = await page.evaluate(() => document.body?.innerText?.slice(0, 2000) ?? '').catch(() => '');
            if (targetStatus === 403 || targetStatus === 429 || looksLikeBotChallenge(targetTitle, targetText)) {
              await close(); return dead(fail('blocked', 'the sign-up page blocks automated visits or asks visitors to prove they are human; staff must do this one by hand'));
            }
            if (targetStatus >= 400) continue;
            cl = classify(analyzeHtml(await renderedHtml(page)));
            if (cl.handling === 'excluded') { await close(); return dead(fail('refused', cl.reason)); }
            if (cl.handling === 'staff' && !(options.handOver && /captcha/i.test(cl.reason))) {
              await close(); return dead(fail('needs_human', cl.reason + '; staff do this one by hand'));
            }
            controls = await readControls();
            if (controls.length) { followedSignupLink = true; break; }
          }
        }
        if (!controls.length) {
          await close();
          return dead(fail('needs_human', 'no fillable sign-up fields were found on this page, its visible same-origin embedded pages, or its likely same-site sign-up links. Forms embedded from another provider need manual handling. Open the sign-up page directly or handle this site by hand.'));
        }

        const report: FillReport = { status: 'ready_for_approval', reason: '', filled: [], needsHuman: [], skipped: [], ticked: [] };
        const aiMappings = new Map<number, string>();
        if (deps.aiMapper) {
          const unresolved = controls.filter(c => c.type !== 'checkbox' && c.type !== 'radio' && c.type !== 'password' && resolveControl(c).kind === 'unknown');
          const keys = ['firstName', 'lastName', 'fullName', 'email', 'phone', 'addressLine1', 'addressLine2', 'city', 'state', 'postalCode', 'country', 'dateOfBirth']
            .filter(k => !!strOf(profile, k));
          try {
            for (const suggestion of await deps.aiMapper.suggest(unresolved, keys)) aiMappings.set(suggestion.idx, suggestion.key);
          } catch { /* optional AI mapping must never interrupt ordinary rule-based filling */ }
        }
        report.aiMapped = [];
        const canMakeAccount = consents.has('create_accounts') && !!options.saveLogin && !options.handOver;
        const seenGroups = new Set<string>();
        for (const c of controls) {
          const name = c.label || c.placeholder || c.name || c.id || `field ${c.idx + 1}`;
          if (formScope !== page && new URL(formScope.url()).origin !== new URL(page.url()).origin) throw new Error('The embedded form moved to another provider; prepare it again.');
          const loc = formScope.locator(`[data-ucaas="${c.idx}"]`);
          if (c.type === 'file') { await close(); return dead(fail('refused', 'the form asks for a file upload')); }
          if (c.type === 'radio') {
            const g = 'radio:' + (c.name || c.id || c.idx);
            if (seenGroups.has(g)) continue; seenGroups.add(g);
            if (c.required) report.needsHuman.push(`${name} (a person must choose)`); else report.skipped.push(`${name} (left unchosen)`);
            continue;
          }
          if (c.type === 'checkbox') {
            const checkboxText = [c.label, c.name, c.id, c.placeholder].filter(Boolean).join(' ');
            const plan = planCheckbox(checkboxText || name, c.required, typeof profile.dateOfBirth === 'string' ? profile.dateOfBirth : undefined);
            if (plan.action === 'leave') { report.skipped.push(`${name} (left unticked)`); continue; }
            if (plan.action === 'human') { report.needsHuman.push(`${name} (${plan.why})`); continue; }
            if (!consents.has(plan.consent)) { if (c.required) report.needsHuman.push(`${name} (the client's permission "${plan.consent}" is not recorded)`); else report.skipped.push(`${name} (left unticked: no recorded permission)`); continue; }
            await loc.check({ timeout: 5000 }).then(() => report.ticked.push(name)).catch(() => { report.needsHuman.push(`${name} (could not tick)`); });
            continue;
          }
          let r = resolveControl(c);
          const aiKey = r.kind === 'unknown' ? aiMappings.get(c.idx) : undefined;
          if (aiKey) r = { kind: 'key', key: aiKey };
          if (r.kind === 'sensitive') { report.needsHuman.push(`${name} (a person types this directly into the site)`); continue; }
          if (r.kind === 'password') {
            if (!canMakeAccount) { report.needsHuman.push(`${name} (creates an account, and the client's permission "create_accounts" or a safe place to keep the login is missing)`); continue; }
            login ??= { site: u.hostname, password: generatePassword(rand) };
            await loc.fill(login.password, { timeout: 5000 }).then(() => report.filled.push({ label: name, key: r.confirm ? 'passwordConfirm' : 'password' })).catch(() => { report.needsHuman.push(`${name} (could not type here)`); });
            continue;
          }
          if (r.kind === 'unknown') { if (c.required) report.needsHuman.push(`${name} (not recognized)`); else report.skipped.push(name); continue; }
          let value = r.key === 'username' ? (canMakeAccount ? (login ??= { site: u.hostname, password: generatePassword(rand) }).username ??= makeUsername(strOf(profile, 'firstName'), strOf(profile, 'lastName'), rand) : '') : strOf(profile, r.key);
          if (!value) { if (c.required) report.needsHuman.push(`${name} (no information on file)`); else report.skipped.push(name); continue; }
          if (r.key === 'dateOfBirth') value = formatDate(value, c);
          if (c.type === 'select') {
            const opt = matchOption(c.options, value, r.key);
            if (opt === null) { if (c.required) report.needsHuman.push(`${name} (no matching choice in the list)`); else report.skipped.push(name); continue; }
            await loc.selectOption(opt).catch(() => { report.needsHuman.push(`${name} (could not pick a choice)`); });
          } else {
            await loc.fill(value, { timeout: 5000 }).catch(() => { report.needsHuman.push(`${name} (could not type here)`); });
          }
          if (!report.needsHuman.some(x => x.startsWith(name + ' ('))) {
            report.filled.push({ label: name, key: r.key });
            if (aiKey) report.aiMapped!.push(name);
          }
        }
        if (report.needsHuman.length) { report.status = 'needs_human'; report.reason = 'A person has to handle the items listed before this can be sent.'; }
        else if (!report.filled.length) { report.status = 'needs_human'; report.reason = 'Nothing on this page could be filled from the stored information. The sign-up form may be on another page, inside a pop-up or embedded frame, or this page may only have a search box or a blog comment form. A person should do this site by hand.'; }
        else report.reason = (followedSignupLink ? 'Opened a same-site sign-up link. ' : '') + 'Filled and waiting for approval. Nothing has been sent.';
        report.createsLogin = !!login;
        report.captcha = (await page.evaluate(CAPTCHA_PROBE_JS).catch(() => 'none')) === 'visible' || (formScope !== page && (await formScope.evaluate(CAPTCHA_PROBE_JS).catch(() => 'none')) === 'visible');
        report.screenshot = options.screenshot === false ? undefined : await page.screenshot({ fullPage: true, type: 'png' }).catch(() => undefined);

        return {
          report, close,
          async handOver() {
            clearTimeout(timer);
            const keep = setTimeout(() => { void ctx.close().catch(() => {}); }, 30 * 60_000); keep.unref?.();
            await page.bringToFront().catch(() => {});
          },
          async submit() {
            let attempted = false;
            const posts: number[] = [];   // how the site answered any POST while sending: evidence for "very probably went through"
            const onResp = (r: any) => { try { if (r.request().method() === 'POST') posts.push(r.status()); } catch { /* ignore */ } };
            page.on('response', onResp);
            try { const result = await (async (): Promise<SubmitResult> => {
            if (report.status !== 'ready_for_approval') return { status: 'failed', detail: 'Nothing was sent: ' + report.reason };
            if (formScope !== page && new URL(formScope.url()).origin !== new URL(page.url()).origin) return { status: 'failed', detail: 'Nothing was sent: the embedded form moved to another provider. Open a new preview.' };
            const SEND_WORDS = /(sign ?up|subscribe|join|register|submit|send|continue|get started|create|apply|enter|go)/i;
            const all = formScope.locator('[data-ucaas-form] :is(button, input[type=submit], input[type=button], input[type=image], [role=button], a[class*=btn i], a[class*=submit i], a[class*=arrow i], span[class*=arrow i], span[class*=submit i], div[class*=submit i], i[class*=arrow i])');
            const n = await all.count().catch(() => 0);
            // Hidden submit inputs can sit inside the real button (for example ckbk).
            // Select a visible control before measuring obstruction or attempting a click.
            let button = formScope.locator('[data-ucaas-form] :is(button[type=submit], input[type=submit], input[type=image]):visible').first();
            if (!(await button.count())) {
              // arrows and magnifying glasses have no words: also look at the button's accessible name, title and class/id, which usually say "submit", "arrow", "go"
              const ICON_WORDS = /(submit|subscribe|sign-?up|arrow|chevron|caret|next|go\b|send|join|search|magnif|btn-?go|icon-?right)/i;
              const NOT_SEND = /(close|cancel|dismiss|clear|reset|back|menu|toggle|nav|cookie|accept|decline|play|pause|share|login|log in)/i;
              const seen: any[] = [];
              for (let i = 0; i < n; i++) {
                const cand = all.nth(i);
                if (!(await cand.isVisible().catch(() => false))) continue;
                const text = ((await cand.innerText().catch(() => '')) || (await cand.getAttribute('value').catch(() => '')) || '').trim();
                const hints = [await cand.getAttribute('aria-label').catch(() => ''), await cand.getAttribute('title').catch(() => ''), await cand.getAttribute('alt').catch(() => ''), await cand.getAttribute('class').catch(() => ''), await cand.getAttribute('id').catch(() => ''), await cand.getAttribute('name').catch(() => '')].join(' ');
                const label = text + ' ' + hints;
                if (NOT_SEND.test(label) && !SEND_WORDS.test(text)) continue;
                seen.push(cand);
                if (SEND_WORDS.test(text) || (!text && ICON_WORDS.test(hints))) { button = cand; break; }
              }
              // still nothing, but the form has exactly one visible button: that is its send button (an arrow or magnifying glass with no name)
              if (!(await button.count()) && seen.length === 1) button = seen[0];
            }
            const hasButton = (await button.count()) > 0; // without a recognisable button the form is sent the normal browser way (as pressing Enter would)
            const action: string = (await formScope.getAttribute('[data-ucaas-form]', 'action').catch(() => null)) ?? '';
            const urlBefore = formScope.url();
            let clicked = hasButton;
            if (hasButton) await button.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
            if (hasButton && typeof button.evaluate === 'function') await button.evaluate((el: Element) => el.setAttribute('data-ucaas-submit', '1'));
            const overlayScopes = [formScope];
            if (formScope !== page) {
              // Check ancestors too: a parent-page popup can cover an embedded form.
              let child = formScope;
              while (child.parentFrame()) {
                const owner = await child.frameElement();
                await owner.evaluate((el: Element) => el.setAttribute('data-ucaas-overlay-target', '1'));
                await owner.dispose();
                child = child.parentFrame();
                overlayScopes.unshift(child);
              }
            }
            for (const scope of overlayScopes) {
              const before = scope.url();
              for (let pass = 0; pass < 3; pass++) {
                const dismissed = await scope.evaluate(CLEAR_POPUP_JS).catch(() => false);
                if (!dismissed) break;
                await page.waitForTimeout(400);
                if (scope.url() !== before || formScope.url() !== urlBefore) return { status: 'failed', detail: 'Nothing was sent: closing the overlay changed the page. Prepare and review the current page again before sending.' };
              }
              const obstructed = await scope.evaluate(LATE_POPUP_JS).catch(() => null);
              if (obstructed === null) return { status: 'failed', detail: 'Nothing was sent: the page changed before the submit button could be checked. Open a new preview or use the visible hand-fill option.' };
              if (obstructed) {
                const diagnostic: string = await scope.evaluate(() => {
                  const f = document.querySelector('[data-ucaas-form], [data-ucaas-overlay-target]');
                  const b = document.querySelector('[data-ucaas-submit]') || (f?.hasAttribute('data-ucaas-overlay-target') ? f : f?.querySelector('button[type=submit], input[type=submit], button, input[type=button]'));
                  if (!b) return 'The selected submit control is no longer on the page.';
                  const r = b.getBoundingClientRect();
                  const x = (Math.max(0, r.left) + Math.min(innerWidth, r.right)) / 2;
                  const y = (Math.max(0, r.top) + Math.min(innerHeight, r.bottom)) / 2;
                  const hit = document.elementFromPoint(x, y);
                  // Structural information only: no client field values or surrounding page text.
                  return 'Submit control: ' + b.tagName.toLowerCase() + '. Covering element: ' + (hit?.tagName.toLowerCase() || 'outside the visible page') + (hit?.getAttribute('role') === 'dialog' ? ' (dialog)' : '') + '.';
                }).catch(() => 'The page changed while inspecting the obstruction.');
                return { status: 'failed', evidence: diagnostic, detail: 'Nothing was sent: a popup or overlay still covers the submit button and has no safe close control. Use the visible hand-fill option to review it.' };
              }
            }
            if (login) {
              try { await options.saveLogin!(login); }
              catch { return { status: 'failed', detail: 'Nothing was sent: the new login could not be saved safely.' }; }
            }
            if (hasButton) {
              attempted = true;
              try { await button.click({ timeout: 5000 }); }
              catch { return { status: 'sent_unconfirmed', detail: 'The send action did not finish reliably. It may have reached the site; check the result before trying again.' }; }
            }
            if (!clicked) {
              // Without a button, use the form's normal submit path only when available.
              const canRequestSubmit = await formScope.evaluate("(function(){var f=document.querySelector('[data-ucaas-form]');return !!f&&typeof f.requestSubmit==='function';})()").catch(() => false);
              if (canRequestSubmit) {
                attempted = true;
                clicked = await formScope.evaluate("(function(){var f=document.querySelector('[data-ucaas-form]');try{f.requestSubmit();return true;}catch(e){return false;}})()").then(Boolean).catch((e: any) => /context was destroyed|navigat/i.test(String(e?.message ?? e)));
                if (!clicked) return { status: 'sent_unconfirmed', detail: 'The form submit action did not finish reliably. Verify the site before sending again.' };
              }
            }
            if (!clicked) {   // no <form> and no button we could press: pressing Enter in the e-mail box is what a person would do
              const mail = formScope.locator('[data-ucaas-form] input[type=email], [data-ucaas-form] input[name*=mail i], [data-ucaas-form] input[id*=mail i]').first();
              if (await mail.count().catch(() => 0)) { attempted = true; clicked = await mail.press('Enter', { timeout: 3000 }).then(() => true).catch(() => false); }
            }
            if (!clicked && formScope.url() !== urlBefore) clicked = true; // the page moved on, so something was sent
            if (!clicked) return { status: attempted ? 'sent_unconfirmed' : 'failed', detail: attempted ? 'The send action did not finish reliably. Verify the site before sending again.' : 'Nothing was sent: the form has no send button we could press, and the page would not send it either.' };
            await formScope.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
            await page.waitForTimeout(600);
            const text: string = await formScope.evaluate(() => document.body?.innerText?.slice(0, 6000) ?? '').catch(() => '');
            const ttl: string = await formScope.title().catch(() => '');
            const formStillThere = (await formScope.locator('[data-ucaas-form]').count().catch(() => 0)) > 0
              || (action !== '' && await formScope.evaluate((a: string) => !!document.querySelector('form[action="' + a + '"]'), action).catch(() => false));
            const snippet = (re: RegExp) => { const m = text.split(/\n+/).map(x => x.trim()).find(x => re.test(x)); return m ? scrub(m, profile).slice(0, 200) : undefined; };
            if (looksLikeBotChallenge(ttl, text)) return { status: 'blocked', detail: 'The site asked us to prove we are human. That is never bypassed; staff must finish this by hand.' };
            const invalid = await formScope.evaluate(() => document.querySelectorAll(':invalid').length).catch(() => 0);
            const postedOk = posts.some(c => c >= 200 && c < 400);
            const pathNow = (() => { try { return new URL(formScope.url()).pathname; } catch { return ''; } })();
            const movedToThanks = formScope.url() !== urlBefore && /thank|success|confirm|welcome|subscribed|complete|registered|joined|congrat|done/i.test(pathNow);
            // Many sites send the form in the background and then CLEAR it. A cleared form usually means it was accepted, so it is never reported as rejected.
            const kept: number = await formScope.evaluate(`(function () {
              var f = document.querySelector('[data-ucaas-form]') || (${JSON.stringify(action)} ? document.querySelector('form[action="' + ${JSON.stringify(action)} + '"]') : null);
              if (!f) return 0;
              return Array.prototype.filter.call(f.querySelectorAll('input, textarea'), function (e) { return /^(text|email|tel|search|url|)$/.test(e.type || '') && e.value && e.getClientRects().length > 0; }).length;
            })()`).catch(() => 1);
            const cleared = formStillThere && kept === 0;
            if (ALREADY.test(text.slice(0, 3000)) && !SUCCESS.test(text) && !CONFIRM_EMAIL.test(text)) return { status: 'already_member', detail: 'The site says this person is already registered or subscribed (possibly from an earlier try). Verify it by hand.', evidence: snippet(ALREADY) };
            if (movedToThanks && !formStillThere && !PROBLEM.test(text.slice(0, 1500))) return { status: 'confirmed', detail: 'The page moved to a thank-you style address.', evidence: 'Page address now ends with ' + pathNow.slice(0, 80) };
            if (formStillThere && ((!cleared && invalid > 0) || (PROBLEM.test(text.slice(0, 3000)) && !SUCCESS.test(text)))) return { status: 'failed', detail: 'The site did not accept the form.', evidence: snippet(PROBLEM) };
            if (CONFIRM_EMAIL.test(text)) return { status: 'confirm_email', detail: 'Sent, but the site wants the client to confirm by email. Not counted as done until that is clicked.', evidence: snippet(CONFIRM_EMAIL) };
            if (SUCCESS.test(text) && !formStillThere) return { status: 'confirmed', detail: 'The site showed a success message.', evidence: snippet(SUCCESS) };
            if (cleared) return { status: 'sent_unconfirmed', likely: postedOk, detail: 'The form emptied itself after sending, which usually means the site accepted it, but it did not say so clearly. Check by hand.', evidence: scrub(resultLines(text).join(' / '), profile).slice(0, 240) };
            if (formStillThere && formScope.url() === urlBefore) return { status: 'sent_unconfirmed', detail: 'The send button was pressed, but the form is still showing and the page did not change. The site probably did NOT accept it. Check by hand; if it did not work, use "Did not work, try again".', evidence: scrub(resultLines(text).join(' / '), profile).slice(0, 240) };
            return { status: 'sent_unconfirmed', likely: postedOk, detail: 'The form was sent, but the page did not show a clear success message. Check it by hand before counting it as done.', evidence: scrub(resultLines(text).join(' / '), profile).slice(0, 240) };
            })(); return { ...result, attempted }; }
            catch { return { status: attempted ? 'sent_unconfirmed' : 'failed', attempted, detail: attempted ? 'The attempt stopped before a reliable result could be read. Check the site before trying again.' : 'Nothing was sent: the form could not be submitted.' }; }
            finally { page.off('response', onResp); }
          },
        };
      } catch (e: any) {
        await close();
        return dead(fail('error', 'something went wrong: ' + String(e?.message ?? e).split('\n')[0].slice(0, 150)));
      }
    },
    async close() { const b = browserP; browserP = null; if (b) await (await b.catch(() => null))?.close().catch(() => {}); },
  };
}
