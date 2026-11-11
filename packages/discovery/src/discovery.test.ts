import { describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
import { analyzeHtml, classify, fingerprint, similarity, scoreAgainst, safeFetchPage, isPrivateAddress, braveProvider } from './index';

const SIMPLE = `<html><body><form action="/join" method="post">
  <label for="e">Email address</label><input id="e" name="email" type="email">
  <input name="first_name" placeholder="First name"><input name="last_name" placeholder="Last name">
  <input type="checkbox" name="optin"><input type="hidden" name="csrf"><button type="submit">Join</button></form>
  <script src="https://x.list-manage.com/a.js"></script></body></html>`;
const SIMPLE2 = `<form method="post"><input name="EMAIL" type="email"><input name="FNAME"><input name="LNAME"></form><!-- mailchimp -->`;
const CAPTCHA = `<form><input name="email"><div class="g-recaptcha"></div></form>`;
const PAY = `<form><input name="email"><input name="cardnumber"><input name="cvv"></form>`;
const SSN = `<form><input name="email"><input name="ssn" placeholder="Social Security Number"></form>`;
const LOGIN = `<h1>Sign in</h1><form><input name="user"><input name="pw" type="password"></form>`;
const SPA = `<html><body><div id="root"></div><script src="/bundle.js"></script></body></html>`;

describe('page analysis', () => {
  it('reads a plain sign-up form and ignores hidden and button fields', () => {
    const a = analyzeHtml(SIMPLE);
    expect(a.forms).toHaveLength(1);
    expect(a.forms[0].fields.map(f => f.canon)).toEqual(['email', 'firstname', 'lastname', 'consent']);
    expect(a.platforms).toEqual(['mailchimp']);
    expect(classify(a).handling).toBe('simple');
  });
  it('sends anything with a CAPTCHA, sensitive number or login wall to staff', () => {
    expect(classify(analyzeHtml(CAPTCHA)).handling).toBe('staff');
    expect(classify(analyzeHtml(SSN)).handling).toBe('staff');
    expect(classify(analyzeHtml(SSN)).handling).toBe('staff');
    expect(classify(analyzeHtml(LOGIN)).reason).toContain('sign in');
  });
  it('excludes sites that need a payment or a file upload, even if they also have a CAPTCHA', () => {
    expect(classify(analyzeHtml(PAY))).toEqual({ handling: 'excluded', reason: 'needs a payment or card details' });
    expect(classify(analyzeHtml('<form><input name="email"><input type="file" name="resume"></form>'))).toEqual({ handling: 'excluded', reason: 'asks for a file upload' });
    expect(classify(analyzeHtml(PAY.replace('<form>', '<form><div class="g-recaptcha"></div>'))).handling).toBe('excluded');
    expect(classify(analyzeHtml('<form><input name="email"></form><script src="https://js.stripe.com/v3/"></script>')).handling).toBe('excluded');
  });
  it('only treats a visible challenge as a CAPTCHA, not an invisible score-based one or the word itself', () => {
    const v3 = '<form><input name="email"></form><script src="https://www.google.com/recaptcha/api.js?render=6LcABC"></script>';
    const invisibleWidget = '<form><input name="email"><div class="g-recaptcha" data-size="invisible" data-sitekey="k"></div></form>';
    const wordOnly = '<form><input name="email"></form><p>Protected by captcha technology. See our privacy policy.</p>';
    for (const html of [v3, invisibleWidget, wordOnly]) expect(classify(analyzeHtml(html)).handling).toBe('simple');
    expect(classify(analyzeHtml(v3)).reason).toContain('invisible');
    for (const html of [
      '<form><input name="email"><div class="h-captcha" data-sitekey="k"></div></form>',
      '<form><input name="email"><div class="cf-turnstile"></div></form>',
      '<form><input name="email"><img src="/captcha.png"><input name="captcha_answer"></form>',
    ]) expect(classify(analyzeHtml(html)).handling).toBe('staff');
    // script text alone is not proof of a visible CAPTCHA (it is often for another form or a hidden pop-up): a browser look decides
    expect(classify(analyzeHtml('<form><input name="email"></form><script>grecaptcha.render("x",{})</script>')).handling).toBe('simple');
    // ...and what a real browser saw wins
    expect(classify(analyzeHtml('<form><input name="email"></form><!--UCAAS-DOM captcha=visible-->')).handling).toBe('staff');
    expect(classify(analyzeHtml('<form><input name="email"><div class="g-recaptcha"></div></form><!--UCAAS-DOM captcha=none-->')).handling).toBe('simple');
    // a CAPTCHA on some other form of the page (a comment form, a contact form) does not make the sign-up form a CAPTCHA site
    expect(classify(analyzeHtml('<form><input name="email"></form><form action="/comment"><textarea name="comment"></textarea><div class="g-recaptcha"></div></form>')).handling).toBe('simple');
    // a page of plain boxes with no <form> tag still counts as a sign-up form
    expect(classify(analyzeHtml('<div><input type="email" placeholder="Email"><input name="first_name"><button>Join</button></div>')).handling).toBe('simple');
    expect(classify(analyzeHtml('<div><input type="search" name="q"><button>Go</button></div>')).handling).toBe('unknown');
  });
  it('says unknown, not simple, when it cannot see a form', () => {
    expect(classify(analyzeHtml(SPA)).handling).toBe('unknown');
    expect(classify(analyzeHtml('<p>hello</p>')).handling).toBe('unknown');
  });
});

describe('similarity', () => {
  it('ranks forms with the same shape above forms with a different shape', () => {
    const good = [fingerprint(analyzeHtml(SIMPLE))];
    const alike = scoreAgainst(fingerprint(analyzeHtml(SIMPLE2)), good);
    const different = scoreAgainst(fingerprint(analyzeHtml('<form><input name="zip"><input name="phone" type="tel"><input name="city"><input name="state"><input name="address"><input name="dob"><input name="country"></form>')), good);
    expect(alike > different).toBe(true);
    expect(similarity(good[0], good[0])).toBe(1);
    expect(scoreAgainst(good[0], [])).toBe(0);
  });
});

describe('safe fetcher', () => {
  it('recognises private addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.9', '172.16.0.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:127.0.0.1']) expect(isPrivateAddress(ip)).toBe(true);
    for (const ip of ['8.8.8.8', '93.184.216.34', '2606:4700::1111', '192.0.78.24', '192.0.66.232']) expect(isPrivateAddress(ip)).toBe(false);
  });
  it('refuses addresses inside your own network and non-web addresses', async () => {
    expect((await safeFetchPage('http://127.0.0.1:1/')).outcome).toBe('blocked_address');
    expect((await safeFetchPage('http://localhost/')).outcome).toBe('blocked_address');
    expect((await safeFetchPage('http://169.254.169.254/latest/meta-data')).outcome).toBe('blocked_address');
    expect((await safeFetchPage('http://intranet.internal/')).outcome).toBe('blocked_address');
    expect((await safeFetchPage('ftp://example.com/')).outcome).toBe('error');
    const sink = await safeFetchPage('http://host.example/', { lookup: async () => [{ address: '0.0.0.0' }] });
    expect(sink.outcome).toBe('blocked_address');
    expect(sink.detail).toContain('0.0.0.0');                   // says which address, so a DNS filter can be spotted
    const flaky = await safeFetchPage('http://flaky.example/', { lookup: async () => { throw Object.assign(new Error('x'), { code: 'EAI_AGAIN' }); } });
    expect(flaky.outcome).toBe('error');               // a passing DNS hiccup is not "blocked"
    expect(flaky.detail).toContain('try again');
    expect((await safeFetchPage('http://gone.example/', { lookup: async () => { throw Object.assign(new Error('x'), { code: 'ENOTFOUND' }); } })).outcome).toBe('dns_gone');
  });
  it('reads pages, respects robots.txt, and reports 404s and blocks honestly', async () => {
    const server = createServer((req, res) => {
      const u = req.url ?? '';
      if (u === '/robots.txt') { res.end('User-agent: *\nDisallow: /private\n'); }
      else if (u === '/join') res.end(SIMPLE);
      else if (u === '/old') { res.writeHead(404); res.end(); }
      else if (u === '/blocked') { res.writeHead(403); res.end(); }
      else if (u === '/busy') { res.writeHead(503); res.end(); }
      else if (u === '/signin') { res.writeHead(401); res.end(); }
      else if (u === '/go') { res.writeHead(302, { location: '/join' }); res.end(); }
      else if (u === '/private') res.end('secret');
      else { res.writeHead(500); res.end(); }
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as any).port}`;
    const d = { allowPrivate: true };
    const ok = await safeFetchPage(base + '/join', d);
    expect(ok.outcome).toBe('ok');
    expect(classify(analyzeHtml(ok.html!)).handling).toBe('simple');
    expect((await safeFetchPage(base + '/go', d)).outcome).toBe('ok');
    expect((await safeFetchPage(base + '/old', d)).outcome).toBe('page_missing');
    expect((await safeFetchPage(base + '/blocked', d)).outcome).toBe('bot_blocked');
    expect((await safeFetchPage(base + '/busy', d)).outcome).toBe('busy');
    expect((await safeFetchPage(base + '/signin', d)).outcome).toBe('sign_in_required');
    expect((await safeFetchPage(base + '/private', d)).outcome).toBe('robots_disallowed');
    await new Promise<void>(r => server.close(() => r()));
  });
});

describe('search provider', () => {
  it('turns the provider answer into hits, and fails loudly on errors', async () => {
    const good = braveProvider('k', (async () => new Response(JSON.stringify({ web: { results: [{ url: 'https://a.example', title: 'A' }, { title: 'no url' }] } }))) as any);
    expect(await good.search('q', 5)).toEqual([{ url: 'https://a.example', title: 'A' }]);
    const bad = braveProvider('k', (async () => new Response('no', { status: 401 })) as any);
    let failed = false; try { await bad.search('q', 5); } catch { failed = true; }
    expect(failed).toBe(true);
  });
});
