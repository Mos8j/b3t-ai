import type { Role } from '../../../packages/security/src/index';
import type { ResultFilter, ResultHistory, SiteReliability } from './submission-results';

export interface UserRow { id: string; email: string; passwordHash: string; role: Role; disabledAt: Date | null }
export interface ClientRow {
  ownerId?: string | null;
  id: string; displayName: string; encryptedProfile: Buffer; wrappedDek: Buffer;
  retentionDays: number; createdAt: Date; deletedAt: Date | null;
}
export interface ConsentRow { scope: string; grantedAt: Date; revokedAt: Date | null }
export interface AuditEntry { id: number; at: Date; userId: string | null; clientId: string | null; action: string; detail: unknown }

export interface NewSite { name: string; domain: string; url: string; category: string; automationPolicy: 'manual_only' | 'unknown'; notes: string }
export interface Cleanup { removed: Record<string, string>; research: string[] } // keyed by domain
export interface SiteRow {
  id: string; name: string; domain: string; url: string | null; category: string; automationPolicy: string;
  catalogState: string; removedAt: Date | null; removedReason: string | null; notes: string | null;
  handling: string; handlingReason: string | null; needsStaff: boolean;
}
/** Put back from Removed for another try: its removal reason is kept with this start so the client pages can list "restored" sites. */
export const RESTORED = 'RESTORED: ';
export type SiteView = 'active' | 'staff' | 'research' | 'removed' | 'all';
export interface NewCandidate {
  domain: string; name: string; url: string; category: string; handling: 'simple' | 'staff' | 'unknown';
  handlingReason: string; fingerprint: string[]; score: number; source: 'search' | 'pasted';
}
export interface CandidateRow extends NewCandidate { id: string }
export type CandidateView = 'held' | 'blocked' | 'staff' | 'qualified' | 'dismissed';
export interface CandidateReviewRow extends CandidateRow { state: string }
export interface CandidateFilter { view: CandidateView; q?: string; limit: number; offset: number }
export interface RunRow { outcome: string; at: string }
export interface SiteFilter { q?: string; category?: string; view: SiteView; limit: number; offset: number }
export interface SiteCounts { active: number; research: number; removed: number; staff: number; unchecked: number; byCategory: Record<string, number> }

export type ClientSiteStatus = 'proposed' | 'approved' | 'skipped' | 'staff_fill' | 'done' | 'sent';
export interface ClientSiteRow {
  siteId: string; name: string; domain: string; url: string | null; category: string;
  handling: string; handlingReason: string | null; needsStaff: boolean; status: ClientSiteStatus; note: string | null;
  /** Put back from Removed for another try (see RESTORED). */
  restored: boolean;
}

export interface ClientLoginRow { id: string; clientId: string; siteId: string; siteName: string; domain: string; encrypted: Buffer; createdAt: Date }

/** Everything the API needs from storage. PgRepo is the real one; MemoryRepo is used in tests. */
export interface Repo {
  listStaff(): Promise<UserRow[]>;
  disableStaff(id: string, adminId: string): Promise<boolean>;
  countUsers(): Promise<number>;
  findUserByEmail(email: string): Promise<UserRow | null>;
  findUserById(id: string): Promise<UserRow | null>;
  createUser(u: { email: string; passwordHash: string; role: Role }): Promise<UserRow>; // throws Error('duplicate_email')

  createSession(tokenHash: string, userId: string, expiresAt: Date): Promise<void>;
  findSession(tokenHash: string): Promise<{ userId: string; expiresAt: Date } | null>;
  deleteSession(tokenHash: string): Promise<void>;
  deleteOtherSessions(userId: string, keepTokenHash: string): Promise<void>;
  updateUserLogin(id: string, change: { email?: string; passwordHash?: string }): Promise<UserRow>; // throws Error('duplicate_email')

  assignedClientIds(userId: string): Promise<string[]>;
  assignClient(userId: string, clientId: string): Promise<void>;

  createClient(c: { id: string; displayName: string; encryptedProfile: Buffer; wrappedDek: Buffer; ownerId?: string }): Promise<void>;
  getClient(id: string): Promise<ClientRow | null>;
  /** ids undefined = every client (admin); otherwise only those ids. Deleted clients are never returned. */
  listClients(ids?: string[]): Promise<{ id: string; displayName: string; createdAt: Date; ownerId?: string | null; ownerEmail?: string | null; ownerRole?: Role | null }[]>;
  updateClient(id: string, displayName: string, encryptedProfile: Buffer): Promise<void>;
  softDeleteClient(id: string): Promise<void>;

  addConsent(clientId: string, scope: string, recordedBy: string): Promise<void>;
  /** Ends every active record of this permission. Returns false when there was none. */
  revokeConsent(clientId: string, scope: string): Promise<boolean>;
  listConsents(clientId: string): Promise<ConsentRow[]>;

