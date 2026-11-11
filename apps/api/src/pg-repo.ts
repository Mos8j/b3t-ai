import type pg from 'pg';
import { dedupeKey } from '../../../packages/core/src/url';
import type { Repo, UserRow, ClientRow, ConsentRow, AuditEntry, NewSite, Cleanup, SiteRow, SiteFilter, SiteCounts, NewCandidate, CandidateRow, CandidateFilter, CandidateReviewRow, RunRow, ClientSiteStatus, ClientSiteRow, ClientLoginRow } from './repo';
import { summarizeSiteReliability, isSubmissionOutcome, type ResultFilter, type ResultHistory } from './submission-results';

const userRow = (r: any): UserRow => ({
  id: r.id, email: r.email, passwordHash: r.password_hash, role: r.role, disabledAt: r.disabled_at,
});

/** PostgreSQL storage. Uses parameterised queries only. */
export class PgRepo implements Repo {
  constructor(private pool: pg.Pool) {}
  private async rows(text: string, params: unknown[] = []): Promise<any[]> {
    return (await this.pool.query(text, params)).rows;
  }

  async listStaff() {
    return (await this.rows('SELECT * FROM app_user WHERE disabled_at IS NULL ORDER BY email')).map(userRow);
  }
  async disableStaff(id: string, adminId: string) {
    if (id === adminId) return false;
    const connection = await this.pool.connect();
    try {
      await connection.query('BEGIN');
      // Lock both accounts in the same order so two admins cannot remove each other.
      const { rows } = await connection.query(
        'SELECT id, role, disabled_at FROM app_user WHERE id IN ($1, $2) ORDER BY id FOR UPDATE', [id, adminId]);
      const admin = rows.find(row => row.id === adminId);
      let removed = false;
      if (admin?.role === 'admin' && !admin.disabled_at) {
        const result = await connection.query('UPDATE app_user SET disabled_at = now() WHERE id = $1 AND disabled_at IS NULL', [id]);
        removed = result.rowCount === 1;
      }
      await connection.query('COMMIT');
      return removed;
    } catch (error) {
      await connection.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      connection.release();
    }
  }
  async countUsers() { return (await this.rows('SELECT count(*)::int AS n FROM app_user'))[0].n as number; }
  async findUserByEmail(email: string) {
    const r = await this.rows('SELECT * FROM app_user WHERE email = $1', [email.toLowerCase()]);
    return r[0] ? userRow(r[0]) : null;
  }
  async findUserById(id: string) {
    const r = await this.rows('SELECT * FROM app_user WHERE id = $1', [id]);
    return r[0] ? userRow(r[0]) : null;
  }
  async createUser(u: { email: string; passwordHash: string; role: UserRow['role'] }) {
    try {
      const r = await this.rows(
        'INSERT INTO app_user (email, password_hash, role) VALUES ($1, $2, $3) RETURNING *',
        [u.email.toLowerCase(), u.passwordHash, u.role]);
      return userRow(r[0]);
    } catch (e: any) {
      if (e.code === '23505') throw new Error('duplicate_email');
      throw e;
    }
  }

  async createSession(tokenHash: string, userId: string, expiresAt: Date) {
    await this.pool.query('INSERT INTO user_session (token_hash, user_id, expires_at) VALUES ($1, $2, $3)', [tokenHash, userId, expiresAt]);
  }
  async findSession(tokenHash: string) {
    const r = await this.rows('SELECT user_id, expires_at FROM user_session WHERE token_hash = $1', [tokenHash]);
    return r[0] ? { userId: r[0].user_id as string, expiresAt: r[0].expires_at as Date } : null;
  }
  async deleteOtherSessions(userId: string, keep: string) {
    await this.pool.query('DELETE FROM user_session WHERE user_id = $1 AND token_hash <> $2', [userId, keep]);
  }
  async updateUserLogin(id: string, c: { email?: string; passwordHash?: string }) {
    try {
      const r = await this.rows(
        'UPDATE app_user SET email = COALESCE($2, email), password_hash = COALESCE($3, password_hash) WHERE id = $1 RETURNING *',
        [id, c.email ?? null, c.passwordHash ?? null]);
      if (!r[0]) throw new Error('not_found');
      return userRow(r[0]);
    } catch (e: any) {
      if (e?.code === '23505') throw new Error('duplicate_email');
      throw e;
    }
  }
  async deleteSession(tokenHash: string) {
    await this.pool.query('DELETE FROM user_session WHERE token_hash = $1', [tokenHash]);
  }

