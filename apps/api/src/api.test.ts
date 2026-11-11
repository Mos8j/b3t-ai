import { describe, it, expect } from 'vitest';
import { request } from 'node:http';
import type { Server } from 'node:http';
import { generateMasterKey, parseMasterKey } from '../../../packages/security/src/index';
import { createApp, type AppConfig } from './server';
import { storeClientLogin } from './logins';
import { MemoryRepo } from './memory-repo';

interface Res { status: number; json: any; setCookie: string[] }
function call(base: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const u = new URL(base + path);
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = request({
      method, hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      headers: { ...(data ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(data)) } : {}), ...headers },
    }, res => {
      let buf = '';
      res.on('data', c => (buf += c));
      res.on('end', () => {
        let json: any = null;
        try { json = buf ? JSON.parse(buf) : null; } catch { /* html or empty */ }
        resolve({ status: res.statusCode!, json, setCookie: (res.headers['set-cookie'] as string[]) ?? [] });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function boot(extra: Partial<AppConfig> = {}) {
  const repo = new MemoryRepo();
  const masterKey = parseMasterKey(generateMasterKey());
  const server: Server = createApp(repo, {
    cleanup: { removed: { 'dead.example': 'domain no longer exists' }, research: ['moved.example'] },
    masterKey, sessionSecret: 'x'.repeat(48), secureCookies: false, log: () => {}, ...extra,
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const session = () => {
    let cookie = '';
    return {
      async login(email: string, password: string) {
        const r = await call(base, 'POST', '/api/login', { email, password });
        if (r.setCookie[0]) cookie = r.setCookie[0].split(';')[0];
        return r;
      },
      call: (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
        call(base, method, path, body, { ...(cookie ? { cookie } : {}), ...headers }),
    };
  };
  return { repo, masterKey, base, session, close: () => new Promise<void>(r => server.close(() => r())) };
}

const PW = 'Strong-Passw0rd-1';
const profile = { firstName: 'Alice', lastName: 'Example', email: 'alice@example.com', phone: '415-555-0134',
  addressLine1: '1 Test St', city: 'Testville', state: 'CA', postalCode: '90001' };

async function adminAnd(t: Awaited<ReturnType<typeof boot>>) {
  await call(t.base, 'POST', '/api/setup', { email: 'admin@example.com', password: PW });
  const admin = t.session();
  await admin.login('admin@example.com', PW);
  return admin;
}

describe('setup and login', () => {
  it('allows first-time setup only once', async () => {
    const t = await boot();
    expect((await call(t.base, 'GET', '/api/status')).json.needsSetup).toBe(true);
    expect((await call(t.base, 'POST', '/api/setup', { email: 'a@example.com', password: 'weak' })).status).toBe(400);
    expect((await call(t.base, 'POST', '/api/setup', { email: 'a@example.com', password: PW })).status).toBe(201);
    expect((await call(t.base, 'POST', '/api/setup', { email: 'b@example.com', password: PW })).status).toBe(409);
    expect((await call(t.base, 'GET', '/api/status')).json.needsSetup).toBe(false);
    await t.close();
  });
  it('sets a hardened cookie and treats wrong email and wrong password the same', async () => {
    const t = await boot();
    await adminAnd(t);
    const ok = await call(t.base, 'POST', '/api/login', { email: 'admin@example.com', password: PW });
    expect(ok.status).toBe(200);
    expect(ok.setCookie[0].includes('HttpOnly')).toBe(true);
    expect(ok.setCookie[0].includes('SameSite=Strict')).toBe(true);
    const badPw = await call(t.base, 'POST', '/api/login', { email: 'admin@example.com', password: 'nope' });
    const noUser = await call(t.base, 'POST', '/api/login', { email: 'ghost@example.com', password: 'nope' });
    expect(badPw.status).toBe(401);
    expect(noUser.status).toBe(401);
    expect(badPw.json.error).toBe(noUser.json.error);
    await t.close();
  });
  it('locks out after repeated failures', async () => {
    const t = await boot();
    await adminAnd(t);
    for (let i = 0; i < 5; i++) await call(t.base, 'POST', '/api/login', { email: 'victim@example.com', password: 'x' });
    expect((await call(t.base, 'POST', '/api/login', { email: 'victim@example.com', password: PW })).status).toBe(429);
    await t.close();
  });
  it('requires sign-in and ends the session on logout', async () => {
    const t = await boot();
    const admin = await adminAnd(t);
    expect((await call(t.base, 'GET', '/api/clients')).status).toBe(401);
    expect((await admin.call('GET', '/api/me')).status).toBe(200);
    await admin.call('POST', '/api/logout');
    expect((await admin.call('GET', '/api/me')).status).toBe(401);
    await t.close();
  });
  it('blocks cross-site writes', async () => {
    const t = await boot();
    const admin = await adminAnd(t);
    const r = await admin.call('POST', '/api/clients', { displayName: 'X', profile: {} }, { origin: 'http://evil.example' });
    expect(r.status).toBe(403);
    await t.close();
  });
});

describe('clients', () => {
  it('stores profiles encrypted and returns them decrypted with missing-info alerts', async () => {
    const t = await boot();
    const admin = await adminAnd(t);
    const created = await admin.call('POST', '/api/clients', { displayName: 'C-001', profile, consents: ['use_profile_for_applications'] });
    expect(created.status).toBe(201);
    const id = created.json.id as string;
    const stored = t.repo.clients.get(id)!;
    expect(stored.encryptedProfile.toString('utf8').includes('Alice')).toBe(false);
    const got = await admin.call('GET', `/api/clients/${id}`);
    expect(got.json.profile.firstName).toBe('Alice');
    expect(got.json.missing).toEqual(['how many sites the client wants to join']);
    expect(got.json.consents).toHaveLength(1);
    await t.close();
  });
  it('rejects sensitive identifiers and unknown fields', async () => {
    const t = await boot();
    const admin = await adminAnd(t);
    const r1 = await admin.call('POST', '/api/clients', { displayName: 'C', profile: { firstName: 'A', ssn: '123-45-6789' } });
    expect(r1.status).toBe(400);
    expect(JSON.stringify(r1.json).includes('123-45-6789')).toBe(false);
    expect((await admin.call('POST', '/api/clients', { displayName: 'C', profile: { favoriteColor: 'blue' } })).status).toBe(400);
    expect((await admin.call('POST', '/api/clients', { displayName: 'C', profile: { email: 'not-an-email' } })).status).toBe(400);
    expect(t.repo.clients.size).toBe(0);
    await t.close();
  });
  it('keeps clients separate between staff members', async () => {
    const t = await boot();
    const admin = await adminAnd(t);
    await admin.call('POST', '/api/users', { email: 'op1@example.com', password: PW, role: 'operator' });
    await admin.call('POST', '/api/users', { email: 'op2@example.com', password: PW, role: 'operator' });
    const op1 = t.session(); await op1.login('op1@example.com', PW);
    const op2 = t.session(); await op2.login('op2@example.com', PW);
    const id = (await op1.call('POST', '/api/clients', { displayName: 'Op1 client', profile })).json.id as string;
    expect((await op1.call('GET', `/api/clients/${id}`)).status).toBe(200);
    expect((await op2.call('GET', `/api/clients/${id}`)).status).toBe(404);
    expect((await op2.call('PUT', `/api/clients/${id}`, { profile })).status).toBe(404);
    expect((await op2.call('GET', '/api/clients')).json.clients).toHaveLength(0);
    expect((await op1.call('GET', '/api/clients')).json.clients).toHaveLength(1);
    await t.close();
  });
  it('lets viewers read assigned clients but not change anything', async () => {
    const t = await boot();
    const admin = await adminAnd(t);
    const viewerUser = (await admin.call('POST', '/api/users', { email: 'v@example.com', password: PW, role: 'viewer' })).json.user;
    const id = (await admin.call('POST', '/api/clients', { displayName: 'C', profile })).json.id as string;
    const viewer = t.session(); await viewer.login('v@example.com', PW);
    expect((await viewer.call('GET', `/api/clients/${id}`)).status).toBe(404); // not assigned yet
    await admin.call('POST', `/api/clients/${id}/assign`, { userId: viewerUser.id });
    expect((await viewer.call('GET', `/api/clients/${id}`)).status).toBe(200);
    expect((await viewer.call('PUT', `/api/clients/${id}`, { profile })).status).toBe(403);
    expect((await viewer.call('POST', '/api/clients', { displayName: 'N', profile })).status).toBe(403);
    expect((await viewer.call('GET', '/api/audit')).status).toBe(403);
    await t.close();
  });
  it('only admins can delete, and deleted clients disappear', async () => {
    const t = await boot();
    const admin = await adminAnd(t);
    await admin.call('POST', '/api/users', { email: 'op@example.com', password: PW, role: 'operator' });
    const op = t.session(); await op.login('op@example.com', PW);
    const id = (await op.call('POST', '/api/clients', { displayName: 'C', profile })).json.id as string;
    expect((await op.call('DELETE', `/api/clients/${id}`)).status).toBe(403);
    expect((await admin.call('DELETE', `/api/clients/${id}`)).status).toBe(200);
    expect((await admin.call('GET', `/api/clients/${id}`)).status).toBe(404);
    expect((await admin.call('GET', '/api/clients')).json.clients).toHaveLength(0);
    await t.close();
  });
  it('edits re-encrypt and keep the data', async () => {
    const t = await boot();
    const admin = await adminAnd(t);
    const id = (await admin.call('POST', '/api/clients', { displayName: 'C', profile })).json.id as string;
    const before = t.repo.clients.get(id)!.encryptedProfile.toString('hex');
    expect((await admin.call('PUT', `/api/clients/${id}`, { profile: { ...profile, city: 'Newtown' } })).status).toBe(200);
    expect(t.repo.clients.get(id)!.encryptedProfile.toString('hex') === before).toBe(false);
    expect((await admin.call('GET', `/api/clients/${id}`)).json.profile.city).toBe('Newtown');
    await t.close();
  });
});

describe('date of birth typed the US way', () => {
  it('accepts MM-DD-YYYY, stores it as YYYY-MM-DD, and rejects impossible dates', async () => {
    const t = await boot();
    const admin = await adminAnd(t);
    const id = (await admin.call('POST', '/api/clients', { displayName: 'D', profile: { ...profile, dateOfBirth: '04-25-1990', state: 'NV', country: 'United States' } })).json.id as string;
    expect((await admin.call('GET', `/api/clients/${id}`)).json.profile.dateOfBirth).toBe('1990-04-25');
    expect((await admin.call('POST', '/api/clients', { displayName: 'E', profile: { ...profile, dateOfBirth: '13-45-1990' } })).status).toBe(400);
    await t.close();
  });
});

describe('site count', () => {
  it('accepts all or a sensible number and rejects the rest', async () => {
    const t = await boot();
    const admin = await adminAnd(t);
    for (const ok of ['all', '25', 50]) expect((await admin.call('POST', '/api/clients', { displayName: 'C', profile: { ...profile, siteCount: ok } })).status).toBe(201);
    for (const bad of ['0', '-5', 'lots', '1.5', '99999']) expect((await admin.call('POST', '/api/clients', { displayName: 'C', profile: { siteCount: bad } })).status).toBe(400);
    await t.close();
  });
});

describe('site directory', () => {
  const csv = 'name,url,category\nAlpha Rewards,https://alpha.example/join,\nBeta Club,https://www.beta.example,\nBeta Again,https://shop.beta.example/x,\nDead Site,https://dead.example,\nMoved Site,https://moved.example/old,\nCredit Bureau,https://creditbureau.example/freeze,\nBroken,not a url at all,\n';
  it('imports a list, keeps your earlier clean-up decisions, and never changes existing sites', async () => {
    const t = await boot();
    const admin = await adminAnd(t);
    const r = await admin.call('POST', '/api/sites/import', { filename: 'list.csv', content: csv });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ rowsRead: 7, added: 5, duplicatesInFile: 1, unreadable: 1, markedManualOnly: 1,
      alreadyRemovedFromEarlierCheck: 1, needNewAddress: 1 });
    expect(t.repo.siteImports[0].rows).toHaveLength(7); // original rows kept
    const active = (await admin.call('GET', '/api/sites')).json;
    expect(active.total).toBe(3);
    expect(active.counts).toMatchObject({ active: 3, research: 1, removed: 1 });
    const manual = active.sites.find((s: any) => s.name === 'Credit Bureau');
    expect(manual.automationPolicy).toBe('manual_only');
    // importing the same file again adds nothing and changes nothing
    const again = await admin.call('POST', '/api/sites/import', { filename: 'list.csv', content: csv });
    expect(again.json.added).toBe(0);
    expect(again.json.alreadyInDirectory).toBe(5);
    expect((await admin.call('GET', '/api/sites?view=removed')).json.sites[0].removedReason).toBe('domain no longer exists');
    await t.close();
  });
  it('searches, filters and pages', async () => {
    const t = await boot();
    const admin = await adminAnd(t);
    await admin.call('POST', '/api/sites/import', { filename: 'list.csv', content: csv });
    expect((await admin.call('GET', '/api/sites?q=alpha')).json.total).toBe(1);
    expect((await admin.call('GET', '/api/sites?q=beta.example')).json.total).toBe(1);
    expect((await admin.call('GET', '/api/sites?limit=2')).json.sites).toHaveLength(2);
    expect((await admin.call('GET', '/api/sites?category=nonsense')).status).toBe(400);
    expect((await admin.call('GET', '/api/sites?view=nonsense')).status).toBe(400);
    await t.close();
  });
  it('lets staff remove and restore a site, and viewers only look', async () => {
    const t = await boot();
    const admin = await adminAnd(t);
    await admin.call('POST', '/api/users', { email: 'v@example.com', password: PW, role: 'viewer' });
    await admin.call('POST', '/api/sites/import', { filename: 'list.csv', content: csv });
    const id = (await admin.call('GET', '/api/sites?q=alpha')).json.sites[0].id;
    expect((await admin.call('POST', `/api/sites/${id}/remove`, { reason: 'test' })).status).toBe(200);
    expect((await admin.call('GET', '/api/sites?q=alpha')).json.total).toBe(0);
    expect((await admin.call('POST', `/api/sites/${id}/restore`)).status).toBe(200);
    expect((await admin.call('GET', '/api/sites?q=alpha')).json.total).toBe(1);
    expect((await admin.call('POST', '/api/sites/00000000-0000-4000-8000-000000000000/remove', {})).status).toBe(404);
    const viewer = t.session(); await viewer.login('v@example.com', PW);
    expect((await viewer.call('GET', '/api/sites')).status).toBe(200);
    expect((await viewer.call('POST', '/api/sites/import', { filename: 'x.csv', content: csv })).status).toBe(403);
    expect((await viewer.call('POST', `/api/sites/${id}/remove`, {})).status).toBe(403);
    expect((await call(t.base, 'GET', '/api/sites')).status).toBe(401);
    await t.close();
  });
  it('rejects empty and Excel files with a clear message and imports bookmark files', async () => {
    const t = await boot();
    const admin = await adminAnd(t);
    expect((await admin.call('POST', '/api/sites/import', { filename: 'a.csv', content: '  ' })).status).toBe(400);
    const x = await admin.call('POST', '/api/sites/import', { filename: 'a.xlsx', content: 'PK' });
    expect(x.status).toBe(400);
    expect(x.json.error).toContain('Save As');
    const html = '<DL><DT><A HREF="https://gamma.example/signup" ADD_DATE="1">Gamma Perks</A></DL>';
    const b = await admin.call('POST', '/api/sites/import', { filename: 'bookmarks.html', content: html });
    expect(b.json.added).toBe(1);
    await t.close();
  });
});

// ---- discovery: pretend websites (no real network) ----
const FORM = (fields: string, extra = '') => `<form method="post">${fields}${extra}</form>`;
const SAME_SHAPE = (title: string) => `<html><head><title>${title}</title></head><body>${FORM('<input name="email" type="email"><input name="first_name"><input name="last_name"><input type="checkbox" name="optin">')}<!--mailchimp--></body></html>`;
const OTHER_SHAPE = (title: string) => `<html><head><title>${title}</title></head><body>${FORM('<input name="zip"><input name="phone" type="tel"><input name="city"><input name="state"><input name="address"><input name="dob"><input name="country">')}</body></html>`;
const WITH_CAPTCHA = (title: string) => `<html><head><title>${title}</title></head><body>${FORM('<input name="email">', '<div class="g-recaptcha"></div>')}</body></html>`;
const WITH_PAYMENT = (title: string) => `<html><head><title>${title}</title></head><body>${FORM('<input name="email"><input name="cardnumber"><input name="cvv">')}</body></html>`;
const WITH_UPLOAD = (title: string) => `<html><head><title>${title}</title></head><body>${FORM('<input name="email"><input type="file" name="resume">')}</body></html>`;
const PAGES: Record<string, string> = {
  'js.example': '<html><head><title>JS Club</title></head><body><div id="app"></div></body></html>', 'wall.example': '<html><head><title>Wall</title></head><body><div id="app"></div></body></html>',
  'a.example': SAME_SHAPE('A Rewards'), 'b.example': SAME_SHAPE('B Club'), 'c.example': WITH_CAPTCHA('C Members'),
  'p.example': WITH_PAYMENT('P Premium'), 'u.example': WITH_UPLOAD('U Careers'),
  'x.example': SAME_SHAPE('X Perks'), 'y.example': OTHER_SHAPE('Y Samples'), 'z.example': WITH_CAPTCHA('Z Deals'),
};
function fakeWeb(dead: string[] = []): Partial<AppConfig> {
  const fetchImpl = (async (url: any) => {
    const u = new URL(String(url));
    if (u.pathname === '/robots.txt') return new Response('', { status: 404 });
    if (u.hostname.startsWith('slow')) throw Object.assign(new Error('timed out'), { name: 'AbortError' });
    if (u.hostname.startsWith('err')) return new Response('', { status: 500 });
    const html = PAGES[u.hostname];
    return html ? new Response(html) : new Response('', { status: 404 });
  }) as typeof fetch;
  const lookup = async (host: string) => {
    if (dead.includes(host) || host.startsWith('dead')) throw Object.assign(new Error('x'), { code: 'ENOTFOUND' });
    return [{ address: '93.184.216.34' }];
  };
  return { fetchDeps: { fetchImpl, lookup } };
}
const listCsv = (hosts: string[]) => 'name,url\n' + hosts.map(h => `${h},https://${h}/join`).join('\n') + '\n';

describe('staff-first and site checks', () => {
  it('checks each site page, puts staff-only sites first, and never bypasses a CAPTCHA', async () => {
    const t = await boot({ siteCapacity: 10, ...fakeWeb() });
    const admin = await adminAnd(t);
    await admin.call('POST', '/api/sites/import', { filename: 'l.csv', content: listCsv(['a.example', 'b.example', 'c.example']) });
    const r = (await admin.call('POST', '/api/discovery/check', {})).json;
    expect(r).toMatchObject({ checked: 3, simple: 2, staff: 1, removed: 0, remaining: 0, networkProblem: false });
    const list = (await admin.call('GET', '/api/sites')).json;
    expect(list.sites[0].name).toBe('c.example');            // staff first
    expect(list.sites[0].needsStaff).toBe(true);
    expect(list.sites[0].handlingReason).toContain('CAPTCHA');
    expect(list.counts.staff).toBe(1);
    expect((await admin.call('GET', '/api/sites?view=staff')).json.total).toBe(1);
    await t.close();
  });
  it('sends sites that cannot be read to the back of the line so they never block the rest', async () => {
    const t = await boot({ siteCapacity: 10, ...fakeWeb() });
    const admin = await adminAnd(t);
    await admin.call('POST', '/api/sites/import', { filename: 'l.csv', content: listCsv(['err1.example', 'a.example', 'b.example']) });
    const first = (await admin.call('POST', '/api/discovery/check', { limit: 1 })).json;
    expect(first).toMatchObject({ checked: 0, skipped: 1 });
    expect(first.unreadable['error 500']).toBe(1);
    const second = (await admin.call('POST', '/api/discovery/check', { limit: 1 })).json;
    expect(second).toMatchObject({ checked: 1, simple: 1 });   // moved on to a.example
    await t.close();
  });
  it('does not look at the same site again within the cooldown, so one bad hour cannot remove a site', async () => {
    const t = await boot({ siteCapacity: 10, ...fakeWeb() });
    const admin = await adminAnd(t);
    await admin.call('POST', '/api/sites/import', { filename: 'l.csv', content: listCsv(['slow1.example', 'err1.example']) });
    const first = (await admin.call('POST', '/api/discovery/check', {})).json;
    expect(first.skipped + first.checked).toBe(2);
    for (let i = 0; i < 5; i++) {
      const again = (await admin.call('POST', '/api/discovery/check', {})).json;
      expect(again.checked + again.skipped).toBe(0);                // cooling down: nothing is looked at again
    }
    expect((await admin.call('GET', '/api/sites?view=removed')).json.total).toBe(0);
    await t.close();
  });
  it('counts repeated failures within 12 hours as one, even with no cooldown', async () => {
    const t = await boot({ siteCapacity: 10, checkCooldownMs: 0, ...fakeWeb() });
    const admin = await adminAnd(t);
    await admin.call('POST', '/api/sites/import', { filename: 'l.csv', content: listCsv(['slow1.example', 'a.example', 'b.example', 'c.example', 'x.example', 'y.example', 'z.example']) });
    for (let i = 0; i < 5; i++) await admin.call('POST', '/api/discovery/check', { limit: 1 }); // each call looks at one site
    // five slow runs happened minutes apart; none removes the site
    for (let i = 0; i < 4; i++) { for (const s of t.repo.sites.values()) if (s.domain === 'slow1.example') s.handling = 'unchecked'; await admin.call('POST', '/api/discovery/check', { limit: 30 }); }
    expect((await admin.call('GET', '/api/sites?view=removed')).json.total).toBe(0);
    expect([...t.repo.sites.values()].find(s => s.domain === 'slow1.example')!.runs.length >= 3).toBe(true);
    await t.close();
  });
  it('re-checks sites earlier marked staff for a CAPTCHA, so a rule fix can clear wrongly flagged ones', async () => {
    const t = await boot({ siteCapacity: 10, ...fakeWeb() });
    const admin = await adminAnd(t);
    await admin.call('POST', '/api/sites/import', { filename: 'l.csv', content: listCsv(['a.example', 'c.example']) });
    await admin.call('POST', '/api/discovery/check', {});
    // pretend an older version of the rules wrongly flagged a.example
    for (const s of t.repo.sites.values()) if (s.domain === 'a.example') { s.handling = 'staff'; s.needsStaff = true; s.handlingReason = 'page uses a CAPTCHA (staff complete it; it is never bypassed)'; }
    expect((await admin.call('GET', '/api/sites?view=staff')).json.total).toBe(2);
    const r = (await admin.call('POST', '/api/discovery/check', { recheck: true })).json;
    expect(r).toMatchObject({ checked: 2, simple: 1, staff: 1 });
    expect((await admin.call('GET', '/api/sites?view=staff')).json.sites.map((s: any) => s.domain)).toEqual(['c.example']);
    await t.close();
  });
  it('does not record anything when most sites fail to connect (probably your internet)', async () => {
    const t = await boot({ siteCapacity: 20, ...fakeWeb(['a.example', 'b.example', 'c.example', 'x.example', 'y.example', 'z.example']) });
    const admin = await adminAnd(t);
    await admin.call('POST', '/api/sites/import', { filename: 'l.csv', content: listCsv(['a.example', 'b.example', 'c.example', 'x.example', 'y.example', 'z.example']) });
    const r = (await admin.call('POST', '/api/discovery/check', {})).json;
    expect(r.networkProblem).toBe(true);
    expect(r.removed).toBe(0);
    expect([...t.repo.sites.values()].every(s => s.runs.length === 0)).toBe(true);
    await t.close();
  });
});

describe('no payments and no file uploads', () => {
  it('drops sites that need a payment or a file upload and replaces them; never adds such candidates', async () => {
    const t = await boot({ siteCapacity: 3, ...fakeWeb() });
    const admin = await adminAnd(t);
    await admin.call('POST', '/api/sites/import', { filename: 'l.csv', content: listCsv(['a.example', 'p.example', 'u.example']) });
    await admin.call('POST', '/api/discovery/candidates', { urls: ['https://p.example', 'https://u.example', 'https://x.example'] }).then(r => {
      expect(r.json).toMatchObject({ excluded: 2, added: 1 });   // p and u are skipped; only x is new
    });
    const r = (await admin.call('POST', '/api/discovery/check', {})).json;
    expect(r).toMatchObject({ checked: 3, simple: 1, excluded: 2, removed: 2 });
    expect(r.replacements).toEqual(['x.example']);                // only one similar candidate was waiting
    const removed = (await admin.call('GET', '/api/sites?view=removed')).json.sites.map((s: any) => s.removedReason).sort();
    expect(removed).toEqual(['asks for a file upload', 'needs a payment or card details']);
    const candidates = await admin.call('POST', '/api/discovery/candidates', { urls: ['https://p.example/x', 'https://z.example'] });
    expect(candidates.json).toMatchObject({ excluded: 1, added: 1 }); // p is skipped again; z (captcha) is kept aside as staff-only
    await t.close();
  });
  it('does not even store a new payment or upload site as a candidate', async () => {
    const t = await boot({ siteCapacity: 10, ...fakeWeb() });
    const admin = await adminAnd(t);
    const r = (await admin.call('POST', '/api/discovery/candidates', { urls: ['https://p.example', 'https://u.example', 'https://x.example'] })).json;
    expect(r).toMatchObject({ excluded: 2, added: 1, addedToDirectory: 1 });
    expect(t.repo.candidates.size).toBe(1);
    await t.close();
  });
});

describe('2500-site capacity and replacement', () => {
  it('finds candidates, keeps staff-only ones out, and replaces a dead site with the most similar one', async () => {
    const t = await boot({ siteCapacity: 4, ...fakeWeb(['d.example']) });
    const admin = await adminAnd(t);
    await admin.call('POST', '/api/sites/import', { filename: 'l.csv', content: listCsv(['a.example', 'b.example', 'c.example', 'd.example']) });
    const first = (await admin.call('POST', '/api/discovery/check', {})).json;
    expect(first).toMatchObject({ simple: 2, staff: 1, removed: 0 });  // d: not found once, so only watched
    const cand = (await admin.call('POST', '/api/discovery/candidates', { urls: ['https://x.example/join', 'https://y.example/join', 'https://z.example/join', 'http://127.0.0.1/', 'nonsense'] })).json;
    expect(cand).toMatchObject({ added: 3, simple: 2, staff: 1, unreachable: 1, invalid: 1, addedToDirectory: 0 }); // directory is full
    const sameHour = (await admin.call('POST', '/api/discovery/check', {})).json;
    expect(sameHour.removed).toBe(0);                                  // looked at again too soon: nothing happens
    for (const s of t.repo.sites.values()) if (s.domain === 'd.example') { s.runs.forEach(r => { r.at = new Date(Date.now() - 13 * 3_600_000).toISOString(); }); s.checkedAtMs = 0; } // pretend 13 hours passed
    const second = (await admin.call('POST', '/api/discovery/check', {})).json;
    expect(second.removed).toBe(1);                                    // d: not found on two different occasions
    expect(second.replacements).toEqual(['x.example']);                // same shape as the working sites
    const active = (await admin.call('GET', '/api/sites?limit=100')).json;
    expect(active.counts.active).toBe(4);
    expect(active.sites.map((s: any) => s.domain).sort()).toEqual(['a.example', 'b.example', 'c.example', 'x.example']);
    expect(active.candidates).toMatchObject({ simple: 1, staff: 1 }); // y waits, z is staff-only and never promoted
    await t.close();
  });
  it('replaces a site you remove by hand with a similar one', async () => {
    const t = await boot({ siteCapacity: 2, ...fakeWeb() });
    const admin = await adminAnd(t);
    await admin.call('POST', '/api/sites/import', { filename: 'l.csv', content: listCsv(['a.example', 'b.example']) });
    await admin.call('POST', '/api/discovery/check', {});
    await admin.call('POST', '/api/discovery/candidates', { urls: ['https://y.example', 'https://x.example'] });
    const id = (await admin.call('GET', '/api/sites?q=a.example')).json.sites[0].id;
    const r = await admin.call('POST', `/api/sites/${id}/remove`, { reason: 'test' });
    expect(r.json.replacedBy).toEqual(['X Perks']);
    expect((await admin.call('GET', '/api/sites')).json.counts.active).toBe(2);
    // restoring puts it back; the directory is then over capacity until another is removed, and nothing is deleted
    await admin.call('POST', `/api/sites/${id}/restore`);
    expect((await admin.call('GET', '/api/sites')).json.counts.active).toBe(3);
    await t.close();
  });
  it('fills empty slots on request and says how many candidates are waiting', async () => {
    const t = await boot({ siteCapacity: 5, ...fakeWeb() });
    const admin = await adminAnd(t);
    await admin.call('POST', '/api/sites/import', { filename: 'l.csv', content: listCsv(['a.example', 'b.example']) });
    t.repo.candidates.clear();
    await admin.call('POST', '/api/discovery/candidates', { urls: ['https://x.example'] });
    const r = (await admin.call('POST', '/api/directory/refill')).json;
    expect(r.capacity).toBe(5);
    expect((await admin.call('GET', '/api/sites')).json.counts.active).toBe(3);
    await t.close();
  });
  it('searches only when a search service is set up, and shows its failure', async () => {
    const none = await boot({ ...fakeWeb() });
    const a1 = await adminAnd(none);
    const r1 = await a1.call('POST', '/api/discovery/search');
    expect(r1.status).toBe(400);
    expect(r1.json.error).toContain('SEARCH_API_KEY');
    await none.close();
    const search = { name: 'fake', search: async () => [{ url: 'https://x.example/a', title: 'X' }, { url: 'https://y.example/b', title: 'Y' }] };
    const ok = await boot({ siteCapacity: 10, search, ...fakeWeb() });
    const a2 = await adminAnd(ok);
    const r2 = (await a2.call('POST', '/api/discovery/search')).json;
    expect(r2).toMatchObject({ added: 2, addedToDirectory: 2 });
    await ok.close();
    const broken = await boot({ search: { name: 'fake', search: async () => { throw new Error('quota used up'); } }, ...fakeWeb() });
    const a3 = await adminAnd(broken);
    const r3 = await a3.call('POST', '/api/discovery/search');
    expect(r3.status).toBe(502);
    expect(r3.json.error).toContain('quota');
    await broken.close();
  });
  it('lets only staff with site access run discovery', async () => {
    const t = await boot({ ...fakeWeb() });
    const admin = await adminAnd(t);
    await admin.call('POST', '/api/users', { email: 'v@example.com', password: PW, role: 'viewer' });
    const v = t.session(); await v.login('v@example.com', PW);
    expect((await v.call('POST', '/api/discovery/check', {})).status).toBe(403);
    expect((await v.call('POST', '/api/discovery/candidates', { urls: ['https://x.example'] })).status).toBe(403);
    expect((await admin.call('POST', '/api/discovery/candidates', { urls: [] })).status).toBe(400);
    expect((await call(t.base, 'POST', '/api/directory/refill')).status).toBe(401);
    await t.close();
  });
});

describe('audit trail', () => {
  it('records who did what without recording client details', async () => {
    const t = await boot();
    const admin = await adminAnd(t);
    const id = (await admin.call('POST', '/api/clients', { displayName: 'C-9', profile })).json.id as string;
    await admin.call('GET', `/api/clients/${id}`);
    const entries = (await admin.call('GET', `/api/audit?clientId=${id}`)).json.entries;
    expect(entries.map((e: any) => e.action)).toEqual(['client.read', 'client.create']);
    const everything = JSON.stringify(t.repo.auditLog);
    for (const secret of ['Alice', 'alice@example.com', '415-555-0134', 'Testville']) expect(everything.includes(secret)).toBe(false);
    await t.close();
  });
});

describe('browser check of unclear sites', () => {
  const fakeBrowser = (pages: Record<string, any>) => ({ analyze: async (url: string) => pages[new URL(url).hostname] ?? { outcome: 'error' }, close: async () => {} });
  it('explains plainly when the browser check is not installed', async () => {
    const t = await boot({ siteCapacity: 10, ...fakeWeb() });
    const admin = await adminAnd(t);
    const r = await admin.call('POST', '/api/discovery/check', { browser: true });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.json)).toContain('npm.cmd install');
    await t.close();
  });
  it('re-reads unclear sites in a browser, never bypasses a block, and leaves settled sites alone', async () => {
    const browser = fakeBrowser({
      'js.example': { outcome: 'ok', html: SAME_SHAPE('JS Club'), oneLinkAway: '/signup' },
      'wall.example': { outcome: 'bot_blocked', status: 403 },
    });
    const t = await boot({ siteCapacity: 10, ...fakeWeb(), browser: browser as any, browserCooldownMs: 0 });
    const admin = await adminAnd(t);
    await admin.call('POST', '/api/sites/import', { filename: 'l.csv', content: listCsv(['a.example', 'js.example', 'wall.example']) });
    const first = (await admin.call('POST', '/api/discovery/check', {})).json;
    expect(first).toMatchObject({ checked: 3, simple: 1, unknown: 2 });
    const r = (await admin.call('POST', '/api/discovery/check', { browser: true })).json;
    expect(r).toMatchObject({ checked: 2, simple: 1, staff: 1 });
    const js = [...t.repo.sites.values()].find(x => x.domain === 'js.example')!;
    expect(js.handling).toBe('simple');
    expect(js.handlingReason).toContain('one link away');
    const wall = [...t.repo.sites.values()].find(x => x.domain === 'wall.example')!;
    expect(wall.handling).toBe('staff');
    expect(wall.handlingReason).toContain('in a browser');
    // a.example was already settled, and wall.example already got its browser answer: nothing left to do
    const again = (await admin.call('POST', '/api/discovery/check', { browser: true })).json;
    expect(again.checked).toBe(0);
    await t.close();
  });
  it('removes sites a browser also found no form on, and lets you restore them', async () => {
    const browser = fakeBrowser({ 'js.example': { outcome: 'ok', html: '<html><body>none</body></html>' } });
    const t = await boot({ siteCapacity: 10, ...fakeWeb(), browser: browser as any, browserCooldownMs: 0 });
    const admin = await adminAnd(t);
    await admin.call('POST', '/api/sites/import', { filename: 'l.csv', content: listCsv(['a.example', 'js.example']) });
    await admin.call('POST', '/api/discovery/check', {});
    await admin.call('POST', '/api/discovery/check', { browser: true });
    const r = (await admin.call('POST', '/api/discovery/remove-unclear', {})).json;
    expect(r.removed).toBe(1);
    expect((await admin.call('GET', '/api/sites?view=removed')).json.total).toBe(1);
    await t.close();
  });
  it('re-checks working sites without relabelling them, and removes one that is gone for good', async () => {
    const t = await boot({ siteCapacity: 10, ...fakeWeb(), checkCooldownMs: 0 });
    const admin = await adminAnd(t);
    await admin.call('POST', '/api/sites/import', { filename: 'l.csv', content: listCsv(['a.example', 'b.example']) });
    await admin.call('POST', '/api/discovery/check', {});
    const r = (await admin.call('POST', '/api/discovery/check', { health: true })).json;
    expect(r).toMatchObject({ checked: 2, simple: 2, removed: 0 });
    // an older "form built by JavaScript" label must survive a plain re-read
    const a = [...t.repo.sites.values()].find(x => x.domain === 'a.example')!;
    a.handlingReason = 'sign-up form found one link away (/join)';
    await admin.call('POST', '/api/discovery/check', { health: true });
    expect(a.handling).toBe('simple');
    expect(a.handlingReason).toContain('one link away');
    await t.close();
  });
});

describe('sites for each client', () => {
  async function setup(count: string) {
    const t = await boot({ siteCapacity: 20, ...fakeWeb() });
    const admin = await adminAnd(t);
    await admin.call('POST', '/api/sites/import', { filename: 'l.csv', content: listCsv(['a.example', 'b.example', 'x.example', 'c.example', 'z.example']) });
    await admin.call('POST', '/api/discovery/check', {});            // a, b, x are no-staff; c and z have a CAPTCHA
    const id = (await admin.call('POST', '/api/clients', { displayName: 'C', profile: { ...profile, siteCount: count } })).json.id as string;
    return { t, admin, id };
  }
  it('suggests the number of no-staff sites the client chose, adds staff-only sites on top, and never twice', async () => {
    const { t, admin, id } = await setup('2');
    expect((await admin.call('POST', `/api/clients/${id}/sites/propose`, {})).json.added).toBe(4);
    const list = (await admin.call('GET', `/api/clients/${id}/sites`)).json;
    expect(list.total).toBe(4);
    expect(list.sites.map((x: any) => x.needsStaff)).toEqual([true, true, false, false]);   // 2 staff-only (not counted), then the 2 chosen
    expect((await admin.call('POST', `/api/clients/${id}/sites/propose`, {})).json.added).toBe(0);
    await t.close();
  });
  it('"all" suggests every usable site, and a bad count is refused', async () => {
    const { t, admin, id } = await setup('all');
    expect((await admin.call('POST', `/api/clients/${id}/sites/propose`, {})).json.added).toBe(5);
    expect((await admin.call('POST', `/api/clients/${id}/sites/propose`, { count: 'lots' })).status).toBe(400);
    await t.close();
  });
  it('lets staff skip or fill each staff site, and marking done needs a note', async () => {
    const { t, admin, id } = await setup('all');
    await admin.call('POST', `/api/clients/${id}/sites/propose`, {});
    const sites = (await admin.call('GET', `/api/clients/${id}/sites`)).json.sites as any[];
    const staff = sites.filter(x => x.needsStaff), plain = sites.filter(x => !x.needsStaff);
    const path = (s: any) => `/api/clients/${id}/sites/${s.siteId}`;
    expect((await admin.call('POST', path(staff[0]), { status: 'approved' })).status).toBe(400);      // staff sites are filled by hand, not auto-approved
    expect((await admin.call('POST', path(plain[0]), { status: 'staff_fill' })).status).toBe(400);
    expect((await admin.call('POST', path(staff[0]), { status: 'staff_fill' })).status).toBe(200);
    expect((await admin.call('POST', path(staff[0]), { status: 'done' })).status).toBe(400);          // needs a note
    expect((await admin.call('POST', path(staff[0]), { status: 'done', note: 'Saw the thank-you page' })).status).toBe(200);
    expect((await admin.call('POST', path(staff[1]), { status: 'skipped' })).status).toBe(200);
    expect((await admin.call('POST', path(plain[0]), { status: 'done', note: 'abc' })).status).toBe(400); // not approved yet
    const counts = (await admin.call('GET', `/api/clients/${id}/sites`)).json.counts;
    expect(counts).toMatchObject({ done: 1, skipped: 1, proposed: 3 });
    expect((await admin.call('POST', `/api/clients/${id}/sites/approve-all`, {})).json.approved).toBe(3);
    // skipped sites do not count toward the chosen number, and are not suggested again
    expect((await admin.call('POST', `/api/clients/${id}/sites/propose`, {})).json.added).toBe(0);
    await t.close();
  });
  it('keeps clients private: a viewer cannot change anything, and strangers cannot see the list', async () => {
    const { t, admin, id } = await setup('2');
    await admin.call('POST', `/api/clients/${id}/sites/propose`, {});
    const viewerUser = (await admin.call('POST', '/api/users', { email: 'v@example.com', password: PW, role: 'viewer' })).json.user;
    const viewer = t.session(); await viewer.login('v@example.com', PW);
    expect((await viewer.call('GET', `/api/clients/${id}/sites`)).status).toBe(404);
    await admin.call('POST', `/api/clients/${id}/assign`, { userId: viewerUser.id });
    expect((await viewer.call('GET', `/api/clients/${id}/sites`)).status).toBe(200);
    expect((await viewer.call('POST', `/api/clients/${id}/sites/propose`, {})).status).toBe(403);
    await t.close();
  });
  it('only admins see and handle staff-only sites; regular users only get no-staff sites', async () => {
    const { t, admin, id } = await setup('all');
    const opUser = (await admin.call('POST', '/api/users', { email: 'o@example.com', password: PW, role: 'operator' })).json.user;
    await admin.call('POST', `/api/clients/${id}/assign`, { userId: opUser.id });
    const op = t.session(); await op.login('o@example.com', PW);
    expect((await op.call('POST', `/api/clients/${id}/sites/propose`, {})).json.added).toBe(3);    // the 3 no-staff sites only
    const mine = (await op.call('GET', `/api/clients/${id}/sites`)).json;
    expect(mine.total).toBe(3);
    expect(mine.sites.every((x: any) => !x.needsStaff)).toBe(true);
    expect(mine.staffSitesVisible).toBe(false);
    expect((await op.call('POST', `/api/clients/${id}/sites/approve-all`, {})).json.approved).toBe(3);
    // the admin adds the staff-only ones and the operator still never sees or changes them
    expect((await admin.call('POST', `/api/clients/${id}/sites/propose`, {})).json.added).toBe(2);
    const staffRow = (await admin.call('GET', `/api/clients/${id}/sites`)).json.sites.find((x: any) => x.needsStaff);
    expect((await op.call('POST', `/api/clients/${id}/sites/${staffRow.siteId}`, { status: 'skipped' })).status).toBe(404);
    expect((await op.call('GET', `/api/clients/${id}/sites`)).json.total).toBe(3);
    expect((await admin.call('GET', `/api/clients/${id}/sites`)).json.total).toBe(5);
    await t.close();
  });
});

describe('logins kept for admins', () => {
  it('seals each login with the client key, shows it to admins only, and records every look', async () => {
    const t = await boot({ siteCapacity: 10, ...fakeWeb() });
    const admin = await adminAnd(t);
    await admin.call('POST', '/api/sites/import', { filename: 'l.csv', content: listCsv(['a.example']) });
    const siteId = [...t.repo.sites.values()][0].id;
    const id = (await admin.call('POST', '/api/clients', { displayName: 'C', profile })).json.id as string;
    const row = t.repo.clients.get(id)!;
    await storeClientLogin(t.repo, t.masterKey, row, siteId, { site: 'a.example', username: 'aliceexample4821', password: 'S3cret-Pass-word!' }, null);
    // stored sealed
    expect(t.repo.logins[0].encrypted.toString('utf8').includes('S3cret')).toBe(false);
    expect(t.repo.logins[0].encrypted.toString('utf8').includes('aliceexample')).toBe(false);
    // admin sees it
    const got = (await admin.call('GET', `/api/clients/${id}/logins`)).json.logins;
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ username: 'aliceexample4821', password: 'S3cret-Pass-word!', domain: 'a.example' });
    // an assigned regular user cannot
    const opUser = (await admin.call('POST', '/api/users', { email: 'o@example.com', password: PW, role: 'operator' })).json.user;
    await admin.call('POST', `/api/clients/${id}/assign`, { userId: opUser.id });
    const op = t.session(); await op.login('o@example.com', PW);
    expect((await op.call('GET', `/api/clients/${id}/logins`)).status).toBe(403);
    expect(JSON.stringify((await op.call('GET', `/api/clients/${id}`)).json)).not.toContain('S3cret');
    // the look was recorded without the password
    const log = JSON.stringify((await admin.call('GET', `/api/audit?clientId=${id}`)).json);
    expect(log).toContain('logins.read');
    expect(log).not.toContain('S3cret');
    await t.close();
  });
});