  /** Adds sites that are not already in the directory. Never changes or removes an existing site. The original rows are kept. */
  importSites(filename: string, originalRows: object[], sites: NewSite[], cleanup: Cleanup, userId: string):
    Promise<{ added: number; alreadyThere: number; cleanedRemoved: number; cleanedResearch: number }>;
  /** Active sites a browser also could not find a sign-up form on. */
  browserUnclearIds(): Promise<string[]>;
  /** Adds no-staff sites until the client has `target` that are not skipped (null = every eligible site). Staff-only sites do NOT count toward the target: when includeStaff is true, every eligible staff-only site is added as well. Returns how many were added. */
  proposeClientSites(clientId: string, target: number | null, includeStaff: boolean): Promise<number>;
  listClientSites(clientId: string, f: { status?: ClientSiteStatus; limit: number; offset: number; hideStaff?: boolean; hasNote?: boolean; captcha?: boolean; notePrefixes?: string[]; restored?: boolean }): Promise<{ total: number; sites: ClientSiteRow[]; counts: Record<ClientSiteStatus, number> }>;
  /** Approves every suggested site that does not need staff. Returns how many. */
  approveProposedClientSites(clientId: string, userId: string): Promise<number>;
  getClientSite(clientId: string, siteId: string): Promise<ClientSiteRow | null>;
  setClientSiteStatus(clientId: string, siteId: string, status: ClientSiteStatus, note: string | null, userId: string | null): Promise<boolean>;
  addClientLogin(clientId: string, siteId: string, encrypted: Buffer, userId: string | null): Promise<void>;
  listClientLogins(clientId: string): Promise<ClientLoginRow[]>;
  /** Which of these address keys are already in the directory or the candidate pool. */
  knownDomains(keys: string[]): Promise<Set<string>>;
  listSites(f: SiteFilter): Promise<{ total: number; sites: SiteRow[] }>;
  siteCounts(): Promise<SiteCounts>;
  /** reason = a text removes the site (soft, reversible); null restores it. Returns null if no such site, else its page fingerprint. */
  setSiteRemoved(id: string, reason: string | null): Promise<{ fingerprint: string[] } | null>;
  /** Puts a removed site back and remembers that it was restored, so it can be retried and, if it still fails, removed for good. */
  setSiteDoNotWork(id: string, reason: string): Promise<boolean>;
  restoreSiteForRetry(id: string): Promise<boolean>;
  setSiteResearch(id: string): Promise<void>;

  /** Sites whose page has not been looked at yet. */
  /** recheck = look again at sites earlier marked staff because of a CAPTCHA or a block (use after the rules improve). browserPass = sites a plain fetch could not settle (no form found, built by JavaScript, or blocked) that a real browser may read. cooldownMs = skip sites looked at more recently than this. */
  /** Removed sites whose removal reason says no sign-up form was found, not looked at lately. */
  removedCheckQueue(limit: number, cooldownMs: number): Promise<{ id: string; url: string; domain: string }[]>;
  siteCheckQueue(limit: number, opts?: { recheck?: boolean; browserPass?: boolean; healthPass?: boolean; formSweep?: boolean; captchaPass?: boolean; cooldownMs?: number }): Promise<{ id: string; url: string; domain: string }[]>;
  setSiteSignupUrl(id: string, url: string): Promise<void>;
  /** Staff give the exact sign-up page. Must be on the same website. */
  setSiteSignupPage(id: string, url: string): Promise<'ok' | 'not_found' | 'other_site'>;
  recordSiteCheck(id: string, update: { handling?: 'simple' | 'staff' | 'unknown'; reason?: string; fingerprint?: string[] }, run?: { outcome: string }): Promise<void>;
  siteRuns(id: string, limit: number): Promise<RunRow[]>;
  /** Fingerprints of live sites known to need no staff. */
  goodFingerprints(): Promise<string[][]>;

  /** Returns false when the website is already a site or a candidate. */
  addCandidate(c: NewCandidate): Promise<boolean>;
  listReviewCandidates(filter: CandidateFilter): Promise<{ total: number; entries: CandidateReviewRow[] }>;
  getReviewCandidate(id: string): Promise<CandidateReviewRow | null>;
  updateReviewCandidate(id: string, candidate: NewCandidate): Promise<boolean>;
  setCandidateReviewState(id: string, state: 'pending' | 'rejected'): Promise<boolean>;
  pendingSimpleCandidates(limit: number): Promise<CandidateRow[]>;
  /** Turns a candidate into a directory site. Returns null if the website is already in the directory. */
  promoteCandidate(c: CandidateRow): Promise<SiteRow | null>;
  candidateCounts(): Promise<{ simple: number; staff: number; unknown: number }>;

  audit(entry: { userId: string | null; clientId?: string | null; action: string; detail?: object }): Promise<void>;
  discoveryHistory(limit: number, offset: number): Promise<{ total: number; entries: AuditEntry[] }>;
  batchHistory(clientId: string, runId?: string): Promise<AuditEntry[]>;
  listAudit(clientId?: string): Promise<AuditEntry[]>;
  /** Submission-only history, scoped to this client and the caller's staff visibility. */
  siteReliability(siteIds?: string[]): Promise<Record<string, SiteReliability>>;
  listSubmissionResults(clientId: string, filter: ResultFilter): Promise<ResultHistory>;
}
