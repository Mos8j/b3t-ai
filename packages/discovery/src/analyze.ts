import { isSensitiveField } from '../../core/src/mapping';

/**
 * Static page check: reads the HTML a site sends and describes its sign-up form.
 * It does NOT run the page's JavaScript, so pages that build their form in the browser come back "unknown".
 * Anything that looks like a CAPTCHA, a payment, a login wall, a file upload or a sensitive number is classified
 * "staff": those are handled by a person. This code never tries to get past them.
 * Payments and file uploads are "excluded": the directory does not keep those sites at all.
 */
export interface FieldInfo { name: string; type: string; label: string; canon: string }
export interface FormSummary { action: string; method: string; fields: FieldInfo[] }
export interface PageAnalysis {
  forms: FormSummary[];
  /** A visible challenge (widget, image, or answer box). Staff finish these. */
  captcha: boolean;
  /** Invisible, score-based protection (for example reCAPTCHA v3). No challenge is shown unless the site decides to. */
  invisibleCaptcha: boolean;
  payment: boolean;
  fileUpload: boolean;
  sensitiveFields: string[];
  loginOnly: boolean;
  platforms: string[];
  scriptOnlyPage: boolean;
}
/** excluded = not wanted in the directory at all (payment or file upload). */
export type Handling = 'simple' | 'staff' | 'unknown' | 'excluded';
export interface Classification { handling: Handling; reason: string }

const ATTR = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const inner = tag.replace(/^<\s*[a-zA-Z0-9]+/, '').replace(/\/?>$/, '');
  for (const m of inner.matchAll(ATTR)) out[m[1].toLowerCase()] = m[3] ?? m[4] ?? m[5] ?? '';
  return out;
}
const text = (s: string) => s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

const CANON: [string, RegExp][] = [
  ['firstname', /first[\s_-]?name|fname|given|forename/i],
  ['lastname', /last[\s_-]?name|lname|surname|family[\s_-]?name/i],
  ['email', /e[\s_-]?mail/i],
  ['phone', /phone|mobile|tel(?!l)|cell/i],
  ['zip', /zip|postal|postcode/i],
  ['city', /\bcity\b|town/i],
  ['state', /state|province|region/i],
  ['country', /country/i],
  ['address', /address|street/i],
  ['dob', /birth|\bdob\b|\bage\b/i],
  ['consent', /consent|agree|terms|opt[\s_-]?in|subscribe|newsletter|privacy/i],
  ['password', /pass(word)?/i],
  ['name', /^(full[\s_-]?)?name$|your[\s_-]?name/i],
];
export function canonField(nameOrLabel: string): string {
  const s = nameOrLabel.trim();
  for (const [k, re] of CANON) if (re.test(s)) return k;
  return 'other';
}