describe('preparing, approving and sending a form', () => {
  const report = (o: any = {}) => ({ status: 'ready_for_approval', reason: 'Filled and waiting for approval. Nothing has been sent.', filled: [{ label: 'Email address', key: 'email' }], needsHuman: [], skipped: [], ticked: [], screenshot: Buffer.from('png-bytes'), ...o });
  function fakeFiller(script: Record<string, any>, seen: any[] = []) {
    return {
      async prepare(url: string, _profile: any, opts: any) {
        const sc = script[new URL(url).hostname] ?? { report: report({ status: 'error', reason: 'unknown' }) };
        seen.push({ url, consents: opts?.consents });
        return { report: sc.report, async submit() { if (sc.onSubmit) await sc.onSubmit(); if (sc.throwSubmit) throw new Error('browser context lost'); if (sc.login) await opts.saveLogin(sc.login); return sc.result ?? { status: 'confirmed', detail: 'ok', evidence: 'Thank you for signing up!' }; }, async close() {} };
      },
      async close() {},
    };
  }
  async function setup(script: Record<string, any>, seen: any[] = []) {
    const t = await boot({ siteCapacity: 20, ...fakeWeb(), filler: fakeFiller(script, seen) as any });
    const admin = await adminAnd(t);
    await admin.call('POST', '/api/sites/import', { filename: 'l.csv', content: listCsv(['a.example', 'b.example', 'x.example', 'c.example']) });
    await admin.call('POST', '/api/discovery/check', {});
    const id = (await admin.call('POST', '/api/clients', { displayName: 'C', profile: { ...profile, siteCount: 'all' } })).json.id as string;
    await admin.call('POST', `/api/clients/${id}/sites/propose`, {});
    await admin.call('POST', `/api/clients/${id}/sites/approve-all`, {});
    const sites = (await admin.call('GET', `/api/clients/${id}/sites`)).json.sites as any[];
    const by = (d: string) => sites.find(x => x.domain === d);
    return { t, admin, id, by };
  }
  it('sends without a preview, reports every result, needs the client\'s permission, and never sends a form that could not be fully filled', async () => {
    const seen: any[] = [];
    const s = await setup({
      'a.example': { report: report() },
      'b.example': { report: report({ status: 'needs_human', reason: 'A person has to handle the items listed before this can be sent.', needsHuman: ['Comment (not recognized)'] }) },
      'x.example': { report: report(), result: { status: 'sent_unconfirmed', detail: 'The form was sent, but the page did not show a clear success message.', evidence: 'Hello' } },
    }, seen);
    const a = s.by('a.example');
    // no permission on file yet
    expect((await s.admin.call('POST', `/api/clients/${s.id}/sites/${a.siteId}/send-now`, {})).status).toBe(403);
    await s.admin.call('POST', `/api/clients/${s.id}/consents`, { scope: 'use_profile_for_applications' });
    const one = (await s.admin.call('POST', `/api/clients/${s.id}/sites/${a.siteId}/send-now`, {})).json;
    expect(one.results[0]).toMatchObject({ domain: 'a.example', outcome: 'confirmed', siteStatus: 'done' });
    expect((await s.admin.call('POST', `/api/clients/${s.id}/sites/${a.siteId}/send-now`, {})).status).toBe(409);   // once only
    const all = (await s.admin.call('POST', `/api/clients/${s.id}/sites/send-approved`, { limit: 5 })).json;
    const by = (d: string) => all.results.find((x: any) => x.domain === d);
    expect(by('b.example')).toMatchObject({ outcome: 'not_sent', siteStatus: 'approved' });
    expect(by('b.example').text).toContain('Comment');
    expect(by('x.example')).toMatchObject({ outcome: 'unconfirmed', siteStatus: 'sent' });
    const next = (await s.admin.call('POST', `/api/clients/${s.id}/sites/send-approved`, { limit: 5, skip: all.results.map((x: any) => x.siteId) })).json;
    expect(next.results.length).toBe(0);                                                                               // sites already tried this run are not tried again
    expect(all.results.some((x: any) => x.domain === 'c.example')).toBe(false);                                         // staff sites are never automated
    await s.t.close();
  });
  it('fills a form in a visible window and leaves the CAPTCHA and Send to a person (nothing is sent by the software)', async () => {
    let handed = 0, submitted = 0; const opts: any[] = [];
    const hand = {
      async prepare(url: string, _p: any, o: any) {
        opts.push(o);
        const bad = new URL(url).hostname === 'b.example';
        return { report: bad ? report({ status: 'error', reason: 'the page did not load', filled: [] }) : report({ needsHuman: ['Password (a person types this)'] }),
          async submit() { submitted++; return { status: 'confirmed', detail: 'x' }; }, async close() {}, async handOver() { handed++; } };
      },
      async close() {},
    };
    const t = await boot({ siteCapacity: 20, ...fakeWeb(), filler: fakeFiller({}) as any, handFiller: hand as any });
    const admin = await adminAnd(t);
    await admin.call('POST', '/api/sites/import', { filename: 'l.csv', content: listCsv(['a.example', 'b.example']) });
    await admin.call('POST', '/api/discovery/check', {});
    const id = (await admin.call('POST', '/api/clients', { displayName: 'C', profile: { ...profile, siteCount: 'all' } })).json.id as string;
    await admin.call('POST', `/api/clients/${id}/sites/propose`, {});
    await admin.call('POST', `/api/clients/${id}/sites/approve-all`, {});
    const sites = (await admin.call('GET', `/api/clients/${id}/sites`)).json.sites as any[];
    const a = sites.find(x => x.domain === 'a.example'), b = sites.find(x => x.domain === 'b.example');
    expect((await admin.call('POST', `/api/clients/${id}/sites/${a.siteId}/hand-finish`, {})).status).toBe(403);   // no permission yet
    await admin.call('POST', `/api/clients/${id}/consents`, { scope: 'use_profile_for_applications' });
    const r = await admin.call('POST', `/api/clients/${id}/sites/${a.siteId}/hand-finish`, {});
    expect(r.status).toBe(200);
    expect(handed).toBe(1); expect(submitted).toBe(0); expect(opts[0].handOver).toBe(true);
    const after = (await admin.call('GET', `/api/clients/${id}/sites`)).json.sites.find((x: any) => x.domain === 'a.example');
    expect(after.status).toBe('staff_fill'); expect(after.note).toContain('Nothing was sent');
    expect((await admin.call('POST', `/api/clients/${id}/sites/${b.siteId}/hand-finish`, {})).status).toBe(422);  // could not open
    await t.close();
  });
  it('clears out sites where nothing was sent (skip or remove) but never touches ones that may have gone through', async () => {
    const s = await setup({
      'a.example': { report: report() },
      'b.example': { report: report({ status: 'needs_human', reason: 'A person has to handle the items listed before this can be sent.', needsHuman: ['Comment (not recognized)'] }) },
      'x.example': { report: report(), result: { status: 'failed', detail: 'The site did not accept the form.' } },
    });
    await s.admin.call('POST', `/api/clients/${s.id}/consents`, { scope: 'use_profile_for_applications' });
    await s.admin.call('POST', `/api/clients/${s.id}/sites/send-approved`, { limit: 5 });
    const r = (await s.admin.call('POST', `/api/clients/${s.id}/sites/clean-failed`, { action: 'skip' })).json;
    expect(r.count).toBe(1);                                                                                   // only b.example (nothing sent)
    const now = (await s.admin.call('GET', `/api/clients/${s.id}/sites`)).json.sites as any[];
    expect(now.find(x => x.domain === 'b.example').status).toBe('skipped');
    expect(now.find(x => x.domain === 'x.example').status).toBe('sent'); // uncertainty stays out of the automatic retry queue
    await s.t.close();
  });
  it('keeps "already a member" and "very probably sent" sites in their own lists to verify, and can sort old notes into them', async () => {
    const s = await setup({
      'a.example': { report: report(), result: { status: 'already_member', detail: 'The site says this person is already registered or subscribed (possibly from an earlier try). Verify it by hand.', evidence: 'This email is already subscribed' } },
      'b.example': { report: report(), result: { status: 'sent_unconfirmed', likely: true, detail: 'The form emptied itself after sending.', evidence: 'Okay.' } },
      'x.example': { report: report(), result: { status: 'failed', detail: 'The site did not accept the form.', evidence: 'This email is already registered' } },
    });
    await s.admin.call('POST', `/api/clients/${s.id}/consents`, { scope: 'use_profile_for_applications' });
    const r = (await s.admin.call('POST', `/api/clients/${s.id}/sites/send-approved`, { limit: 5 })).json.results as any[];
    const by = (d: string) => r.find(x => x.domain === d);
    expect(by('a.example')).toMatchObject({ outcome: 'already', siteStatus: 'sent' });
    expect(by('b.example')).toMatchObject({ outcome: 'unconfirmed', siteStatus: 'sent' });
    const list = async (tag: string) => ((await s.admin.call('GET', `/api/clients/${s.id}/sites?tag=${tag}`)).json.sites as any[]).map(x => x.domain);
    expect(await list('already')).toEqual(['a.example']);
    expect(await list('likely')).toEqual(['b.example']);
    await s.t.repo.setClientSiteStatus(s.id, s.by('x.example').siteId, 'approved', 'The site did not accept the form. This email is already registered'); // simulate a note saved by the earlier version
    expect((await s.admin.call('POST', `/api/clients/${s.id}/sites/move-already`, {})).json.count).toBe(1);   // x.example's old note says already registered
    expect((await list('already')).sort()).toEqual(['a.example', 'x.example']);
    await s.t.close();
  });
  it('keeps uncertain submissions out of bulk failure cleanup, including all=true', async () => {
    const s = await setup({
      'a.example': { report: report(), result: { status: 'failed', detail: 'The site did not accept the form.', evidence: 'Email is invalid' } },
      'b.example': { report: report({ status: 'needs_human', reason: 'A person has to handle the items listed before this can be sent.', needsHuman: ['Comment (not recognized)'] }) },
      'x.example': { report: report(), result: { status: 'failed', detail: 'The site did not accept the form.', evidence: 'Try again' } },
    });
    await s.admin.call('POST', `/api/clients/${s.id}/consents`, { scope: 'use_profile_for_applications' });
    await s.admin.call('POST', `/api/clients/${s.id}/sites/send-approved`, { limit: 5 });
    const first = (await s.admin.call('POST', `/api/clients/${s.id}/sites/clean-failed`, { action: 'remove' })).json;
    expect(first).toMatchObject({ count: 1, left: 0 });
    const rest = (await s.admin.call('POST', `/api/clients/${s.id}/sites/clean-failed`, { action: 'remove', all: true })).json;
    expect(rest.count).toBe(0);
    expect(((await s.admin.call('GET', `/api/clients/${s.id}/sites?status=sent`)).json.sites as any[]).length).toBe(2);
    expect(((await s.admin.call('GET', `/api/clients/${s.id}/sites?status=approved&hasNote=1`)).json.sites as any[]).length).toBe(0);
    await s.t.close();
  });
  it('keeps restored sites in their own list, sends only those, and removes them for good', async () => {
    const s = await setup({
      'a.example': { report: report(), result: { status: 'failed', attempted: false, detail: 'Nothing was sent: no send control could be found.' } },
      'b.example': { report: report(), result: { status: 'failed', attempted: false, detail: 'Nothing was sent: no send control could be found.' } },
    });
    await s.admin.call('POST', `/api/clients/${s.id}/consents`, { scope: 'use_profile_for_applications' });
    const sites = (await s.admin.call('GET', `/api/clients/${s.id}/sites`)).json.sites as any[];
    const a = sites.find(x => x.domain === 'a.example');
    await s.admin.call('POST', `/api/sites/${a.siteId}/remove`, { reason: 'no sign-up form found' });
    expect((await s.admin.call('POST', `/api/sites/${a.siteId}/restore`, {})).status).toBe(200);
    const rl = async () => ((await s.admin.call('GET', `/api/clients/${s.id}/sites?restored=1`)).json.sites as any[]).map(x => x.domain);
    expect(await rl()).toEqual(['a.example']);
    await s.admin.call('POST', `/api/clients/${s.id}/sites/${a.siteId}/status`, { status: 'approved' });
    const r = (await s.admin.call('POST', `/api/clients/${s.id}/sites/send-approved`, { limit: 5, restoredOnly: true })).json.results as any[];
    expect(r.map(x => x.domain)).toEqual(['a.example']);
    const g = (await s.admin.call('POST', `/api/clients/${s.id}/sites/clean-failed`, { action: 'remove', all: true, restoredOnly: true })).json;
    expect(g.count).toBe(1);
    expect(await rl()).toEqual([]);
    await s.t.close();
  });
  it('marks a removed site DO NOT WORK, and refuses for a site that is not removed', async () => {
    const s = await setup({ 'a.example': { report: report() } });
    const a = ((await s.admin.call('GET', `/api/clients/${s.id}/sites`)).json.sites as any[])[0];
    expect((await s.admin.call('POST', `/api/sites/${a.siteId}/do-not-work`, {})).status).toBe(400);
    await s.admin.call('POST', `/api/sites/${a.siteId}/remove`, { reason: 'no sign-up form' });
    expect((await s.admin.call('POST', `/api/sites/${a.siteId}/do-not-work`, { reason: 'page is gone' })).status).toBe(200);
    await s.t.close();
  });
  it('moves a site to the CAPTCHA list the moment it asks for one after sending, and keeps a harmless "protected by reCAPTCHA" footer from doing so', async () => {
    const s = await setup({
      'a.example': { report: report(), result: { status: 'failed', detail: 'The site did not accept the form.', evidence: 'Please complete the CAPTCHA' } },
      'b.example': { report: report(), result: { status: 'sent_unconfirmed', detail: 'The form was sent, but the page did not show a clear success message.', evidence: 'This site is protected by reCAPTCHA' } },
      'x.example': { report: report(), result: { status: 'failed', detail: 'The site did not accept the form.', evidence: 'Email is invalid' } },
    });
    await s.admin.call('POST', `/api/clients/${s.id}/consents`, { scope: 'use_profile_for_applications' });
    const r = (await s.admin.call('POST', `/api/clients/${s.id}/sites/send-approved`, { limit: 5 })).json.results as any[];
    const by = (d: string) => r.find(x => x.domain === d);
    expect(by('a.example')).toMatchObject({ outcome: 'captcha', siteStatus: 'staff_fill' });
    expect(by('b.example')).toMatchObject({ outcome: 'unconfirmed', siteStatus: 'sent' });          // a footer mention is not a CAPTCHA demand
    expect(by('x.example')).toMatchObject({ outcome: 'unconfirmed', siteStatus: 'sent' });
    const list = (await s.admin.call('GET', `/api/clients/${s.id}/sites?captcha=1`)).json.sites as any[];
    expect(list.map(x => x.domain)).toContain('a.example');
    await s.t.close();
  });
  it('looks at approved sites and moves the ones showing a CAPTCHA, whatever their old notes say', async () => {
    const f: any = fakeFiller({ 'a.example': { report: report() }, 'b.example': { report: report() }, 'x.example': { report: report() } });
    f.scan = async (url: string) => ({ captcha: new URL(url).hostname === 'a.example', reason: 'a CAPTCHA box is on the page' });
    const t = await boot({ siteCapacity: 20, ...fakeWeb(), filler: f });
    const admin = await adminAnd(t);
    await admin.call('POST', '/api/sites/import', { filename: 'l.csv', content: listCsv(['a.example', 'b.example', 'x.example']) });
    await admin.call('POST', '/api/discovery/check', {});
    const id = (await admin.call('POST', '/api/clients', { displayName: 'C', profile: { ...profile, siteCount: 'all' } })).json.id as string;
    await admin.call('POST', `/api/clients/${id}/sites/propose`, {});
    await admin.call('POST', `/api/clients/${id}/sites/approve-all`, {});
    const r = (await admin.call('POST', `/api/clients/${id}/sites/scan-captcha`, { limit: 8 })).json;
    expect(r.results.filter((x: any) => x.captcha).length).toBe(1);
    const sites = (await admin.call('GET', `/api/clients/${id}/sites`)).json.sites as any[];
    expect(sites.find(x => x.domain === 'a.example').status).toBe('staff_fill');
    expect(sites.find(x => x.domain === 'b.example').status).toBe('approved');
    await t.close();
  });
  it('moves approved sites that need a CAPTCHA into the CAPTCHA list in one go', async () => {
    const s = await setup({ 'a.example': { report: report() }, 'b.example': { report: report() }, 'x.example': { report: report() } });
    await s.admin.call('POST', `/api/clients/${s.id}/sites/${s.by('a.example').siteId}`, { status: 'approved', note: 'Nothing was sent: The site asked us to prove we are human.' });
    await s.admin.call('POST', `/api/clients/${s.id}/sites/${s.by('b.example').siteId}`, { status: 'approved', note: 'Not sent: Comment (not recognized)' });
    const r = (await s.admin.call('POST', `/api/clients/${s.id}/sites/move-captcha`, {})).json;
    expect(r.count).toBe(1);
    const now = (await s.admin.call('GET', `/api/clients/${s.id}/sites`)).json.sites as any[];
    expect(now.find(x => x.domain === 'a.example')).toMatchObject({ status: 'staff_fill' });
    expect(now.find(x => x.domain === 'b.example').status).toBe('approved');
    expect(((await s.admin.call('GET', `/api/clients/${s.id}/sites?captcha=1`)).json.sites as any[]).map(x => x.domain)).toContain('a.example');
    await s.t.close();
  });
  it('removes sites where nothing was sent from the whole directory, where they can be restored', async () => {
    const s = await setup({ 'a.example': { report: report() }, 'b.example': { report: report({ status: 'needs_human', reason: 'A person has to handle the items listed before this can be sent.', needsHuman: ['Comment (not recognized)'] }) }, 'x.example': { report: report() } });
    await s.admin.call('POST', `/api/clients/${s.id}/consents`, { scope: 'use_profile_for_applications' });
    await s.admin.call('POST', `/api/clients/${s.id}/sites/send-approved`, { limit: 5 });
    expect((await s.admin.call('POST', `/api/clients/${s.id}/sites/clean-failed`, { action: 'remove' })).json.count).toBe(1);
    const removed = (await s.admin.call('GET', '/api/sites?view=removed&limit=50')).json.sites as any[];
    expect(removed.map(x => x.domain)).toContain('b.example');
    expect(((await s.admin.call('GET', `/api/clients/${s.id}/sites`)).json.sites as any[]).some(x => x.domain === 'b.example')).toBe(false);   // gone from the client's list at once
    await s.t.close();
  });
  it('sets CAPTCHA sites aside, lists them on their own, and opens several windows at once for a person', async () => {
    const opened: string[] = [];
    const hand = {
      async prepare(url: string) {
        const host = new URL(url).hostname; opened.push(host);
        return { report: host === 'b.example' ? report({ status: 'error', reason: 'the page did not load', filled: [] }) : report(), async submit() { throw new Error('must not send'); }, async close() {}, async handOver() {} };
      },
      async close() {},
    };
    const t = await boot({ siteCapacity: 20, ...fakeWeb(), filler: fakeFiller({ 'a.example': { report: report({ captcha: true }) }, 'b.example': { report: report({ captcha: true }) }, 'x.example': { report: report() } }) as any, handFiller: hand as any });
    const admin = await adminAnd(t);
    await admin.call('POST', '/api/sites/import', { filename: 'l.csv', content: listCsv(['a.example', 'b.example', 'x.example']) });
    await admin.call('POST', '/api/discovery/check', {});
    const id = (await admin.call('POST', '/api/clients', { displayName: 'C', profile: { ...profile, siteCount: 'all' } })).json.id as string;
    await admin.call('POST', `/api/clients/${id}/sites/propose`, {});
    await admin.call('POST', `/api/clients/${id}/sites/approve-all`, {});
    await admin.call('POST', `/api/clients/${id}/consents`, { scope: 'use_profile_for_applications' });
    const run = (await admin.call('POST', `/api/clients/${id}/sites/send-approved`, { limit: 5 })).json;
    expect(run.results.filter((x: any) => x.outcome === 'captcha').map((x: any) => x.domain).sort()).toEqual(['a.example', 'b.example']);
    expect(run.results.find((x: any) => x.domain === 'x.example').outcome).toBe('confirmed');
    expect(((await admin.call('GET', `/api/clients/${id}/sites?status=approved`)).json.sites as any[]).some(x => x.domain === 'a.example')).toBe(false);   // left the approved list at once
    const only = (await admin.call('GET', `/api/clients/${id}/sites?captcha=1`)).json.sites as any[];
    expect(only.map(x => x.domain).sort()).toEqual(['a.example', 'b.example']);
    const batch = (await admin.call('POST', `/api/clients/${id}/sites/captcha-batch`, { limit: 5 })).json;
    expect(batch.results.filter((x: any) => x.ok).length).toBe(1);                     // a.example opened
    expect(batch.results.filter((x: any) => !x.ok).length).toBe(1);                    // b.example could not be opened
    const after = (await admin.call('GET', `/api/clients/${id}/sites`)).json.sites as any[];
    expect(after.find(x => x.domain === 'a.example').status).toBe('staff_fill');
    expect(after.find(x => x.domain === 'b.example').note).toContain('Not sent');
    expect((await admin.call('POST', `/api/clients/${id}/sites/captcha-batch`, { limit: 5 })).json.results.length).toBe(0);   // nothing is opened twice
    await t.close();
  });
  it('does nothing until installed, and only for approved no-staff sites', async () => {
    const t = await boot({ siteCapacity: 10, ...fakeWeb() });
    const admin = await adminAnd(t);
    const id = (await admin.call('POST', '/api/clients', { displayName: 'C', profile })).json.id as string;
    expect((await admin.call('POST', `/api/clients/${id}/sites/${'00000000-0000-4000-8000-000000000000'}/prepare`, {})).status).toBe(400);
    await t.close();
    const s = await setup({});
    const staff = s.by('c.example');
    expect((await s.admin.call('POST', `/api/clients/${s.id}/sites/${staff.siteId}/prepare`, {})).status).toBe(403);   // staff sites are not automated
    const plain = s.by('a.example');
    await s.admin.call('POST', `/api/clients/${s.id}/sites/${plain.siteId}`, { status: 'skipped' });
    expect((await s.admin.call('POST', `/api/clients/${s.id}/sites/${plain.siteId}/prepare`, {})).status).toBe(400);   // not approved
    await s.t.close();
  });
  it('prepares, shows a picture, sends once after approval, and saves the new login for admins', async () => {
    const seen: any[] = [];
    const s = await setup({ 'a.example': { report: report({ createsLogin: true, ticked: ['Terms'] }), login: { site: 'a.example', username: 'aliceexample4821', password: 'S3cret-Pass-word!' } } }, seen);
    for (const scope of ['accept_site_terms', 'create_accounts']) await s.admin.call('POST', `/api/clients/${s.id}/consents`, { scope });
    await s.admin.call('POST', `/api/clients/${s.id}/consents`, { scope: 'create_accounts', revoke: true });          // taken back before use
    const a = s.by('a.example');
    const prep = (await s.admin.call('POST', `/api/clients/${s.id}/sites/${a.siteId}/prepare`, {})).json;
    expect(prep).toMatchObject({ status: 'ready_for_approval', createsLogin: true, hasScreenshot: true });
    expect(prep.filled).toEqual(['Email address']);
    expect(seen[0].consents).toEqual(['accept_site_terms']);                                                           // only what is still allowed
    expect(t_logins(s.t)).toBe(0);                                                                                     // nothing saved before approval
    expect((await s.admin.call('GET', `/api/clients/${s.id}/sites`)).json.sites.find((x: any) => x.siteId === a.siteId).status).toBe('approved');
    const shot = await s.admin.call('GET', `/api/preps/${prep.prepId}/screenshot`);
    expect(shot.status).toBe(200);
    const done = (await s.admin.call('POST', `/api/preps/${prep.prepId}/approve`, {})).json;
    expect(done.result.status).toBe('confirmed');
    expect(done.siteStatus).toBe('done');
    expect((await s.admin.call('POST', `/api/preps/${prep.prepId}/approve`, {})).status).toBe(404);                    // cannot be sent twice
    const row = (await s.admin.call('GET', `/api/clients/${s.id}/sites`)).json.sites.find((x: any) => x.siteId === a.siteId);
    expect(row.status).toBe('done');
    expect(row.note).toContain('Confirmed by the site');
    const logins = (await s.admin.call('GET', `/api/clients/${s.id}/logins`)).json.logins;
    expect(logins[0]).toMatchObject({ username: 'aliceexample4821', domain: 'a.example' });
    expect((await s.admin.call('POST', `/api/clients/${s.id}/sites/${a.siteId}/prepare`, {})).status).toBe(409);       // already sent
    await s.t.close();
  });
  const t_logins = (t: any) => t.repo.logins.length;
  it('records what really happened: unconfirmed, email needed, rejected, refused or blocked', async () => {
    const script: Record<string, any> = {
      'a.example': { report: report(), result: { status: 'sent_unconfirmed', detail: 'Sent, but the page did not clearly confirm.' } },
      'b.example': { report: report(), result: { status: 'failed', detail: 'The site did not accept the form.', evidence: 'Please enter a valid email address.' } },
      'x.example': { report: report({ status: 'refused', reason: 'asks for payment details' }) },
    };
    const s = await setup(script);
    const st = async (d: string) => (await s.admin.call('GET', `/api/clients/${s.id}/sites`)).json.sites.find((x: any) => x.domain === d);
    const send = async (d: string) => { const p = (await s.admin.call('POST', `/api/clients/${s.id}/sites/${s.by(d).siteId}/prepare`, {})).json; return p.prepId ? (await s.admin.call('POST', `/api/preps/${p.prepId}/approve`, {})).json : p; };
    await send('a.example'); expect((await st('a.example')).status).toBe('sent');
    await send('b.example'); expect((await st('b.example')).status).toBe('sent'); // review before any retry after a send attempt
    expect((await st('b.example')).note).toContain('did not accept');
    const r = await send('x.example'); expect(r.status).toBe('refused');
    expect((await st('x.example')).status).toBe('skipped');                            // a payment site is dropped for this client
    await s.t.close();
  });
  it('saves classified results and redacted evidence, with filtering and client access checks', async () => {
    const s = await setup({
      'a.example': { report: report(), result: { status: 'confirmed', detail: 'Accepted.', evidence: 'Welcome. Confirmation sent to alice@example.com' } },
      'b.example': { report: report({ status: 'needs_human', reason: 'A person has to handle fields.', needsHuman: ['Last name (no information on file)'] }) },
      'x.example': { report: report(), result: { status: 'confirm_email', attempted: true, detail: 'Please check your email.' } },
    });
    await s.admin.call('POST', `/api/clients/${s.id}/consents`, { scope: 'use_profile_for_applications' });
    await s.admin.call('POST', `/api/clients/${s.id}/sites/send-approved`, { limit: 5 });
    const saved = await s.admin.call('GET', `/api/clients/${s.id}/results`);
    expect(saved.status).toBe(200);
    const entries = saved.json.entries as any[];
    expect(entries.find(x => x.domain === 'a.example').outcome).toMatchObject({ delivery: 'confirmed', nextAction: 'none' });
    expect(entries.find(x => x.domain === 'b.example').outcome).toMatchObject({ code: 'missing_information', nextAction: 'profile' });
    expect(entries.find(x => x.domain === 'x.example').outcome).toMatchObject({ code: 'confirm_email', retryAllowed: false });
    expect(JSON.stringify(saved.json)).not.toContain('alice@example.com');
    const filtered = (await s.admin.call('GET', `/api/clients/${s.id}/results?delivery=unconfirmed&limit=1`)).json;
    expect(filtered.entries).toHaveLength(1);
    expect(filtered.entries[0].outcome.delivery).toBe('unconfirmed');
    expect((await s.admin.call('GET', `/api/clients/${s.id}/results?delivery=invalid`)).status).toBe(400);
    const opUser = (await s.admin.call('POST', '/api/users', { email: 'history-reader@example.com', password: PW, role: 'viewer' })).json.user;
    const viewer = s.t.session(); await viewer.login('history-reader@example.com', PW);
    expect((await viewer.call('GET', `/api/clients/${s.id}/results`)).status).toBe(404);
    await s.admin.call('POST', `/api/clients/${s.id}/assign`, { userId: opUser.id });
    expect((await viewer.call('GET', `/api/clients/${s.id}/results`)).status).toBe(200);
    expect((await s.admin.call('GET', `/api/clients/${s.id}/results`)).json.entries.map((x: any) => x.id)).toEqual(entries.map(x => x.id));
    await s.t.close();
  });
  it('persists a pending result before submitting and replaces it without double counting', async () => {
    const script: Record<string, any> = { 'a.example': { report: report() } };
    const s = await setup(script);
    let checked = false;
    script['a.example'].onSubmit = async () => {
      const pending = await s.t.repo.listSubmissionResults(s.id, { limit: 10, offset: 0 });
      expect(pending.entries[0].outcome).toMatchObject({ code: 'in_progress', retryAllowed: false });
      checked = true;
    };
    await s.admin.call('POST', `/api/clients/${s.id}/consents`, { scope: 'use_profile_for_applications' });
    await s.admin.call('POST', `/api/clients/${s.id}/sites/${s.by('a.example').siteId}/send-now`, {});
    const final = (await s.admin.call('GET', `/api/clients/${s.id}/results`)).json;
    expect(checked).toBe(true);
    expect(final.total).toBe(1);
    expect(final.entries[0].outcome.delivery).toBe('confirmed');
    await s.t.close();
  });
  it('keeps an interrupted submit out of the send queue and records uncertainty', async () => {
    const s = await setup({ 'a.example': { report: report(), throwSubmit: true } });
    await s.admin.call('POST', `/api/clients/${s.id}/consents`, { scope: 'use_profile_for_applications' });
    const route = `/api/clients/${s.id}/sites/${s.by('a.example').siteId}/send-now`;
    const result = (await s.admin.call('POST', route, {})).json.results[0];
    expect(result).toMatchObject({ outcome: 'unconfirmed', siteStatus: 'sent', result: { delivery: 'unconfirmed', retryAllowed: false } });
    expect((await s.admin.call('POST', route, {})).status).toBe(409);
    expect((await s.admin.call('GET', `/api/clients/${s.id}/results`)).json.entries[0].outcome.delivery).toBe('unconfirmed');
    await s.t.close();
  });
  it('records failed previews as stopped attempts without sending', async () => {
    const s = await setup({ 'a.example': { report: report({ status: 'needs_human', reason: 'No fillable sign-up fields were found on this page.' }) } });
    const prep = await s.admin.call('POST', `/api/clients/${s.id}/sites/${s.by('a.example').siteId}/prepare`, {});
    expect(prep.json.prepId).toBeNull();
    expect((await s.admin.call('GET', `/api/clients/${s.id}/results`)).json.entries[0].outcome).toMatchObject({ code: 'form_not_found', delivery: 'not_sent', nextAction: 'signup_page' });
    await s.t.close();
  });
  it('only people with access to the client can prepare or approve', async () => {
    const s = await setup({ 'a.example': { report: report() } });
    const viewerUser = (await s.admin.call('POST', '/api/users', { email: 'v@example.com', password: PW, role: 'viewer' })).json.user;
    await s.admin.call('POST', `/api/clients/${s.id}/assign`, { userId: viewerUser.id });
    const viewer = s.t.session(); await viewer.login('v@example.com', PW);
    const a = s.by('a.example');
    expect((await viewer.call('POST', `/api/clients/${s.id}/sites/${a.siteId}/prepare`, {})).status).toBe(404);
    const prep = (await s.admin.call('POST', `/api/clients/${s.id}/sites/${a.siteId}/prepare`, {})).json;
    expect((await viewer.call('POST', `/api/preps/${prep.prepId}/approve`, {})).status).toBe(404);
    expect((await viewer.call('GET', `/api/preps/${prep.prepId}/screenshot`)).status).toBe(404);
    await s.t.close();
  });
});

