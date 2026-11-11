import { dedupeKey } from '../../../packages/core/src/url';
import { randomUUID } from 'node:crypto';
import { summarizeSiteReliability, isSubmissionOutcome, type ResultFilter, type ResultHistory, type SubmissionRecord } from './submission-results';
import type { Repo, UserRow, ClientRow, ConsentRow, AuditEntry, NewSite, Cleanup, SiteRow, SiteFilter, SiteCounts, NewCandidate, CandidateRow, CandidateFilter, CandidateReviewRow, RunRow, ClientSiteStatus, ClientSiteRow, ClientLoginRow } from './repo';

/** In-memory storage for tests. Same behaviour as PgRepo, nothing persisted. */
export const FORM_SWEPT = ['sign-up form confirmed in a browser', 'could not be read in a browser', 'sign-up page set by staff'];
export class MemoryRepo implements Repo {
  users = new Map<string, UserRow>();
  sessions = new Map<string, { userId: string; expiresAt: Date }>();
  assignments = new Set<string>(); // `${userId}|${clientId}`
  clients = new Map<string, ClientRow>();
  consents: (ConsentRow & { clientId: string })[] = [];
  auditLog: AuditEntry[] = [];
  sites = new Map<string, SiteRow & { domainKey: string; fingerprint: string[]; runs: RunRow[]; checkedAt: number; checkedAtMs: number }>();
  checkClock = 0;
  candidates = new Map<string, CandidateRow & { state: string }>();
  siteImports: { filename: string; rows: object[] }[] = [];

  async listStaff() {
    return [...this.users.values()].filter(u => !u.disabledAt).sort((a, b) => a.email.localeCompare(b.email));
  }
  async disableStaff(id: string, adminId: string) {
    const admin = this.users.get(adminId);
    const user = this.users.get(id);
    if (id === adminId || admin?.role !== 'admin' || admin.disabledAt || !user || user.disabledAt) return false;
    user.disabledAt = new Date();
    return true;
  }
  async countUsers() { return this.users.size; }
  async findUserByEmail(email: string) { return [...this.users.values()].find(u => u.email === email.toLowerCase()) ?? null; }
  async findUserById(id: string) { return this.users.get(id) ?? null; }
  async createUser(u: { email: string; passwordHash: string; role: UserRow['role'] }) {
    const email = u.email.toLowerCase();
    if ([...this.users.values()].some(x => x.email === email)) throw new Error('duplicate_email');
    const row: UserRow = { id: randomUUID(), email, passwordHash: u.passwordHash, role: u.role, disabledAt: null };
    this.users.set(row.id, row);
    return row;
  }
  async createSession(h: string, userId: string, expiresAt: Date) { this.sessions.set(h, { userId, expiresAt }); }
  async findSession(h: string) { return this.sessions.get(h) ?? null; }
  async deleteSession(h: string) { this.sessions.delete(h); }
  async deleteOtherSessions(userId: string, keep: string) {
    for (const [h, v] of [...this.sessions]) if (v.userId === userId && h !== keep) this.sessions.delete(h);
  }
  async updateUserLogin(id: string, c: { email?: string; passwordHash?: string }) {
    const u = this.users.get(id);
    if (!u) throw new Error('not_found');
    if (c.email && c.email !== u.email && [...this.users.values()].some(x => x.email === c.email)) throw new Error('duplicate_email');
    if (c.email) u.email = c.email;
    if (c.passwordHash) u.passwordHash = c.passwordHash;
    return u;
  }

  async assignedClientIds(userId: string) {
    return [...this.clients.values()].filter(c => c.ownerId === userId && !c.deletedAt).map(c => c.id);
  }
  async assignClient(userId: string, clientId: string) { this.assignments.add(`${userId}|${clientId}`); }

