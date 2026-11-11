import { describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
import { createBrowserChecker, analyzeHtml, classify, looksLikeBotChallenge } from './index';

const FORM = '<form><input name="email" type="email"><input name="first_name"><input name="last_name"></form>';

describe('rendered-page captcha markers', () => {
  it('treats the invisible reCAPTCHA badge as invisible, and a checkbox widget as a challenge', () => {
    const invisible = `<form><input name="email"></form><div class="grecaptcha-badge"><iframe src="https://www.google.com/recaptcha/api2/anchor?k=1&size=invisible"></iframe></div><iframe src="https://www.google.com/recaptcha/api2/bframe?hl=en"></iframe>`;
    expect(classify(analyzeHtml(invisible)).handling).toBe('simple');
    const checkbox = `<form><input name="email"></form><iframe src="https://www.google.com/recaptcha/api2/anchor?k=1&size=normal"></iframe>`;
    expect(classify(analyzeHtml(checkbox)).handling).toBe('staff');
    const hc = `<form><input name="email"></form><iframe src="https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html#frame=checkbox"></iframe>`;
    expect(classify(analyzeHtml(hc)).handling).toBe('staff');
  });
  it('recognises "verify you are human" screens', () => {
    expect(looksLikeBotChallenge('Just a moment...', '')).toBe(true);
    expect(looksLikeBotChallenge('Home', 'Please verify you are human to continue')).toBe(true);
    expect(looksLikeBotChallenge('Join our club', 'Sign up for rewards today')).toBe(false);
  });
});

describe('browser launch', () => {
  it('falls back to Edge and Chrome, and says what to do when no browser starts', async () => {
    const calls: (string | undefined)[] = [];
    const loader = async () => ({ chromium: { launch: async ({ channel }: any) => { calls.push(channel); throw new Error('no ' + channel); } } });
    const r = await createBrowserChecker({ loader, lookup: async () => [{ address: '93.184.216.34' }] }).analyze('https://a.example');
    expect(calls).toEqual([undefined, 'msedge', 'chrome']);
    expect(r.outcome).toBe('error');
    expect(r.detail).toContain('playwright install chromium');
    const none = await createBrowserChecker({ loader: async () => { throw new Error('Cannot find package'); } }).analyze('https://a.example');
    expect(none.outcome).toBe('error');
  });
});

describe('browser check (needs Playwright and a browser; skipped if they are not there)', () => {
  it('reads JavaScript-built forms, follows one sign-up link, stays honest, and never touches private addresses', async () => {
    let secretHits = 0; let userAgent = '';
    const server = createServer((req, res) => {
      const u = req.url ?? '';
      userAgent = String(req.headers['user-agent'] ?? userAgent);
      const html = (b: string, title = 'Page') => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<html><head><title>${title}</title></head><body>${b}</body></html>`); };
      if (u === '/robots.txt') { res.end('User-agent: *\nDisallow: /private'); }
      else if (u === '/static') html(FORM);
      else if (u === '/js') html(`<div id="r"></div><script>setTimeout(function(){document.getElementById('r').innerHTML='${FORM}'},150)</script>`);
      else if (u === '/link') html('<a href="/about">About</a> <a href="/join">Join now</a>');
      else if (u === '/join') html(FORM);
      else if (u === '/scroll') html(`<div style="height:5000px">tall page</div><div id="r"></div><script>window.addEventListener('scroll',function(){if(window.scrollY>1000){document.getElementById('r').innerHTML='${FORM}'}})</script>`);
      else if (u === '/rewards') html('<a href="/blog">Blog</a> <a href="/rewards/enroll" title="Loyalty program">Our perks</a>');
      else if (u === '/rewards/enroll') html(FORM);
      else if (u === '/challenge') html('<p>Please verify you are human</p>', 'Just a moment...');
      else if (u === '/private') html(FORM);
      else if (u === '/ssrf') html(`${FORM}<script src="http://internal.example:${(server.address() as any).port}/secret.js"></script>`);
      else if (u === '/secret.js') { secretHits++; res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(''); }
      else { res.writeHead(404); res.end(); }
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as any).port;
    const base = `http://site.example:${port}`;
    const checker = createBrowserChecker({
      launchArgs: ['--host-resolver-rules=MAP site.example 127.0.0.1, MAP internal.example 127.0.0.1'],
      lookup: async h => [{ address: h === 'internal.example' ? '10.0.0.9' : '93.184.216.34' }],
      fetchImpl: ((u: any, init: any) => fetch(String(u).replace('site.example', '127.0.0.1'), init)) as typeof fetch, // Node cannot resolve the pretend host, so robots.txt is read via the local address
      timeoutMs: 15000,
    });
    try {
      const probe = await checker.analyze(base + '/static');
      if (probe.outcome === 'error' && /start a browser|Cannot find|not installed/.test(probe.detail ?? '')) return; // no browser here: skip
      expect(probe.outcome).toBe('ok');
      expect(classify(analyzeHtml(probe.html!)).handling).toBe('simple');
      expect(userAgent).toContain('UCAAS-SiteChecker');                 // honest about what it is

      const js = await checker.analyze(base + '/js');
      expect(js.outcome).toBe('ok');
      expect(classify(analyzeHtml('<div id="r"></div><script>build()</script>')).handling).toBe('unknown'); // a plain fetch sees no form
      expect(classify(analyzeHtml(js.html!)).handling).toBe('simple');   // the browser does

      const link = await checker.analyze(base + '/link');
      expect(link.outcome).toBe('ok');
      expect(link.oneLinkAway).toBe('/join');
      const scrolled = await checker.analyze(`${base}/scroll`);
      expect(classify(analyzeHtml(scrolled.html!)).handling).toBe('simple'); // a pop-up that only shows after scrolling
      const perks = await checker.analyze(`${base}/rewards`);
      expect(perks.oneLinkAway).toBe('/rewards/enroll');
      expect(classify(analyzeHtml(link.html!)).handling).toBe('simple');

      expect((await checker.analyze(base + '/challenge')).outcome).toBe('bot_blocked');   // reported, never bypassed
      expect((await checker.analyze(base + '/private')).outcome).toBe('robots_disallowed');
      expect((await checker.analyze(base + '/gone')).outcome).toBe('page_missing');

      const ssrf = await checker.analyze(base + '/ssrf');
      expect(ssrf.outcome).toBe('ok');
      expect(secretHits).toBe(0);                                        // the page tried to load a private address; it was blocked
      const internal = await checker.analyze(`http://internal.example:${port}/static`);
      expect(internal.outcome).toBe('blocked_address');
    } finally { await checker.close(); await new Promise<void>(r => server.close(() => r())); }
  }, 60_000); // starting a real browser on Windows can take longer than vitest's 5 seconds
});