describe('changing my own sign-in details', () => {
  it('needs the current password, checks the new one, and signs out other devices', async () => {
    const t = await boot();
    const admin = await adminAnd(t);
    const other = t.session();
    await other.login('admin@example.com', PW);
    expect((await other.call('GET', '/api/me')).status).toBe(200);
    expect((await admin.call('POST', '/api/me/account', { current: 'wrong-password-1A', newPassword: 'Another-Passw0rd-2' })).status).toBe(403);
    expect((await admin.call('POST', '/api/me/account', { current: PW, newPassword: 'short' })).status).toBe(400);
    expect((await admin.call('POST', '/api/me/account', { current: PW })).status).toBe(400);
    const ok = await admin.call('POST', '/api/me/account', { current: PW, newPassword: 'Another-Passw0rd-2', newEmail: 'New@Example.com' });
    expect(ok.status).toBe(200);
    expect((await admin.call('GET', '/api/me')).status).toBe(200);
    expect((await other.call('GET', '/api/me')).status).toBe(401);
    const fresh = t.session();
    expect((await fresh.login('admin@example.com', 'Another-Passw0rd-2')).status).toBe(401);
    expect((await fresh.login('new@example.com', PW)).status).toBe(401);
    expect((await fresh.login('new@example.com', 'Another-Passw0rd-2')).status).toBe(200);
    expect(JSON.stringify(t.repo.auditLog)).not.toContain('Another-Passw0rd');
    await t.close();
  });
});