const PLATFORMS: [string, RegExp][] = [
  ['mailchimp', /list-manage\.com|mc-embedded-subscribe|mailchimp/i],
  ['hubspot', /hsforms|hs-form|hubspot/i],
  ['klaviyo', /klaviyo/i],
  ['shopify', /cdn\.shopify\.com|shopify\.theme/i],
  ['wordpress', /wp-content|wp-includes/i],
  ['wix', /wixstatic|wix\.com/i],
  ['squarespace', /squarespace/i],
  ['typeform', /typeform/i],
  ['jotform', /jotform/i],
  ['constantcontact', /ctctcdn|constantcontact/i],
  ['gravityforms', /gform_|gravityforms/i],
  ['salesforce', /webtolead|salesforce|pardot/i],
];
// A challenge the visitor would see, judged from the page's markup only (script text is ignored, because many sites load
// CAPTCHA code for a different form, a hidden pop-up, or a login box): a widget element, an iframe, an image or an answer box.
const CAPTCHA_VISIBLE = /class=["'][^"']*(g-recaptcha|h-captcha|cf-turnstile|geetest|captcha-?(widget|image|box))[^"']*["']|<iframe[^>]+src=["'][^"']*(recaptcha\/api2\/anchor|hcaptcha\.com\/captcha|challenges\.cloudflare\.com\/cdn-cgi\/challenge-platform)|<img[^>]+captcha|<input(?![^>]+type=["']?hidden)[^>]+(name|id)=["'][^"']*captcha|arkoselabs|funcaptcha/i;
// Script-only evidence (an explicit render call): a CAPTCHA may or may not be shown, so a real browser has to decide.
const CAPTCHA_SCRIPT_ONLY = /grecaptcha\.render\s*\(|hcaptcha\.render\s*\(|turnstile\.render\s*\(/i;
// Score-based protection that loads without showing anything: a script with ?render=KEY, an "invisible" widget, or execute().
const CAPTCHA_INVISIBLE = /size=invisible|checkbox-invisible|grecaptcha-badge|recaptcha\/(api|enterprise)\.js\?[^"']*render=(?!explicit)[^"'&]+|data-size=["']invisible["']|grecaptcha(\.enterprise)?\.execute\s*\(/i;
const PAYMENT_FIELD = /card[\s_-]?num|cc[\s_-]?num|cc-number|cardnumber|\bcvv\b|\bcvc2?\b|security[\s_-]?code|credit[\s_-]?card/i;
const PAYMENT_SCRIPT = /js\.stripe\.com|braintreegateway|paypal\.com\/sdk|checkout\.square|squareup\.com\/payments/i;

export function analyzeHtml(html: string): PageAnalysis {
  const body = html.slice(0, 1_500_000);
  const labelFor = new Map<string, string>();
  for (const m of body.matchAll(/<label\b([^>]*)>([\s\S]*?)<\/label>/gi)) {
    const f = attrs('<label ' + m[1] + '>').for;
    if (f) labelFor.set(f, text(m[2]));
  }
  const markup = body.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<!--(?!\s*UCAAS-DOM)[\s\S]*?-->/g, ' ').replace(/<[^>]*(data-size=["']invisible["']|size=invisible|checkbox-invisible)[^>]*>/gi, ' ');
  const forms: FormSummary[] = [];
    const rejected: string[] = [];
  for (const fm of markup.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
    const fa = attrs('<form ' + fm[1] + '>');
    const fields: FieldInfo[] = [];
    for (const im of fm[2].matchAll(/<(input|select|textarea)\b([^>]*)>/gi)) {
      const a = attrs('<' + im[1] + ' ' + im[2] + '>');
      const type = im[1].toLowerCase() === 'input' ? (a.type || 'text').toLowerCase() : im[1].toLowerCase();
      if (['hidden', 'submit', 'button', 'image', 'reset'].includes(type)) continue;
      const label = (a.id && labelFor.get(a.id)) || a['aria-label'] || a.placeholder || '';
      const name = a.name || a.id || '';
      const c = canonField(`${name} ${label}`.trim());
      fields.push({ name, type, label, canon: c === 'other' && type === 'email' ? 'email' : c });
    }
    // A site search box or a blog comment form is not a sign-up form.
    const searchy = /search/i.test((fa.action ?? '') + ' ' + (fa.role ?? '') + ' ' + (fa.id ?? '') + ' ' + (fa.class ?? ''))
      || fields.every(f => f.type === 'search' || /^(q|s|search|query|keyword|keywords)$/i.test(f.name));
    const commenty = /comment/i.test((fa.action ?? '') + ' ' + (fa.id ?? '')) || fields.some(f => f.type === 'textarea' && /comment/i.test(f.name + ' ' + f.label));
    if (fields.length && !searchy && !commenty) forms.push({ action: fa.action ?? '', method: (fa.method || 'get').toLowerCase(), fields });
    else rejected.push(fm[0]);
  }
  // Many pages (and pages built by JavaScript) are a set of boxes with no <form> tag around them. If the page has an e-mail box outside
  // any search or comment form, that is the sign-up form.
  let rest = markup;
  for (const r of rejected) rest = rest.replace(r, ' ');
  if (!forms.length) {
    const fields: FieldInfo[] = [];
    for (const im of rest.matchAll(/<(input|select|textarea)\b([^>]*)>/gi)) {
      const a = attrs('<' + im[1] + ' ' + im[2] + '>');
      const type = im[1].toLowerCase() === 'input' ? (a.type || 'text').toLowerCase() : im[1].toLowerCase();
      if (['hidden', 'submit', 'button', 'image', 'reset', 'search'].includes(type)) continue;
      const label = (a.id && labelFor.get(a.id)) || a['aria-label'] || a.placeholder || '';
      const name = a.name || a.id || '';
      if (/^(q|s|search|query|keyword|keywords)$/i.test(name) || /comment/i.test(name + ' ' + label) || type === 'textarea' && /comment/i.test(name)) continue;
      const c = canonField(`${name} ${label}`.trim());
      fields.push({ name, type, label, canon: c === 'other' && type === 'email' ? 'email' : c });
    }
    if (fields.some(f => f.canon === 'email' || f.type === 'email')) forms.push({ action: '', method: 'post', fields });
  }
  const allFields = forms.flatMap(f => f.fields);
  const fieldText = (f: FieldInfo) => `${f.name} ${f.label}`;
  const platforms = PLATFORMS.filter(([, re]) => re.test(body)).map(([k]) => k);
  const pageText = text(body.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')).slice(0, 20000);
  const hasPassword = allFields.some(f => f.type === 'password');
  const others = allFields.filter(f => !['password', 'checkbox', 'email'].includes(f.type) && f.canon !== 'email' && f.canon !== 'password' && !/user|login|remember|^pw$/i.test(fieldText(f)));
  const signupWords = /sign[\s-]?up|register|create (an )?account|join|subscribe/i.test(pageText);
  const loginWords = /log[\s-]?in|sign[\s-]?in/i.test(pageText);
  return {
    forms,
    // A real browser's look (the marker) wins; otherwise a visible widget inside the sign-up form counts.
    captcha: /<!--\s*UCAAS-DOM captcha=visible\s*-->/.test(body) ? true : /<!--\s*UCAAS-DOM captcha=none\s*-->/.test(body) ? false : CAPTCHA_VISIBLE.test(rest),
    invisibleCaptcha: CAPTCHA_INVISIBLE.test(body) || CAPTCHA_SCRIPT_ONLY.test(body) || CAPTCHA_VISIBLE.test(markup),
    payment: allFields.some(f => PAYMENT_FIELD.test(fieldText(f))) || PAYMENT_SCRIPT.test(body),
    fileUpload: allFields.some(f => f.type === 'file'),
    sensitiveFields: [...new Set(allFields.filter(f => isSensitiveField(fieldText(f))).map(f => f.name || f.label))],
    loginOnly: hasPassword && others.length === 0 && loginWords && !signupWords,
    platforms,
    scriptOnlyPage: forms.length === 0 && /<div[^>]+id=["'](root|app|__next|__nuxt)["']/i.test(body),
  };
}

export function classify(a: PageAnalysis): Classification {
  if (a.payment) return { handling: 'excluded', reason: 'needs a payment or card details' };
  if (a.fileUpload) return { handling: 'excluded', reason: 'asks for a file upload' };
  if (a.captcha) return { handling: 'staff', reason: 'page uses a CAPTCHA (staff complete it; it is never bypassed)' };
  if (a.sensitiveFields.length) return { handling: 'staff', reason: 'asks for a number staff must type by hand (for example SSN or account number)' };
  if (a.loginOnly) return { handling: 'staff', reason: 'needs an existing account to sign in' };
  if (a.forms.length) return { handling: 'simple', reason: a.invisibleCaptcha ? 'sign-up form found (invisible bot protection; if a challenge appears, staff finish it)' : 'plain sign-up form found' };
  if (a.scriptOnlyPage) return { handling: 'unknown', reason: 'form is built by JavaScript; needs a browser check' };
  return { handling: 'unknown', reason: 'no sign-up form found on this page' };
}

/** The set of traits two sign-up forms are compared on. */
export function fingerprint(a: PageAnalysis): string[] {
  const best = [...a.forms].sort((x, y) => y.fields.length - x.fields.length)[0];
  const tokens = new Set<string>();
  if (best) {
    for (const f of best.fields) { tokens.add('f:' + f.canon); tokens.add('t:' + f.type); }
    const n = best.fields.length;
    tokens.add('n:' + (n === 1 ? '1' : n <= 3 ? '2-3' : n <= 6 ? '4-6' : '7+'));
    tokens.add('m:' + best.method);
  }
  for (const p of a.platforms) tokens.add('p:' + p);
  return [...tokens].sort();
}