  async createClient(c: { id: string; displayName: string; encryptedProfile: Buffer; wrappedDek: Buffer; ownerId?: string }) {
    this.clients.set(c.id, { ...c, retentionDays: 365, createdAt: new Date(), deletedAt: null });
  }
  async getClient(id: string) { return this.clients.get(id) ?? null; }
  async listClients(ids?: string[]) {
    return [...this.clients.values()]
      .filter(c => !c.deletedAt && (!ids || ids.includes(c.id)))
      .map(c => ({ id: c.id, displayName: c.displayName, createdAt: c.createdAt, ownerId: c.ownerId, ownerEmail: this.users.get(c.ownerId || "")?.email, ownerRole: this.users.get(c.ownerId || "")?.role }));
  }
  async updateClient(id: string, displayName: string, encryptedProfile: Buffer) {
    const c = this.clients.get(id); if (c) { c.displayName = displayName; c.encryptedProfile = encryptedProfile; }
  }
  async softDeleteClient(id: string) { const c = this.clients.get(id); if (c) c.deletedAt = new Date(); }

  async addConsent(clientId: string, scope: string, _by: string) {
    this.consents.push({ clientId, scope, grantedAt: new Date(), revokedAt: null });
  }
  async revokeConsent(clientId: string, scope: string) {
    const live = this.consents.filter(c => c.clientId === clientId && c.scope === scope && !c.revokedAt);
    for (const c of live) c.revokedAt = new Date();
    return live.length > 0;
  }
  async listConsents(clientId: string) {
    return this.consents.filter(c => c.clientId === clientId).map(({ scope, grantedAt, revokedAt }) => ({ scope, grantedAt, revokedAt }));
  }

  async importSites(filename: string, rows: object[], sites: NewSite[], cleanup: Cleanup, _userId: string) {
    this.siteImports.push({ filename, rows });
    const have = new Set([...this.sites.values()].map(x => x.domainKey));
    let added = 0, cleanedRemoved = 0, cleanedResearch = 0;
    for (const n of sites) {
      if (have.has(n.domain)) continue;
      have.add(n.domain); added++;
      const row = {
        id: randomUUID(), domainKey: n.domain, name: n.name, domain: n.domain, url: n.url, category: n.category,
        automationPolicy: n.automationPolicy, catalogState: 'candidate', removedAt: null as Date | null, removedReason: null as string | null, notes: n.notes || null,
        handling: n.automationPolicy === 'manual_only' ? 'staff' : 'unchecked',
        handlingReason: n.automationPolicy === 'manual_only' ? 'sensitive site (credit, banking or insurance)' : null,
        needsStaff: n.automationPolicy === 'manual_only', fingerprint: [] as string[], runs: [] as RunRow[], checkedAt: 0, checkedAtMs: 0,
      };
      if (cleanup.removed[n.domain]) { row.removedAt = new Date(); row.removedReason = cleanup.removed[n.domain]; cleanedRemoved++; }
      else if (cleanup.research.includes(n.domain)) { row.catalogState = 'research'; cleanedResearch++; }
      this.sites.set(row.id, row);
    }
    return { added, alreadyThere: sites.length - added, cleanedRemoved, cleanedResearch };
  }
  private viewOf(s: SiteRow) { return s.removedAt ? 'removed' : s.catalogState === 'research' ? 'research' : 'active'; }
  async listSites(f: SiteFilter) {
    const q = f.q?.toLowerCase();
    const all = [...this.sites.values()]
      .filter(s => (f.view === 'all' || (f.view === 'staff' ? s.needsStaff && this.viewOf(s) === 'active' : this.viewOf(s) === f.view))
        && (!f.category || s.category === f.category)
        && (!q || s.name.toLowerCase().includes(q) || s.domain.includes(q)))
      .sort((a, b) => Number(b.needsStaff) - Number(a.needsStaff) || a.name.localeCompare(b.name));
    return { total: all.length, sites: all.slice(f.offset, f.offset + f.limit).map(({ domainKey, fingerprint, runs, checkedAt, checkedAtMs, ...s }) => s) };
  }
  async siteCounts(): Promise<SiteCounts> {
    const c: SiteCounts = { active: 0, research: 0, removed: 0, staff: 0, unchecked: 0, byCategory: {} };
    for (const s of this.sites.values()) {
      const v = this.viewOf(s); c[v]++;
      if (v === 'active') {
        c.byCategory[s.category] = (c.byCategory[s.category] ?? 0) + 1;
        if (s.needsStaff) c.staff++;
        if (s.handling === 'unchecked' && s.automationPolicy === 'unknown') c.unchecked++;
      }
    }
    return c;
  }
  async setSiteRemoved(id: string, reason: string | null) {
    const s = this.sites.get(id); if (!s) return null;
    s.removedAt = reason === null ? null : new Date(); s.removedReason = reason; return { fingerprint: s.fingerprint };
  }
  async setSiteDoNotWork(id: string, reason: string) { const s = this.sites.get(id); if (!s || !s.removedAt) return false; s.removedReason = reason; return true; }
  async restoreSiteForRetry(id: string) {
    const s = this.sites.get(id); if (!s || !s.removedAt) return false;
    s.removedReason = 'RESTORED: ' + (s.removedReason ?? ''); s.removedAt = null; return true;
  }
  async setSiteResearch(id: string) { const s = this.sites.get(id); if (s) s.catalogState = 'research'; }