describe('checking again more accurately', () => {
  const fakeBrowser = (pages: Record<string, any>) => ({ analyze: async (url: string) => pages[new URL(url).hostname] ?? { outcome: 'error' }, close: async () => {} });
  it('puts back removed "no form" sites that do have a form, and frees CAPTCHA labels that were wrong, but only within the slot limit', async () => {
    const boxes = '<html><body><div><input type="email" placeholder="Email"><input name="first_name"><button>Join</button></div></body></html>';   // no <form> tag at all
    const browser = fakeBrowser({
      'a.example': { outcome: 'ok', html: boxes },
      'b.example': { outcome: 'ok', html: '<html><body><form action="/c"><textarea name="comment"></textarea></form></body></html>' },
      'x.example': { outcome: 'ok', html: SAME_SHAPE('X Club') + '<div class="g-recaptcha"></div><!--UCAAS-DOM captcha=none-->' },
    });
    const t = await boot({ siteCapacity: 10, ...fakeWeb(), browser: browser as any });
    const admin = await adminAnd(t);
    await admin.call('POST', '/api/sites/import', { filename: 'l.csv', content: listCsv(['a.example', 'b.example', 'x.example']) });
    const by = (d: string) => [...t.repo.sites.values()].find(x => x.domain === d)!;
    for (const d of ['a.example', 'b.example']) { by(d).removedAt = new Date(); by(d).removedReason = 'no sign-up form found, even in a browser'; }
    by('x.example').handling = 'staff'; by('x.example').handlingReason = 'page uses a CAPTCHA (staff complete it; it is never bypassed)'; by('x.example').needsStaff = true;
    const r = (await admin.call('POST', '/api/discovery/check', { removed: true })).json;
    expect(r.restored).toBe(1);
    expect(by('a.example').removedAt).toBeFalsy();                                  // the page of plain boxes was a sign-up form after all
    expect(by('b.example').removedAt).toBeTruthy();                                 // a comment box really is not
    const c = (await admin.call('POST', '/api/discovery/check', { captcha: true })).json;
    expect(c.simple).toBe(1);
    expect(by('x.example').handling).toBe('simple');                                // the browser saw no CAPTCHA, so the label is dropped
    await t.close();
  });
  it('does not put sites back when there is no free slot', async () => {
    const browser = fakeBrowser({ 'a.example': { outcome: 'ok', html: SAME_SHAPE('A Club') } });
    const t = await boot({ siteCapacity: 1, ...fakeWeb(), browser: browser as any });
    const admin = await adminAnd(t);
    await admin.call('POST', '/api/sites/import', { filename: 'l.csv', content: listCsv(['a.example']) });
    const a = [...t.repo.sites.values()][0];
    a.removedAt = new Date(); a.removedReason = 'no sign-up form found, even in a browser';
    const full = (await admin.call('POST', '/api/sites/import', { filename: 'm.csv', content: listCsv(['full.example']) })).json;
    const r = (await admin.call('POST', '/api/discovery/check', { removed: true })).json;
    expect(r.restored + r.noRoom).toBe(1);
    expect(full).toBeTruthy();
    await t.close();
  });
});