  async assignedClientIds(userId: string) {
    return (await this.rows('SELECT id AS client_id FROM client WHERE owner_id = $1 AND deleted_at IS NULL', [userId])).map(r => r.client_id as string);
  }
  async assignClient(userId: string, clientId: string) {
    await this.pool.query('INSERT INTO client_assignment (user_id, client_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [userId, clientId]);
  }

  async createClient(c: { id: string; displayName: string; encryptedProfile: Buffer; wrappedDek: Buffer; ownerId?: string }) {
    await this.pool.query(
      'INSERT INTO client (id, display_name, encrypted_profile, wrapped_dek, owner_id) VALUES ($1, $2, $3, $4, $5)',
      [c.id, c.displayName, c.encryptedProfile, c.wrappedDek, c.ownerId ?? null]);
  }
  async getClient(id: string): Promise<ClientRow | null> {
    const r = (await this.rows('SELECT * FROM client WHERE id = $1', [id]))[0];
    return r ? {
      id: r.id, displayName: r.display_name, encryptedProfile: r.encrypted_profile, wrappedDek: r.wrapped_dek,
      retentionDays: r.retention_days, createdAt: r.created_at, deletedAt: r.deleted_at,
    } : null;
  }
  async listClients(ids?: string[]) {
    const r = ids
      ? await this.rows('SELECT c.id, c.display_name, c.created_at, c.owner_id, u.email AS owner_email, u.role AS owner_role FROM client c LEFT JOIN app_user u ON u.id = c.owner_id WHERE c.deleted_at IS NULL AND c.id = ANY($1::uuid[]) ORDER BY c.created_at DESC', [ids])
      : await this.rows('SELECT c.id, c.display_name, c.created_at, c.owner_id, u.email AS owner_email, u.role AS owner_role FROM client c LEFT JOIN app_user u ON u.id = c.owner_id WHERE c.deleted_at IS NULL ORDER BY c.created_at DESC');
    return r.map(x => ({ id: x.id as string, displayName: x.display_name as string, createdAt: x.created_at as Date, ownerId: x.owner_id, ownerEmail: x.owner_email, ownerRole: x.owner_role }));
  }
  async updateClient(id: string, displayName: string, encryptedProfile: Buffer) {
    await this.pool.query('UPDATE client SET display_name = $2, encrypted_profile = $3 WHERE id = $1', [id, displayName, encryptedProfile]);
  }
  async softDeleteClient(id: string) {
    await this.pool.query('UPDATE client SET deleted_at = now() WHERE id = $1', [id]);
  }

  async addConsent(clientId: string, scope: string, recordedBy: string) {
    await this.pool.query('INSERT INTO consent (client_id, scope, recorded_by) VALUES ($1, $2, $3)', [clientId, scope, recordedBy]);
  }
  async revokeConsent(clientId: string, scope: string) {
    return (await this.rows('UPDATE consent SET revoked_at = now() WHERE client_id = $1 AND scope = $2 AND revoked_at IS NULL RETURNING id', [clientId, scope])).length > 0;
  }
  async listConsents(clientId: string): Promise<ConsentRow[]> {
    return (await this.rows('SELECT scope, granted_at, revoked_at FROM consent WHERE client_id = $1 ORDER BY granted_at', [clientId]))
      .map(r => ({ scope: r.scope, grantedAt: r.granted_at, revokedAt: r.revoked_at }));
  }

  async importSites(filename: string, originalRows: object[], sites: NewSite[], cleanup: Cleanup, _userId: string) {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('INSERT INTO site_import (filename, original_rows) VALUES ($1, $2::jsonb)', [filename, JSON.stringify(originalRows)]);
      const ins = await c.query(
        `INSERT INTO site (name, official_domain, dedupe_key, registration_url, category, automation_policy, discovery_source, user_notes, handling, handling_reason)
         SELECT t.n, t.d, t.d, t.u, t.c, t.p, 'import', NULLIF(t.notes, ''),
                CASE WHEN t.p = 'manual_only' THEN 'staff' ELSE 'unchecked' END,
                CASE WHEN t.p = 'manual_only' THEN 'sensitive site (credit, banking or insurance)' END
         FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[]) AS t(n, d, u, c, p, notes)
         ON CONFLICT (dedupe_key) DO NOTHING
         RETURNING dedupe_key`,
        [sites.map(s => s.name), sites.map(s => s.domain), sites.map(s => s.url), sites.map(s => s.category),
         sites.map(s => s.automationPolicy), sites.map(s => s.notes)]);
      const fresh = new Set<string>(ins.rows.map((r: any) => r.dedupe_key));
      const rm = Object.entries(cleanup.removed).filter(([d]) => fresh.has(d));
      let cleanedRemoved = 0, cleanedResearch = 0;
      if (rm.length) {
        cleanedRemoved = (await c.query(
          `UPDATE site s SET removed_at = now(), removed_reason = t.r
           FROM unnest($1::text[], $2::text[]) AS t(k, r) WHERE s.dedupe_key = t.k`,
          [rm.map(([d]) => d), rm.map(([, r]) => r)])).rowCount ?? 0;
      }
      const rs = cleanup.research.filter(d => fresh.has(d) && !cleanup.removed[d]);
      if (rs.length) {
        cleanedResearch = (await c.query(`UPDATE site SET catalog_state = 'research' WHERE dedupe_key = ANY($1::text[])`, [rs])).rowCount ?? 0;
      }
      await c.query('COMMIT');
      return { added: fresh.size, alreadyThere: sites.length - fresh.size, cleanedRemoved, cleanedResearch };
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      throw e;
    } finally { c.release(); }
  }
  private siteWhere(f: SiteFilter) {
    const where: string[] = [], params: unknown[] = [];
    const STAFF = `(handling = 'staff' OR automation_policy = 'manual_only')`;
    if (f.view === 'active') where.push(`removed_at IS NULL AND catalog_state <> 'research'`);
    else if (f.view === 'staff') where.push(`removed_at IS NULL AND catalog_state <> 'research' AND ${STAFF}`);
    else if (f.view === 'research') where.push(`removed_at IS NULL AND catalog_state = 'research'`);
    else if (f.view === 'removed') where.push('removed_at IS NOT NULL');
    if (f.category) { params.push(f.category); where.push(`category = $${params.length}`); }
    if (f.q) {
      params.push('%' + f.q.replace(/[\\%_]/g, m => '\\' + m) + '%');
      where.push(`(name ILIKE $${params.length} OR official_domain ILIKE $${params.length})`);
    }
    return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', params };
  }
  async listSites(f: SiteFilter) {
    const { sql, params } = this.siteWhere(f);
    const total = (await this.rows(`SELECT count(*)::int AS n FROM site ${sql}`, params))[0].n as number;
    const r = await this.rows(
      `SELECT * FROM site ${sql} ORDER BY (handling = 'staff' OR automation_policy = 'manual_only') DESC, lower(name), id LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, f.limit, f.offset]);
    const sites: SiteRow[] = r.map(x => ({
      id: x.id, name: x.name, domain: x.official_domain, url: x.registration_url, category: x.category,
      automationPolicy: x.automation_policy, catalogState: x.catalog_state, removedAt: x.removed_at,
      removedReason: x.removed_reason, notes: x.user_notes,
      handling: x.handling, handlingReason: x.handling_reason, needsStaff: x.handling === 'staff' || x.automation_policy === 'manual_only',
    }));
    return { total, sites };
  }
  async siteCounts(): Promise<SiteCounts> {
    const r = await this.rows(
      `SELECT category,
         count(*) FILTER (WHERE removed_at IS NULL AND catalog_state <> 'research')::int AS active,
         count(*) FILTER (WHERE removed_at IS NULL AND catalog_state = 'research')::int AS research,
         count(*) FILTER (WHERE removed_at IS NOT NULL)::int AS removed,
         count(*) FILTER (WHERE removed_at IS NULL AND catalog_state <> 'research' AND (handling = 'staff' OR automation_policy = 'manual_only'))::int AS staff,
         count(*) FILTER (WHERE removed_at IS NULL AND catalog_state <> 'research' AND handling = 'unchecked' AND automation_policy = 'unknown')::int AS unchecked
       FROM site GROUP BY category`);
    const c: SiteCounts = { active: 0, research: 0, removed: 0, staff: 0, unchecked: 0, byCategory: {} };
    for (const x of r) {
      c.active += x.active; c.research += x.research; c.removed += x.removed; c.staff += x.staff; c.unchecked += x.unchecked;
      if (x.active) c.byCategory[x.category] = x.active;
    }
    return c;
  }
  async setSiteRemoved(id: string, reason: string | null) {
    const r = await this.rows(
      reason === null ? 'UPDATE site SET removed_at = NULL, removed_reason = NULL WHERE id = $1 RETURNING fingerprint'
                      : 'UPDATE site SET removed_at = now(), removed_reason = $2 WHERE id = $1 RETURNING fingerprint',
      reason === null ? [id] : [id, reason]);
    return r[0] ? { fingerprint: (r[0].fingerprint ?? []) as string[] } : null;
  }
  async setSiteDoNotWork(id: string, reason: string) { return (await this.rows('UPDATE site SET removed_reason = $2 WHERE id = $1 AND removed_at IS NOT NULL RETURNING id', [id, reason])).length > 0; }
  async restoreSiteForRetry(id: string) {
    const r = await this.rows(`UPDATE site SET removed_at = NULL, removed_reason = 'RESTORED: ' || coalesce(removed_reason, '') WHERE id = $1 AND removed_at IS NOT NULL RETURNING id`, [id]);
    return r.length > 0;
  }
  async setSiteResearch(id: string) { await this.pool.query(`UPDATE site SET catalog_state = 'research' WHERE id = $1`, [id]); }

  async removedCheckQueue(limit: number, cooldownMs: number) {
    return (await this.rows(
      `SELECT id, registration_url AS url, dedupe_key AS domain FROM site
       WHERE removed_at IS NOT NULL AND removed_reason ILIKE '%no sign-up form%' AND removed_reason NOT ILIKE 'removed for good%' AND registration_url IS NOT NULL
         AND (analyzed_at IS NULL OR analyzed_at < now() - ($2::int * interval '1 millisecond')) ORDER BY analyzed_at NULLS FIRST, id LIMIT $1`, [limit, Math.max(0, Math.round(cooldownMs))])).map(x => ({ id: x.id as string, url: x.url as string, domain: x.domain as string }));
  }
  async siteCheckQueue(limit: number, opts: { recheck?: boolean; browserPass?: boolean; healthPass?: boolean; formSweep?: boolean; captchaPass?: boolean; cooldownMs?: number } = {}) {
    const COOL = `(analyzed_at IS NULL OR analyzed_at < now() - ($2::int * interval '1 millisecond'))`;
    const which = opts.formSweep
      ? `handling = 'simple' AND (handling_reason IS NULL OR handling_reason NOT IN ('sign-up form confirmed in a browser', 'could not be read in a browser', 'sign-up page set by staff')) AND $2::int >= 0 ORDER BY analyzed_at NULLS FIRST, id`
      : opts.captchaPass
      ? `handling = 'staff' AND handling_reason LIKE '%CAPTCHA%' AND ${COOL} ORDER BY analyzed_at NULLS FIRST, id`
      : opts.healthPass
      ? `handling = 'simple' AND ${COOL} ORDER BY analyzed_at NULLS FIRST, id`
      : opts.browserPass
      ? `handling IN ('unknown', 'staff') AND (handling_reason IN ('no sign-up form found on this page', 'the site blocks automated checks (never bypassed)') OR handling_reason LIKE 'form is built by JavaScript%') AND ${COOL} ORDER BY analyzed_at NULLS FIRST, id`
      : opts.recheck
      ? `handling = 'staff' AND (handling_reason LIKE '%CAPTCHA%' OR handling_reason LIKE '%blocks automated%') ORDER BY analyzed_at NULLS FIRST, id`
      : `handling = 'unchecked' AND ${COOL} ORDER BY analyzed_at NULLS FIRST, discovered_at, id`;
    return (await this.rows(
      `SELECT id, registration_url AS url, dedupe_key AS domain FROM site
       WHERE removed_at IS NULL AND catalog_state <> 'research' AND automation_policy = 'unknown' AND registration_url IS NOT NULL AND ${which} LIMIT $1`, opts.recheck ? [limit] : [limit, Math.max(0, Math.round(opts.cooldownMs ?? 0))])).map(x => ({ id: x.id as string, url: x.url as string, domain: x.domain as string }));
  }
  async setSiteSignupPage(id: string, url: string) {
    const r = await this.rows('SELECT dedupe_key FROM site WHERE id = $1', [id]);
    if (!r[0]) return 'not_found' as const;
    if (dedupeKey(url) !== r[0].dedupe_key) return 'other_site' as const;
    await this.pool.query(`UPDATE site SET registration_url = $2, handling = 'simple', handling_reason = 'sign-up page set by staff', catalog_state = CASE WHEN catalog_state = 'research' THEN 'candidate' ELSE catalog_state END
      WHERE id = $1`, [id, url]);
    return 'ok' as const;
  }
  async setSiteSignupUrl(id: string, url: string) { await this.pool.query('UPDATE site SET registration_url = $2 WHERE id = $1', [id, url]); }
  async recordSiteCheck(id: string, u: { handling?: 'simple' | 'staff' | 'unknown'; reason?: string; fingerprint?: string[] }, run?: { outcome: string }) {
    await this.pool.query(
      `UPDATE site SET handling = COALESCE($2, handling), handling_reason = CASE WHEN $2::text IS NULL THEN handling_reason ELSE $3 END,
         fingerprint = COALESCE($4::text[], fingerprint), analyzed_at = now(),
         last_verified_at = CASE WHEN $5::text = 'ok' THEN now() ELSE last_verified_at END
       WHERE id = $1`,
      [id, u.handling ?? null, u.reason ?? null, u.fingerprint ?? null, run?.outcome ?? null]);
    if (run) await this.pool.query(`INSERT INTO site_test_run (site_id, kind, outcome) VALUES ($1, 'reachability', $2)`, [id, run.outcome]);
  }
  async siteRuns(id: string, limit: number): Promise<RunRow[]> {
    return (await this.rows(
      `SELECT outcome, ran_at FROM (SELECT outcome, ran_at, id FROM site_test_run WHERE site_id = $1 ORDER BY ran_at DESC, id DESC LIMIT $2) x ORDER BY ran_at, id`,
      [id, limit])).map(x => ({ outcome: x.outcome as string, at: new Date(x.ran_at).toISOString() }));
  }
  async goodFingerprints() {
    return (await this.rows(
      `SELECT fingerprint FROM site WHERE removed_at IS NULL AND handling = 'simple' AND fingerprint IS NOT NULL AND cardinality(fingerprint) > 0`)).map(x => x.fingerprint as string[]);
  }

  async browserUnclearIds() {
    return (await this.rows(`SELECT id FROM site WHERE removed_at IS NULL AND handling = 'unknown' AND handling_reason = $1`, ['no sign-up form found, even in a browser'])).map((x: any) => x.id as string);
  }
  async proposeClientSites(clientId: string, target: number | null, includeStaff: boolean) {
    const STAFF = `(s.handling = 'staff' OR s.automation_policy = 'manual_only')`;
    const reliability = await this.siteReliability();
    const ranked = Object.entries(reliability).filter(([, r]) => r.score !== 50).sort((a, b) => b[1].score - a[1].score);
    const better = ranked.filter(([, r]) => r.score > 50).map(([id]) => id);
    const worse = ranked.filter(([, r]) => r.score < 50).map(([id]) => id);
    const USABLE = `s.removed_at IS NULL AND s.catalog_state <> 'research' AND s.registration_url IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM client_site c WHERE c.client_id = $1 AND c.site_id = s.id)`;
    let added = 0;
    if (includeStaff) {
      added += (await this.rows(
        `INSERT INTO client_site (client_id, site_id) SELECT $1, s.id FROM site s WHERE ${USABLE} AND ${STAFF} AND (s.handling IN ('simple','staff') OR s.automation_policy = 'manual_only')
         ORDER BY s.name, s.id RETURNING id`, [clientId])).length;
    }
    added += (await this.rows(
      `WITH have AS (SELECT count(*)::int AS n FROM client_site c JOIN site s ON s.id = c.site_id WHERE c.client_id = $1 AND c.status <> 'skipped' AND NOT ${STAFF})
       INSERT INTO client_site (client_id, site_id)
       SELECT $1, s.id FROM site s WHERE ${USABLE} AND s.handling = 'simple' AND NOT ${STAFF}
       ORDER BY CASE WHEN s.id = ANY($3::uuid[]) THEN 0 WHEN s.id = ANY($4::uuid[]) THEN 2 ELSE 1 END,
       array_position($3::uuid[], s.id), array_position($4::uuid[], s.id), s.name, s.id
       LIMIT CASE WHEN $2::int IS NULL THEN 100000 ELSE GREATEST($2::int - (SELECT n FROM have), 0) END
       RETURNING id`, [clientId, target, better, worse])).length;
    return added;
  }
  private static CS = `c.status, c.note, s.id AS site_id, s.name, s.dedupe_key AS domain, s.registration_url AS url, s.category, s.handling, s.handling_reason,
    (s.handling = 'staff' OR s.automation_policy = 'manual_only') AS needs_staff, (s.removed_reason LIKE 'RESTORED:%') AS restored`;
  private static csRow(x: any): ClientSiteRow {
    return { siteId: x.site_id, name: x.name, domain: x.domain, url: x.url, category: x.category, handling: x.handling, handlingReason: x.handling_reason, needsStaff: !!x.needs_staff, status: x.status, note: x.note, restored: !!x.restored };
  }
  async listClientSites(clientId: string, f: { status?: ClientSiteStatus; limit: number; offset: number; hideStaff?: boolean; hasNote?: boolean; captcha?: boolean; notePrefixes?: string[]; restored?: boolean }) {
    const NOSTAFF = ' AND s.removed_at IS NULL ' + (f.hideStaff ? `AND NOT (s.handling = 'staff' OR s.automation_policy = 'manual_only')` : '');   // removed sites disappear from every client's list
    const args: any[] = f.status ? [clientId, f.status] : [clientId];
    const where = (f.status ? 'AND c.status = $2 ' : '') + (f.hasNote ? `AND c.note IS NOT NULL AND c.note <> ''` : '') + (f.captcha ? ` AND (c.note ILIKE 'CAPTCHA%' OR s.handling_reason ILIKE '%captcha%')` : '') + NOSTAFF;
    let where2 = where + (f.restored ? ` AND s.removed_reason LIKE 'RESTORED:%'` : '');
    if (f.notePrefixes?.length) {
      const ors = f.notePrefixes.map(pre => { args.push(pre.replace(/[\\%_]/g, m => '\\' + m) + '%'); return `c.note ILIKE $${args.length}`; });
      where2 += ` AND (${ors.join(' OR ')})`;
    }
    const total = Number((await this.rows(`SELECT count(*) AS n FROM client_site c JOIN site s ON s.id = c.site_id WHERE c.client_id = $1 ${where2}`, args))[0].n);
    const rows = await this.rows(
      `SELECT ${PgRepo.CS} FROM client_site c JOIN site s ON s.id = c.site_id WHERE c.client_id = $1 ${where2}
       ORDER BY (s.handling = 'staff' OR s.automation_policy = 'manual_only') DESC, s.name, s.id LIMIT ${Math.max(1, Math.floor(f.limit))} OFFSET ${Math.max(0, Math.floor(f.offset))}`, args);
    const counts: Record<ClientSiteStatus, number> = { proposed: 0, approved: 0, skipped: 0, staff_fill: 0, done: 0, sent: 0 };
    for (const g of await this.rows(`SELECT c.status, count(*) AS n FROM client_site c JOIN site s ON s.id = c.site_id WHERE c.client_id = $1 ${NOSTAFF} GROUP BY c.status`, [clientId])) counts[g.status as ClientSiteStatus] = Number(g.n);
    return { total, sites: rows.map(PgRepo.csRow), counts };
  }
  async approveProposedClientSites(clientId: string, userId: string) {
    const r = await this.rows(
      `UPDATE client_site c SET status = 'approved', decided_by = $2, decided_at = now()
       FROM site s WHERE s.id = c.site_id AND c.client_id = $1 AND c.status = 'proposed' AND NOT (s.handling = 'staff' OR s.automation_policy = 'manual_only') RETURNING c.id`, [clientId, userId]);
    return r.length;
  }
  async getClientSite(clientId: string, siteId: string) {
    const r = (await this.rows(`SELECT ${PgRepo.CS} FROM client_site c JOIN site s ON s.id = c.site_id WHERE c.client_id = $1 AND c.site_id = $2`, [clientId, siteId]))[0];
    return r ? PgRepo.csRow(r) : null;
  }
  async setClientSiteStatus(clientId: string, siteId: string, status: ClientSiteStatus, note: string | null, userId: string | null) {
    const r = await this.rows(`UPDATE client_site SET status = $3, note = $4, decided_by = $5, decided_at = now() WHERE client_id = $1 AND site_id = $2 RETURNING id`, [clientId, siteId, status, note, userId]);
    return r.length > 0;
  }
  async addClientLogin(clientId: string, siteId: string, encrypted: Buffer, userId: string | null) {
    await this.pool.query('INSERT INTO client_login (client_id, site_id, encrypted_login, created_by) VALUES ($1, $2, $3, $4)', [clientId, siteId, encrypted, userId]);
  }
  async listClientLogins(clientId: string): Promise<ClientLoginRow[]> {
    return (await this.rows(
      `SELECT l.id, l.client_id, l.site_id, l.encrypted_login, l.created_at, s.name, s.dedupe_key AS domain
       FROM client_login l JOIN site s ON s.id = l.site_id WHERE l.client_id = $1 ORDER BY l.created_at DESC`, [clientId]))
      .map(x => ({ id: x.id, clientId: x.client_id, siteId: x.site_id, siteName: x.name, domain: x.domain, encrypted: x.encrypted_login, createdAt: x.created_at }));
  }
  async knownDomains(keys: string[]) {
    if (!keys.length) return new Set<string>();
    const r = await this.rows(`SELECT dedupe_key AS d FROM site WHERE dedupe_key = ANY($1::text[]) UNION SELECT domain AS d FROM site_candidate WHERE domain = ANY($1::text[])`, [keys]);
    return new Set<string>(r.map((x: any) => x.d));
  }
  async addCandidate(c: NewCandidate) {
    const r = await this.rows(
      `INSERT INTO site_candidate (domain, name, url, category, handling, handling_reason, fingerprint, score, source)
       SELECT $1, $2, $3, $4, $5, $6, $7::text[], $8, $9
       WHERE NOT EXISTS (SELECT 1 FROM site WHERE dedupe_key = $1)
       ON CONFLICT (domain) DO NOTHING RETURNING id`,
      [c.domain, c.name, c.url, c.category, c.handling, c.handlingReason, c.fingerprint, c.score, c.source]);
    return r.length > 0;
  }
  private reviewCandidateRow(x: any): CandidateReviewRow {
    return { id: x.id, domain: x.domain, name: x.name, url: x.url, category: x.category, handling: x.handling,
      handlingReason: x.handling_reason || '', fingerprint: x.fingerprint || [], score: Number(x.score), source: x.source, state: x.state };
  }
  async listReviewCandidates(f: CandidateFilter) {
    const args: unknown[] = [];
    const blocked = "COALESCE(handling_reason, '') ~* '(bot_blocked|robots_disallowed|automated.*block|blocked.*automated)'";
    const verified = "handling = 'simple' AND COALESCE(handling_reason, '') LIKE 'Browser verified signup: %'";
    const view = f.view === 'dismissed' ? "state = 'rejected'" : "state = 'pending' AND (" + (f.view === 'blocked' ? blocked : f.view === 'staff' ? "handling = 'staff' AND NOT (" + blocked + ")" : f.view === 'qualified' ? verified : "handling <> 'staff' AND NOT (" + blocked + ") AND NOT (" + verified + ")") + ")";
    let where = view;
    if (f.q) { args.push('%' + f.q + '%'); where += ' AND (name ILIKE $1 OR domain ILIKE $1 OR handling_reason ILIKE $1)'; }
    const count = await this.rows('SELECT count(*)::int AS n FROM site_candidate WHERE ' + where, args);
    const limit = args.push(f.limit), offset = args.push(f.offset);
    const rows = await this.rows('SELECT * FROM site_candidate WHERE ' + where + ' ORDER BY created_at DESC, id LIMIT $' + limit + ' OFFSET $' + offset, args);
    return { total: count[0].n, entries: rows.map(x => this.reviewCandidateRow(x)) };
  }
  async getReviewCandidate(id: string) {
    const rows = await this.rows('SELECT * FROM site_candidate WHERE id = $1', [id]);
    return rows.length ? this.reviewCandidateRow(rows[0]) : null;
  }
  async updateReviewCandidate(id: string, c: NewCandidate) {
    return (await this.rows("UPDATE site_candidate SET name=$2, url=$3, category=$4, handling=$5, handling_reason=$6, fingerprint=$7::text[], score=$8 WHERE id=$1 AND state='pending' RETURNING id", [id,c.name,c.url,c.category,c.handling,c.handlingReason,c.fingerprint,c.score])).length > 0;
  }
  async setCandidateReviewState(id: string, state: 'pending' | 'rejected') {
    return (await this.rows("UPDATE site_candidate SET state=$2 WHERE id=$1 AND state IN ('pending','rejected') RETURNING id", [id,state])).length > 0;
  }
  async pendingSimpleCandidates(limit: number): Promise<CandidateRow[]> {
    return (await this.rows(
      `SELECT * FROM site_candidate WHERE state = 'pending' AND handling = 'simple' AND handling_reason LIKE 'Browser verified signup: %' ORDER BY score DESC, created_at LIMIT $1`, [limit]))
      .map(x => ({ id: x.id, domain: x.domain, name: x.name, url: x.url, category: x.category, handling: x.handling,
        handlingReason: x.handling_reason ?? '', fingerprint: x.fingerprint ?? [], score: Number(x.score), source: x.source }));
  }
  async promoteCandidate(c: CandidateRow): Promise<SiteRow | null> {
    const cl = await this.pool.connect();
    try {
      await cl.query('BEGIN');
      const ins = await cl.query(
        `INSERT INTO site (name, official_domain, dedupe_key, registration_url, category, discovery_source, handling, handling_reason, fingerprint)
         VALUES ($1, $2, $2, $3, $4, 'discovery', 'simple', $5, $6::text[]) ON CONFLICT (dedupe_key) DO NOTHING RETURNING *`,
        [c.name, c.domain, c.url, c.category, c.handlingReason, c.fingerprint]);
      await cl.query(`UPDATE site_candidate SET state = 'promoted' WHERE id = $1`, [c.id]);
      await cl.query('COMMIT');
      const x = ins.rows[0];
      return x ? { id: x.id, name: x.name, domain: x.official_domain, url: x.registration_url, category: x.category,
        automationPolicy: x.automation_policy, catalogState: x.catalog_state, removedAt: null, removedReason: null, notes: null,
        handling: 'simple', handlingReason: x.handling_reason, needsStaff: false } : null;
    } catch (e) { await cl.query('ROLLBACK').catch(() => {}); throw e; } finally { cl.release(); }
  }
  async candidateCounts() {
    const r = await this.rows(`SELECT CASE WHEN handling = 'simple' AND COALESCE(handling_reason, '') NOT LIKE 'Browser verified signup: %' THEN 'unknown' ELSE handling END AS handling, count(*)::int AS n FROM site_candidate WHERE state = 'pending' GROUP BY 1`);
    const o = { simple: 0, staff: 0, unknown: 0 };
    for (const x of r) o[x.handling as 'simple' | 'staff' | 'unknown'] = x.n;
    return o;
  }

  async audit(e: { userId: string | null; clientId?: string | null; action: string; detail?: object }) {
    await this.pool.query(
      'INSERT INTO audit_log (user_id, client_id, action, detail) VALUES ($1, $2, $3, $4::jsonb)',
      [e.userId, e.clientId ?? null, e.action, JSON.stringify(e.detail ?? {})]);
  }
  async discoveryHistory(limit: number, offset: number) {
    const latest = "WITH latest AS (SELECT DISTINCT ON (user_id, detail->>'runId') * FROM audit_log WHERE action='discovery.run' ORDER BY user_id, detail->>'runId', id DESC)";
    const count = await this.rows(latest + ' SELECT count(*)::int AS n FROM latest');
    const rows = await this.rows(latest + ' SELECT * FROM latest ORDER BY id DESC LIMIT $1 OFFSET $2', [limit, offset]);
    return { total: count[0].n, entries: rows.map(x => ({ id: Number(x.id), at: x.at, userId: x.user_id, clientId: x.client_id, action: x.action, detail: x.detail })) };
  }
  async batchHistory(clientId: string, runId?: string): Promise<AuditEntry[]> {
    const rows = await this.rows(`SELECT * FROM (SELECT DISTINCT ON (detail->>'runId') * FROM audit_log
      WHERE client_id=$1 AND action='batch.progress' AND ($2::text IS NULL OR detail->>'runId'=$2)
      ORDER BY detail->>'runId', id DESC) latest ORDER BY id DESC LIMIT 50`, [clientId, runId ?? null]);
    return rows.map(x => ({ id: Number(x.id), at: x.at, userId: x.user_id, clientId: x.client_id, action: x.action, detail: x.detail }));
  }
  async listAudit(clientId?: string): Promise<AuditEntry[]> {
    const r = clientId
      ? await this.rows('SELECT * FROM audit_log WHERE client_id = $1 ORDER BY id DESC LIMIT 200', [clientId])
      : await this.rows('SELECT * FROM audit_log ORDER BY id DESC LIMIT 200');
    return r.map(x => ({ id: Number(x.id), at: x.at, userId: x.user_id, clientId: x.client_id, action: x.action, detail: x.detail }));
  }
  async siteReliability(siteIds?: string[]) {
    if (siteIds && !siteIds.length) return {};
    const rows = await this.rows(`WITH latest AS (
      SELECT DISTINCT ON (client_id, COALESCE(detail->>'attemptId', id::text)) detail, at
      FROM audit_log WHERE action='submission.result' AND at >= now() - interval '90 days'
      AND ($1::text[] IS NULL OR detail->>'siteId' = ANY($1::text[]))
      ORDER BY client_id, COALESCE(detail->>'attemptId', id::text), id DESC)
      SELECT detail->>'siteId' AS site_id, at, detail->'outcome' AS outcome FROM latest`, [siteIds || null]);
    return summarizeSiteReliability(rows.map(x => ({ siteId: x.site_id, at: x.at, outcome: x.outcome })));
  }
  async listSubmissionResults(clientId: string, f: ResultFilter): Promise<ResultHistory> {
    const latest = `WITH latest AS (SELECT DISTINCT ON (COALESCE(detail->>'attemptId', id::text)) * FROM audit_log
      WHERE client_id = $1 AND action = 'submission.result' ORDER BY COALESCE(detail->>'attemptId', id::text), id DESC)`;
    const dismissed = "COALESCE((SELECT (v.detail->>'dismissed')::boolean FROM audit_log v WHERE v.client_id = a.client_id AND v.action = 'submission.visibility' AND v.detail->>'resultId' = a.id::text ORDER BY v.id DESC LIMIT 1), false)";
    const source = `FROM latest a JOIN client_site c ON c.client_id = a.client_id AND c.site_id::text = a.detail->>'siteId'
      JOIN site s ON s.id = c.site_id WHERE a.client_id = $1 AND a.action = 'submission.result'
      AND a.detail->'outcome'->>'delivery' IN ('confirmed','unconfirmed','not_sent')
      ${f.includeDismissed ? '' : 'AND NOT (' + dismissed + ')'}
      ${f.resultId !== undefined ? 'AND a.id = ' + Number(f.resultId) : ''}
      ${f.hideStaff ? "AND NOT (s.handling = 'staff' OR s.automation_policy = 'manual_only')" : ''}`;
    const counts = { confirmed: 0, unconfirmed: 0, not_sent: 0 };
    for (const row of await this.rows(`${latest} SELECT a.detail->'outcome'->>'delivery' AS delivery, count(*)::int AS n ${source} GROUP BY 1`, [clientId])) counts[row.delivery as keyof typeof counts] = row.n;
    const args: any[] = [clientId];
    const filtered = f.delivery ? ` AND a.detail->'outcome'->>'delivery' = $${args.push(f.delivery)}` : '';
    const total = f.delivery ? counts[f.delivery] : counts.confirmed + counts.unconfirmed + counts.not_sent;
    const limit = args.push(f.limit), offset = args.push(f.offset);
    const rows = await this.rows(`${latest} SELECT a.id, a.at, a.detail, ${dismissed} AS dismissed, s.id AS site_id, s.name, s.dedupe_key AS domain, s.registration_url AS url,
      c.status, (s.handling = 'staff' OR s.automation_policy = 'manual_only') AS needs_staff
      ${source} ${filtered} ORDER BY a.id DESC LIMIT $${limit} OFFSET $${offset}`, args);
    return { total, counts, entries: rows.filter(x => isSubmissionOutcome(x.detail?.outcome)).map(x => ({ id: Number(x.id), dismissed: !!x.dismissed, at: x.at,
      siteId: x.site_id, name: x.name, domain: x.domain, url: x.url, siteStatus: x.status, needsStaff: !!x.needs_staff, outcome: x.detail.outcome })) };
  }
}