  async removedCheckQueue(limit: number, cooldownMs: number) {
    const now = Date.now();
    return [...this.sites.values()].filter(s => !!s.removedAt && /no sign-up form/i.test(s.removedReason ?? '') && !/^removed for good/i.test(s.removedReason ?? '') && s.url && (!s.checkedAtMs || now - s.checkedAtMs >= cooldownMs))
      .sort((a, b) => a.checkedAt - b.checkedAt).slice(0, limit).map(s => ({ id: s.id, url: s.url!, domain: s.domain }));
  }
  async siteCheckQueue(limit: number, opts: { recheck?: boolean; browserPass?: boolean; healthPass?: boolean; formSweep?: boolean; captchaPass?: boolean; cooldownMs?: number } = {}) {
    const now = Date.now();
    const cool = (s: { checkedAtMs: number }) => !opts.cooldownMs || !s.checkedAtMs || now - s.checkedAtMs >= opts.cooldownMs;
    return [...this.sites.values()].filter(s => !s.removedAt && s.automationPolicy === 'unknown' && s.url
      && (opts.formSweep ? s.handling === 'simple' && !FORM_SWEPT.includes(s.handlingReason ?? '')
        : opts.healthPass ? s.handling === 'simple' && cool(s)
        : opts.captchaPass ? s.handling === 'staff' && /CAPTCHA/.test(s.handlingReason ?? '') && cool(s)
        : opts.browserPass ? (s.handling === 'unknown' || s.handling === 'staff') && cool(s)
            && (['no sign-up form found on this page', 'the site blocks automated checks (never bypassed)'].includes(s.handlingReason ?? '') || (s.handlingReason ?? '').startsWith('form is built by JavaScript'))
        : opts.recheck ? s.handling === 'staff' && /CAPTCHA|blocks automated/.test(s.handlingReason ?? '')
        : s.handling === 'unchecked' && cool(s)))
      .sort((a, b) => a.checkedAt - b.checkedAt).slice(0, limit).map(s => ({ id: s.id, url: s.url!, domain: s.domain }));
  }
  async setSiteSignupPage(id: string, url: string) {
    const s = this.sites.get(id); if (!s) return 'not_found' as const;
    if (dedupeKey(url) !== dedupeKey('https://' + s.domain)) return 'other_site' as const;
    s.url = url; s.handling = 'simple'; s.handlingReason = 'sign-up page set by staff'; s.needsStaff = s.automationPolicy === 'manual_only'; if (s.catalogState === 'research') s.catalogState = 'candidate';
    return 'ok' as const;
  }
  async setSiteSignupUrl(id: string, url: string) { const s = this.sites.get(id); if (s) s.url = url; }
  async recordSiteCheck(id: string, u: { handling?: 'simple' | 'staff' | 'unknown'; reason?: string; fingerprint?: string[] }, run?: { outcome: string }) {
    const s = this.sites.get(id); if (!s) return;
    s.checkedAt = ++this.checkClock; s.checkedAtMs = Date.now();
    if (u.handling) { s.handling = u.handling; s.handlingReason = u.reason ?? null; s.needsStaff = u.handling === 'staff' || s.automationPolicy === 'manual_only'; }
    if (u.fingerprint) s.fingerprint = u.fingerprint;
    if (run) s.runs.push({ outcome: run.outcome, at: new Date().toISOString() });
  }
  async siteRuns(id: string, limit: number) { return (this.sites.get(id)?.runs ?? []).slice(-limit); }
  async goodFingerprints() {
    return [...this.sites.values()].filter(s => !s.removedAt && s.handling === 'simple' && s.fingerprint.length).map(s => s.fingerprint);
  }