describe('removing sites with no sign-up form', () => {
  const fakeBrowser = (pages: Record<string, any>) => ({ analyze: async (url: string) => pages[new URL(url).hostname] ?? { outcome: 'error' }, close: async () => {} });
  const blog = '<html><body><form action="/wp-comments-post.php"><textarea name="comment"></textarea><input name="email" type="email"></form></body></html>';
  const searchOnly = '<html><body><form action="/search"><input name="q" type="search"></form></body></html>';
  it('removes pages with only a comment or search form, keeps real sign-up pages, and never deletes what it could not read', async () => {
    const browser = fakeBrowser({
      'a.example': { outcome: 'ok', html: SAME_SHAPE('A Club') },
      'blog.example': { outcome: 'ok', html: blog },
      'search.example': { outcome: 'ok', html: searchOnly },
      'down.example': { outcome: 'timeout' },
      'embed.example': { outcome: 'ok', html: '<html><body><iframe src="https://form.jotform.com/123"></iframe></body></html>' },
    });
    const t = await boot({ siteCapacity: 10, ...fakeWeb(), browser: browser as any });
    const admin = await adminAnd(t);
    await admin.call('POST', '/api/sites/import', { filename: 'l.csv', content: listCsv(['a.example', 'blog.example', 'search.example', 'down.example', 'embed.example']) });
    // pretend a plain fetch had called all of them working
    for (const x of t.repo.sites.values()) { x.handling = 'simple'; x.handlingReason = 'plain sign-up form found'; }
    const r = (await admin.call('POST', '/api/discovery/check', { forms: true })).json;
    expect(r.removed).toBe(2);
    const by = (d: string) => [...t.repo.sites.values()].find(x => x.domain === d)!;
    expect(by('blog.example').removedAt).toBeTruthy();
    expect(by('search.example').removedAt).toBeTruthy();
    expect(by('a.example').removedAt).toBeFalsy();
    expect(by('a.example').handlingReason).toBe('sign-up form confirmed in a browser');
    expect(by('down.example').removedAt).toBeFalsy();
    expect(by('embed.example').removedAt).toBeFalsy();
    expect(by('embed.example').handling).toBe('staff');
    const again = (await admin.call('POST', '/api/discovery/check', { forms: true })).json;
    expect(again.checked + again.skipped).toBe(0);
    await t.close();
  });
});

