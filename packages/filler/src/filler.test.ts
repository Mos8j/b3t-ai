import { describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
import { createFiller } from './filler';
import { resolveControl, matchOption, formatDate, planCheckbox, generatePassword, makeUsername } from './keys';

const ctl = (o: Partial<Parameters<typeof resolveControl>[0]>) => ({ idx: 0, tag: 'input', type: 'text', name: '', id: '', label: '', placeholder: '', autocomplete: '', required: false, options: [], ...o });

describe('matching form boxes to stored information', () => {
  it('uses clear names only, and keeps sensitive boxes for a person', () => {
    expect(resolveControl(ctl({ label: 'First name' }))).toEqual({ kind: 'key', key: 'firstName' });
    expect(resolveControl(ctl({ autocomplete: 'postal-code', label: 'Code' }))).toEqual({ kind: 'key', key: 'postalCode' });
    expect(resolveControl(ctl({ type: 'email', name: 'x' }))).toEqual({ kind: 'key', key: 'email' });
    expect(resolveControl(ctl({ label: 'Social Security Number' }))).toEqual({ kind: 'sensitive' });
    expect(resolveControl(ctl({ type: 'password', label: 'Password' }))).toEqual({ kind: 'password', confirm: false });
    expect(resolveControl(ctl({ label: 'Favorite color' }))).toEqual({ kind: 'unknown' });
  });
  it('picks dropdown choices and date shapes without guessing', () => {
    const states = [{ value: 'CA', text: 'California' }, { value: 'NY', text: 'New York' }];
    expect(matchOption(states, 'California', 'state')).toBe('CA');
    expect(matchOption(states, 'ny', 'state')).toBe('NY');
    expect(matchOption(states, 'Atlantis', 'state')).toBeNull();
    expect(formatDate('1990-04-25', ctl({ type: 'date' }))).toBe('1990-04-25');
    expect(formatDate('1990-04-25', ctl({ placeholder: 'MM/DD/YYYY' }))).toBe('04/25/1990');
    expect(formatDate('1990-04-25', ctl({ placeholder: 'MM-DD-YYYY' }))).toBe('04-25-1990');
  });
});

describe('checkboxes, passwords and usernames', () => {
  it('ticks terms and marketing boxes, but sends money, sharing, phone marketing and robot checks to a person', () => {
    expect(planCheckbox('I agree to the Terms and Conditions', true)).toEqual({ action: 'tick', consent: 'accept_site_terms' });
    expect(planCheckbox('Send me offers and updates', false)).toEqual({ action: 'tick', consent: 'marketing_opt_in' });
    expect(planCheckbox('I authorize recurring charges to my card', true).action).toBe('human');
    expect(planCheckbox('Start my free trial (renews automatically)', false).action).toBe('human');
    expect(planCheckbox('Share my details with our partners', false).action).toBe('leave');
    expect(planCheckbox('Share my details with our partners', true).action).toBe('human');
    expect(planCheckbox('Text me deals by SMS', false).action).toBe('leave');
    expect(planCheckbox("I'm not a robot", true).action).toBe('human');
    expect(planCheckbox('Something odd', true).action).toBe('human');
    expect(planCheckbox('Something odd', false).action).toBe('leave');
    const today = new Date('2026-10-16T00:00:00Z');
    expect(planCheckbox('I am 18 or older', true, '1990-04-25', today)).toEqual({ action: 'tick', consent: 'accept_site_terms' });
    expect(planCheckbox('I am 21 or older', true, '2010-01-01', today).action).toBe('human');
    expect(planCheckbox('I am 18 or older', true, undefined, today).action).toBe('human');
  });
  it('makes long random passwords and plain usernames', () => {
    const rnd = (n: number) => Math.floor(Math.random() * n);
    const p = generatePassword(rnd);
    expect(p.length).toBe(20);
    expect(/[a-z]/.test(p) && /[A-Z]/.test(p) && /\d/.test(p) && /[!@#$%^*_-]/.test(p)).toBe(true);
    expect(generatePassword(rnd)).not.toBe(p);
    expect(makeUsername('Alice', 'Ex-ample', rnd).startsWith('aliceexample')).toBe(true);
  });
});

const profile = { firstName: 'Alice', lastName: 'Example', email: 'alice@example.com', phone: '415-555-0134', state: 'CA', postalCode: '90001', dateOfBirth: '1990-04-25', siteCount: '5' };
const ACCOUNT = `<form method="post" action="/submit/account">
  <label for="f">First name</label><input id="f" name="first_name" required>
  <label for="e">Email address</label><input id="e" name="email" type="email" required>
  <label for="u">Username</label><input id="u" name="username" required>
  <label for="pw">Password</label><input id="pw" name="password" type="password" required>
  <label for="pc">Confirm password</label><input id="pc" name="password2" type="password" required>
  <label><input type="checkbox" name="terms" required> I agree to the Terms and Conditions</label>
  <label><input type="checkbox" name="age" required> I am 18 or older</label>
  <label><input type="checkbox" name="offers" value="yes"> Send me offers and updates</label>
  <label><input type="checkbox" name="partners" value="yes"> Share my details with our partners</label>
  <button type="submit">Create account</button></form>`;
const STYLE = '<style>.hp{display:none}</style>';
const page = (title: string, body: string) => `<html><head><title>${title}</title>${STYLE}</head><body>${body}</body></html>`;
const GOOD = `<form method="post" action="/submit/ok">
  <label for="f">First name</label><input id="f" name="first_name" required>
  <label for="l">Last name</label><input id="l" name="last_name" required>
  <label for="e">Email address</label><input id="e" name="email" type="email" required>
  <label for="p">Phone</label><input id="p" name="phone" type="tel">
  <label for="s">State</label><select id="s" name="state"><option value="">Choose</option><option value="CA">California</option><option value="NY">New York</option></select>
  <label for="d">Date of birth</label><input id="d" name="dob" type="date">
  <input class="hp" name="website" value="">
  <label><input type="checkbox" name="offers" value="yes"> Send me offers</label>
  <button type="submit">Join now</button></form>`;

describe('filling a form and stopping for approval', () => {
  it('fills only what it can match, sends nothing until approved, and confirms only on a real success message', async () => {
    const posts: { path: string; body: string }[] = [];
    const server = createServer((req, res) => {
      const u = req.url ?? '';
      const html = (s: string, code = 200) => { res.writeHead(code, { 'content-type': 'text/html' }); res.end(s); };
      if (u === '/robots.txt') { res.writeHead(404); return res.end(); }
      if (req.method === 'POST') {
        let body = ''; req.on('data', c => (body += c));
        req.on('end', () => {
          posts.push({ path: u, body });
          if (u === '/submit/account') html(page('Done', '<h1>Thank you for signing up!</h1>'));
          else if (u === '/submit/ok') html(page('Done', '<h1>Thank you for signing up!</h1><p>Welcome, Alice Example.</p>'));
          else if (u === '/submit/email') html(page('Almost', '<p>Please check your email to confirm your subscription.</p>'));
          else if (u === '/submit/bad') html(page('Oops', `<p class="err">Please enter a valid email address.</p>${GOOD.replace('/submit/ok', '/submit/bad')}`));
          else if (u === '/submit/quiet') html(page('Hi', '<p>Okay.</p>'));
          else if (u === '/submit/already') html(page('Hi', '<p>This email is already subscribed to our list.</p>'));
          else if (u === '/submit/thanks') { res.writeHead(302, { location: '/thank-you' }); res.end(); }
          else if (u === '/submit/human') html(page('Just a moment...', '<p>Please verify you are human</p>'));
          else html(page('?', '?'), 404);
        });
        return;
      }
      if (u === '/thank-you') return html(page('Hi', '<p>Okay.</p>'));
      if (u === '/already') return html(page('Join', GOOD.replace('/submit/ok', '/submit/already')));
      if (u === '/redirect') return html(page('Join', GOOD.replace('/submit/ok', '/submit/thanks')));
      if (u === '/good') return html(page('Join', GOOD));
      if (u === '/email') return html(page('Join', GOOD.replace('/submit/ok', '/submit/email')));
      if (u === '/bad') return html(page('Join', GOOD.replace('/submit/ok', '/submit/bad')));
      if (u === '/quiet') return html(page('Join', GOOD.replace('/submit/ok', '/submit/quiet')));
      if (u === '/nobutton') return html(page('Join', GOOD.replace(/<button[\s\S]*?<\/button>/, '<div>Send it</div>')));
      if (u === '/captcha') return html(page('Join', GOOD.replace('<button', '<div class="g-recaptcha" style="width:300px;height:78px"></div><button')));
      if (u === '/arrow') return html(page('Join', '<form class="newsletter-search" method="post" action="/submit/ok"><input name="email" type="email" placeholder="Your email" required><button class="go-btn"><svg width="10" height="10"><path d="M0 0L10 5L0 10"/></svg></button></form>'));
      if (u === '/magnifier') return html(page('Join', '<div class="signup-box"><input name="email" type="email" placeholder="Email address"><span class="icon-search" role="button" aria-label="Search"><svg width="10" height="10"></svg></span></div><script>document.querySelector(".icon-search").onclick=function(){var f=document.createElement("form");f.method="post";f.action="/submit/ok";var i=document.createElement("input");i.name="email";i.value=document.querySelector("input").value;f.appendChild(i);document.body.appendChild(f);f.submit();};</script>'));
      if (u === '/divform') return html(page('Join', '<h1>Join our club</h1><div class="signup"><label for="e">Email</label><input id="e" name="email" type="email" required><label for="f">First name</label><input id="f" name="first_name" required><button>Join now</button></div>'));
      if (u === '/scriptcaptcha') return html(page('Join', GOOD + '<script>var later = "grecaptcha.render(\'x\')";</script><div class="g-recaptcha" style="display:none"></div>'));
      if (u === '/human') return html(page('Join', GOOD.replace('/submit/ok', '/submit/human')));
      if (u === '/terms') return html(page('Join', GOOD.replace('<label><input type="checkbox" name="offers" value="yes"> Send me offers</label>', '<label><input type="checkbox" name="terms" required> I agree to the Terms and Conditions</label>')));
      if (u === '/unknown') return html(page('Join', GOOD.replace('<button', '<label for="c">Favorite color</label><input id="c" name="color" required><button')));
      if (u === '/payment') return html(page('Join', GOOD.replace('<button', '<input name="cardnumber"><input name="cvv"><button')));
      if (u === '/upload') return html(page('Join', GOOD.replace('<button', '<input type="file" name="resume"><button')));
      if (u === '/ssn') return html(page('Join', GOOD.replace('<button', '<label for="x">Social Security Number</label><input id="x" name="ssn"><button')));
      if (u === '/challenge') return html(page('Just a moment...', '<p>Please verify you are human</p>'));
      if (u === '/account') return html(page('Join', ACCOUNT));
      if (u === '/account-money') return html(page('Join', ACCOUNT.replace('I am 18 or older', 'I authorize recurring charges to my card')));
      if (u === '/private') return html(page('Join', GOOD));
      res.writeHead(404); res.end();
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as any).port;
    const base = `http://site.example:${port}`;
    const filler = createFiller({
      popupWaitMs: 0,
      launchArgs: ['--host-resolver-rules=MAP site.example 127.0.0.1'],
      lookup: async () => [{ address: '93.184.216.34' }],
      fetchImpl: ((u: any, init: any) => fetch(String(u).replace('site.example', '127.0.0.1'), init)) as typeof fetch,
    });
    try {
      // 1. Fill, then wait. Nothing has been sent.
      const s = await filler.prepare(`${base}/good`, profile);
      expect(s.report.status, s.report.reason).toBe('ready_for_approval');
      expect(s.report.filled.map(f => f.key).sort()).toEqual(['dateOfBirth', 'email', 'firstName', 'lastName', 'phone', 'state']);
      expect(s.report.skipped.join(' ')).toContain('Send me offers');           // optional box left unticked
      expect(JSON.stringify(s.report.filled)).not.toContain('Alice');           // names of fields only, never values
      expect(Buffer.isBuffer(s.report.screenshot)).toBe(true);
      expect(posts).toHaveLength(0);
      // 2. Approved: send. Only the matched boxes were filled; the hidden trap box and the checkbox were not touched.
      const r = await s.submit();
      expect(r.status).toBe('confirmed');
      expect(r.evidence).toContain('Thank you');
      expect(r.evidence).not.toContain('Alice');                                 // client details are removed from the saved evidence
      expect(posts).toHaveLength(1);
      expect(posts[0].body).toContain('first_name=Alice');
      expect(posts[0].body).toContain('state=CA');
      expect(posts[0].body.endsWith('website=')).toBe(true);
      expect(posts[0].body).not.toContain('offers');
      await s.close();

      // 3. Things a person must decide or type are never done for them.
      for (const [path, hint] of [['/terms', 'permission'], ['/unknown', 'Favorite color']] as const) {
        const x = await filler.prepare(`${base}${path}`, profile);
        expect(x.report.status).toBe('needs_human');
        expect(x.report.needsHuman.join(' ')).toContain(hint);
        expect((await x.submit()).detail).toContain('Nothing was sent');
        await x.close();
      }
      const missing = await filler.prepare(`${base}/good`, { firstName: 'Alice', email: 'alice@example.com' });
      expect(missing.report.status).toBe('needs_human');                          // last name is required and not on file: never guessed
      expect(missing.report.needsHuman.join(' ')).toContain('no information on file');
      await missing.close();

      // 4. Pages we must not automate.
      expect((await filler.prepare(`${base}/payment`, profile)).report.status).toBe('refused');
      expect((await filler.prepare(`${base}/upload`, profile)).report.status).toBe('refused');
      expect((await filler.prepare(`${base}/ssn`, profile)).report.status).toBe('needs_human');
      expect((await filler.prepare(`${base}/challenge`, profile)).report.status).toBe('blocked');
      expect((await filler.prepare(`${base}/robots-none`, profile)).report.status).toBe('error');
      expect((await filler.prepare('ftp://x.example/a', profile)).report.status).toBe('error');
      const before = posts.length;

      // 5. Honest results after sending.
      for (const [path, want] of [['/email', 'confirm_email'], ['/bad', 'failed'], ['/quiet', 'sent_unconfirmed'], ['/human', 'blocked']] as const) {
        const x = await filler.prepare(`${base}${path}`, profile);
        expect(x.report.status).toBe('ready_for_approval');
        expect((await x.submit()).status).toBe(want);
        await x.close();
      }
      const cp = await filler.prepare(`${base}/captcha`, profile, { handOver: true });   // normal runs leave CAPTCHA pages to a person; hand-over mode fills them
      expect(cp.report.captcha).toBe(true);                                       // a visible CAPTCHA box is noticed (and never touched)
      await cp.close();
      const plainForm = await filler.prepare(`${base}/good`, profile);
      expect(!!plainForm.report.captcha).toBe(false);
      await plainForm.close();
      expect((await filler.scan!(`${base}/captcha`)).captcha).toBe(true);        // looking only: a CAPTCHA page is recognised
      expect((await filler.scan!(`${base}/good`)).captcha).toBe(false);
      expect((await filler.scan!(`${base}/challenge`)).captcha).toBe(true);
      const dv = await filler.prepare(`${base}/divform`, profile);
      expect(dv.report.status).toBe('ready_for_approval');                         // boxes with no <form> tag are still a sign-up form
      expect(dv.report.filled.map(f => f.key).sort()).toEqual(['email', 'firstName']);
      await dv.close();
      for (const route of ['arrow', 'magnifier']) {
        const ar = await filler.prepare(`${base}/${route}`, profile);
        expect(ar.report.status).toBe('ready_for_approval');                       // a newsletter box whose send button is only an arrow or magnifying glass
        expect((await ar.submit()).status).toBe('confirmed');
        await ar.close();
      }
      const sc = await filler.prepare(`${base}/scriptcaptcha`, profile);
      expect(sc.report.status).toBe('ready_for_approval');                         // a hidden widget and script text are not a CAPTCHA
      expect(!!sc.report.captcha).toBe(false);
      await sc.close();
      const nb = await filler.prepare(`${base}/nobutton`, profile);
      expect(nb.report.status).toBe('ready_for_approval');
      expect((await nb.submit()).status).toBe('confirmed');                      // no button: sent the normal browser way
      await nb.close();
      const al = await filler.prepare(`${base}/already`, profile);
      const alr = await al.submit(); await al.close();
      expect(alr.status).toBe('already_member');                                  // "already subscribed" is its own result, not "rejected"
      const rd = await filler.prepare(`${base}/redirect`, profile);
      const rdr = await rd.submit(); await rd.close();
      expect(rdr.status).toBe('confirmed');                                       // moved on to /thank-you
      const qt = await filler.prepare(`${base}/quiet`, profile);
      const qtr = await qt.submit(); await qt.close();
      expect(qtr.status).toBe('sent_unconfirmed'); expect(qtr.likely).toBe(true);  // the site answered the send and the form went away
      expect(posts.length).toBe(before + 10);                                      // one send per approved form, nothing more

      // 6. Boxes, usernames and passwords: only with the client's recorded permission and a safe place for the login.
      const noPermission = await filler.prepare(`${base}/account`, profile, { consents: [] });
      expect(noPermission.report.status).toBe('needs_human');
      expect(noPermission.report.needsHuman.join(' ')).toContain('create_accounts');
      await noPermission.close();
      const saved: { site: string; username?: string; password: string }[] = [];
      const consents = ['accept_site_terms', 'marketing_opt_in', 'create_accounts'];
      const acct = await filler.prepare(`${base}/account`, profile, { consents, saveLogin: async l => { saved.push(l); } });
      expect(acct.report.status).toBe('ready_for_approval');
      expect(acct.report.ticked.length).toBe(3);                                   // terms, age, offers. The partners box is left alone.
      expect(saved).toHaveLength(0);                                               // nothing is saved or sent before approval
      const sentBefore = posts.length;
      const done = await acct.submit();
      expect(done.status).toBe('confirmed');
      expect(saved).toHaveLength(1);
      const body = posts[sentBefore].body;
      expect(body).toContain('terms=on');
      expect(body).toContain('offers=yes');
      expect(body).not.toContain('partners');
      expect(new URLSearchParams(body).get('password')).toBe(saved[0].password);
      expect(new URLSearchParams(body).get('password2')).toBe(saved[0].password);  // both password boxes match
      expect(body).toContain('username=' + saved[0].username);
      expect(saved[0].username!.startsWith('aliceexample')).toBe(true);
      await acct.close();
      // money wording is never ticked, even with every permission
      const money = await filler.prepare(`${base}/account-money`, profile, { consents, saveLogin: async () => {} });
      expect(money.report.status).toBe('needs_human');
      expect(money.report.needsHuman.join(' ')).toContain('recurring charges');
      await money.close();
      // if the login cannot be saved, nothing is sent
      const failing = await filler.prepare(`${base}/account`, profile, { consents, saveLogin: async () => { throw new Error('disk full'); } });
      const count = posts.length;
      expect((await failing.submit()).status).toBe('failed');
      expect(posts.length).toBe(count);
      await failing.close();
    } finally { await filler.close(); await new Promise<void>(r => server.close(() => r())); }
  }, 120_000);
});