  async browserUnclearIds() {
    return [...this.sites.values()].filter(x => !x.removedAt && x.handling === 'unknown' && x.handlingReason === 'no sign-up form found, even in a browser').map(x => x.id);
  }
  clientSites = new Map<string, { clientId: string; siteId: string; status: ClientSiteStatus; note: string | null; seq: number }>();
  private csRow(cs: { siteId: string; status: ClientSiteStatus; note: string | null }): ClientSiteRow | null {
    const s = this.sites.get(cs.siteId); if (!s || s.removedAt) return null;   // removed sites disappear from every client's list
    return { siteId: s.id, name: s.name, domain: s.domain, url: s.url, category: s.category, handling: s.handling, handlingReason: s.handlingReason, needsStaff: s.needsStaff, status: cs.status, note: cs.note, restored: /^RESTORED:/.test(s.removedReason ?? '') };
  }
  async proposeClientSites(clientId: string, target: number | null, includeStaff: boolean) {
    const mine = [...this.clientSites.values()].filter(c => c.clientId === clientId);
    const taken = new Set(mine.map(c => c.siteId));
    const have = mine.filter(c => c.status !== 'skipped' && !this.sites.get(c.siteId)?.needsStaff).length;
    const room = target == null ? Infinity : Math.max(0, target - have);
    const reliability = await this.siteReliability();
    const usable = [...this.sites.values()].filter(s => !s.removedAt && s.catalogState !== 'research' && s.url && !taken.has(s.id))
      .sort((a, b) => (reliability[b.id]?.score ?? 50) - (reliability[a.id]?.score ?? 50) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    const plain = usable.filter(s => s.handling === 'simple' && !s.needsStaff).slice(0, room === Infinity ? undefined : room);
    const staff = includeStaff ? usable.filter(s => s.needsStaff && (s.handling === 'simple' || s.handling === 'staff')) : [];
    for (const s of [...staff, ...plain]) this.clientSites.set(clientId + ':' + s.id, { clientId, siteId: s.id, status: 'proposed', note: null, seq: this.clientSites.size });
    return staff.length + plain.length;
  }
  async listClientSites(clientId: string, f: { status?: ClientSiteStatus; limit: number; offset: number; hideStaff?: boolean; hasNote?: boolean; captcha?: boolean; notePrefixes?: string[]; restored?: boolean }) {
    const counts: Record<ClientSiteStatus, number> = { proposed: 0, approved: 0, skipped: 0, staff_fill: 0, done: 0, sent: 0 };
    const all: ClientSiteRow[] = [];
    for (const c of this.clientSites.values()) if (c.clientId === clientId) { const r = this.csRow(c); if (r && !(f.hideStaff && r.needsStaff)) { counts[c.status]++; all.push(r); } }
    all.sort((a, b) => Number(b.needsStaff) - Number(a.needsStaff) || a.name.localeCompare(b.name) || a.siteId.localeCompare(b.siteId));
    const rows = (f.status ? all.filter(r => r.status === f.status) : all).filter(r => !f.hasNote || !!r.note).filter(r => !f.notePrefixes?.length || f.notePrefixes.some(x => (r.note ?? '').toLowerCase().startsWith(x.toLowerCase()))).filter(r => !f.restored || r.restored).filter(r => !f.captcha || /^captcha/i.test(r.note ?? '') || /captcha/i.test(r.handlingReason ?? ''));
    return { total: rows.length, sites: rows.slice(f.offset, f.offset + f.limit), counts };
  }
  async approveProposedClientSites(clientId: string) {
    let n = 0;
    for (const c of this.clientSites.values()) if (c.clientId === clientId && c.status === 'proposed' && !this.sites.get(c.siteId)?.needsStaff) { c.status = 'approved'; n++; }
    return n;
  }
  async getClientSite(clientId: string, siteId: string) { const c = this.clientSites.get(clientId + ':' + siteId); return c ? this.csRow(c) : null; }
  async setClientSiteStatus(clientId: string, siteId: string, status: ClientSiteStatus, note: string | null) {
    const c = this.clientSites.get(clientId + ':' + siteId); if (!c) return false;
    c.status = status; c.note = note; return true;
  }
  logins: ClientLoginRow[] = [];
  async addClientLogin(clientId: string, siteId: string, encrypted: Buffer) {
    const s = this.sites.get(siteId);
    this.logins.push({ id: randomUUID(), clientId, siteId, siteName: s?.name ?? '', domain: s?.domain ?? '', encrypted, createdAt: new Date() });
  }
  async listClientLogins(clientId: string) { return this.logins.filter(l => l.clientId === clientId).reverse(); }
  async knownDomains(keys: string[]) {
    const have = new Set<string>([...this.sites.values()].map(x => x.domainKey), );
    for (const c of this.candidates.values()) have.add(c.domain);
    return new Set(keys.filter(k => have.has(k)));
  }
  async addCandidate(c: NewCandidate) {
    if ([...this.sites.values()].some(s => s.domainKey === c.domain) || [...this.candidates.values()].some(x => x.domain === c.domain)) return false;
    const id = randomUUID(); this.candidates.set(id, { ...c, id, state: 'pending' }); return true;
  }
  async listReviewCandidates(f: CandidateFilter) {
    const entries = [...this.candidates.values()].reverse().filter(c => {
      const blocked = /bot_blocked|robots_disallowed|automated.*block|blocked.*automated/i.test(c.handlingReason);
      const verified = c.handling === 'simple' && c.handlingReason.startsWith('Browser verified signup: ');
      const matches = f.view === 'dismissed' ? c.state === 'rejected' : c.state === 'pending' && (f.view === 'blocked' ? blocked : f.view === 'staff' ? c.handling === 'staff' && !blocked : f.view === 'qualified' ? verified : c.handling !== 'staff' && !blocked && !verified);
      return matches && (!f.q || (c.name + ' ' + c.domain + ' ' + c.handlingReason).toLowerCase().includes(f.q.toLowerCase()));
    });
    return { total: entries.length, entries: entries.slice(f.offset, f.offset + f.limit) };
  }
  async getReviewCandidate(id: string) { return this.candidates.get(id) || null; }
  async updateReviewCandidate(id: string, c: NewCandidate) {
    const row = this.candidates.get(id); if (!row || row.state !== 'pending') return false;
    this.candidates.set(id, { ...c, id, state: 'pending' }); return true;
  }
  async setCandidateReviewState(id: string, state: 'pending' | 'rejected') {
    const row = this.candidates.get(id); if (!row || !['pending','rejected'].includes(row.state)) return false;
    row.state = state; return true;
  }
  async pendingSimpleCandidates(limit: number): Promise<CandidateRow[]> {
    return [...this.candidates.values()].filter(c => c.state === 'pending' && c.handling === 'simple' && c.handlingReason.startsWith('Browser verified signup: '))
      .sort((a, b) => b.score - a.score).slice(0, limit).map(({ state, ...c }) => c);
  }
  async promoteCandidate(c: CandidateRow) {
    const cand = this.candidates.get(c.id); if (cand) cand.state = 'promoted';
    if ([...this.sites.values()].some(s => s.domainKey === c.domain)) return null;
    const row = {
      id: randomUUID(), domainKey: c.domain, name: c.name, domain: c.domain, url: c.url, category: c.category, automationPolicy: 'unknown',
      catalogState: 'candidate', removedAt: null as Date | null, removedReason: null as string | null, notes: null as string | null,
      handling: 'simple', handlingReason: c.handlingReason, needsStaff: false, fingerprint: c.fingerprint, runs: [] as RunRow[], checkedAt: 0, checkedAtMs: 0,
    };
    this.sites.set(row.id, row);
    const { domainKey, fingerprint, runs, checkedAt, checkedAtMs, ...out } = row; return out;
  }
  async candidateCounts() {
    const r = { simple: 0, staff: 0, unknown: 0 };
    for (const c of this.candidates.values()) if (c.state === 'pending') r[c.handling === 'simple' && !c.handlingReason.startsWith('Browser verified signup: ') ? 'unknown' : c.handling]++;
    return r;
  }

  async audit(e: { userId: string | null; clientId?: string | null; action: string; detail?: object }) {
    this.auditLog.push({ id: this.auditLog.length + 1, at: new Date(), userId: e.userId, clientId: e.clientId ?? null, action: e.action, detail: e.detail ?? {} });
  }
  async discoveryHistory(limit: number, offset: number) {
    const seen = new Set<string>();
    const entries = this.auditLog.slice().reverse().filter(e => {
      const d = e.detail as any;
      if (e.action !== 'discovery.run' || typeof d?.runId !== 'string') return false;
      const key = e.userId + ':' + d.runId;
      if (seen.has(key)) return false; seen.add(key); return true;
    });
    return { total: entries.length, entries: entries.slice(offset, offset + limit) };
  }
  async batchHistory(clientId: string, runId?: string): Promise<AuditEntry[]> {
    const seen = new Set<string>();
    return this.auditLog.slice().reverse().filter(e => {
      const d = e.detail as any;
      if (e.clientId !== clientId || e.action !== 'batch.progress' || runId && d.runId !== runId || seen.has(d.runId)) return false;
      seen.add(d.runId); return true;
    }).slice(0, 50);
  }
  async listAudit(clientId?: string) {
    return this.auditLog.filter(a => !clientId || a.clientId === clientId).slice().reverse();
  }
  async siteReliability(siteIds?: string[]) {
    const allowed = siteIds ? new Set(siteIds) : null;
    const seen = new Set<string>(), rows: { siteId: string; at: Date; outcome: unknown }[] = [];
    const cutoff = Date.now() - 90 * 86400000;
    for (const event of this.auditLog.slice().reverse()) {
      if (event.action !== 'submission.result' || event.at.getTime() < cutoff) continue;
      const d = event.detail as any;
      if (typeof d?.siteId !== 'string' || allowed && !allowed.has(d.siteId)) continue;
      const key = (event.clientId || '') + ':' + (d.attemptId || event.id);
      if (seen.has(key)) continue; seen.add(key);
      rows.push({ siteId: d.siteId, at: event.at, outcome: d.outcome });
    }
    return summarizeSiteReliability(rows);
  }
  async listSubmissionResults(clientId: string, f: ResultFilter): Promise<ResultHistory> {
    const entries: SubmissionRecord[] = [];
    const counts = { confirmed: 0, unconfirmed: 0, not_sent: 0 };
    const visibility = new Map<number, boolean>();
    for (const event of this.auditLog) {
      const d = event.detail as any;
      if (event.clientId === clientId && event.action === 'submission.visibility' && Number.isSafeInteger(d?.resultId)) visibility.set(d.resultId, d.dismissed === true);
    }
    const seen = new Set<string>();
    for (const event of this.auditLog.slice().reverse()) {
      if (event.clientId !== clientId || event.action !== 'submission.result') continue;
      const d = event.detail as any;
      const result: unknown = d?.outcome;
      if (!d || !isSubmissionOutcome(result)) continue;
      const attemptId = d.attemptId || String(event.id);
      if (seen.has(attemptId)) continue;
      seen.add(attemptId);
      const cs = this.clientSites.get(clientId + ':' + d.siteId), site = this.sites.get(d.siteId);
      if (!cs || !site || f.hideStaff && site.needsStaff) continue;
      const dismissed = visibility.get(event.id) === true;
      if (dismissed && !f.includeDismissed || f.resultId !== undefined && event.id !== f.resultId) continue;
      counts[result.delivery]++;
      if (f.delivery && result.delivery !== f.delivery) continue;
      entries.push({ id: event.id, dismissed, at: event.at, siteId: site.id, name: site.name, domain: site.domain, url: site.url,
        siteStatus: cs.status, needsStaff: site.needsStaff, outcome: result });
    }
    return { total: entries.length, entries: entries.slice(f.offset, f.offset + f.limit), counts };
  }
}