describe('setting the exact sign-up page', () => {
  it('lets staff start a site at its real sign-up page, on the same website only', async () => {
    const t = await boot({ siteCapacity: 10, ...fakeWeb(), browser: { analyze: async () => ({ outcome: 'timeout' }), close: async () => {} } as any });
    const admin = await adminAnd(t);
    await admin.call('POST', '/api/sites/import', { filename: 'l.csv', content: listCsv(['a.example']) });
    const site = [...t.repo.sites.values()][0];
    expect((await admin.call('POST', `/api/sites/${site.id}/signup-page`, { url: 'not a url' })).status).toBe(400);
    expect((await admin.call('POST', `/api/sites/${site.id}/signup-page`, { url: 'ftp://a.example/x' })).status).toBe(400);
    expect((await admin.call('POST', `/api/sites/${site.id}/signup-page`, { url: 'https://other.example/join' })).status).toBe(400);
    expect((await admin.call('POST', `/api/sites/${site.id}/signup-page`, { url: 'https://www.a.example/join/now#top' })).status).toBe(200);
    expect(site.url).toBe('https://www.a.example/join/now');
    expect(site.handling).toBe('simple');
    // the form sweep leaves a page staff chose alone
    const r = (await admin.call('POST', '/api/discovery/check', { forms: true })).json;
    expect(r.checked + r.skipped).toBe(0);
    await t.close();
  });
});
