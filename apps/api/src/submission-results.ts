import type { FillReport, SubmitResult } from '../../../packages/filler/src/index';
import { redact } from '../../../packages/security/src/index';

export type Delivery = 'confirmed' | 'unconfirmed' | 'not_sent';
export interface SubmissionOutcome {
  code: string;
  title: string;
  delivery: Delivery;
  detail: string;
  evidence?: string;
  nextAction: 'none' | 'verify' | 'email' | 'profile' | 'permissions' | 'signup_page' | 'preview' | 'manual';
  guidance: string;
  retryAllowed: boolean;
}
export interface SubmissionRecord {
  id: number; dismissed?: boolean; at: Date; siteId: string; name: string; domain: string; url: string | null;
  siteStatus: string; needsStaff: boolean; outcome: SubmissionOutcome;
}
export interface ResultFilter { limit: number; offset: number; hideStaff?: boolean; delivery?: Delivery; includeDismissed?: boolean; resultId?: number }
export interface ResultHistory { total: number; entries: SubmissionRecord[]; counts: Record<Delivery, number> }

function outcome(code: string, title: string, delivery: Delivery, detail: string, nextAction: SubmissionOutcome['nextAction'], guidance: string, evidence?: string): SubmissionOutcome {
  return { code, title, delivery, detail: redact(detail).slice(0, 1200), evidence: evidence ? redact(evidence).slice(0, 500) : undefined,
    nextAction, guidance, retryAllowed: delivery === 'not_sent' && ['profile', 'permissions', 'signup_page', 'preview'].includes(nextAction) };
}

export function preparationOutcome(report: FillReport): SubmissionOutcome {
  const detail = [report.reason, ...report.needsHuman].filter(Boolean).join(' ');
  if (report.captcha || /captcha|prove.*human|verify.*human/i.test(detail)) return outcome('captcha', 'Human check required', 'not_sent', detail, 'manual', 'Use “Fill it, I finish” to complete the human check and submit in the visible window.');
  if (report.status === 'refused') return outcome('unsupported_form', 'Automation stopped', 'not_sent', detail, 'manual', 'Review the site by hand. Payment, uploads, and restricted forms need a person.');
  if (report.status === 'blocked') return outcome('site_blocked', 'Site blocked the visit', 'not_sent', detail, 'manual', 'Open the site by hand. Automated attempts will not bypass the block.');
  if (/no information on file|no date of birth|missing (information|data)/i.test(detail)) return outcome('missing_information', 'Client information missing', 'not_sent', detail, 'profile', 'Complete the missing information in this client’s profile, save, then preview the form again.');
  if (/permission|consent/i.test(detail)) return outcome('consent_required', 'Permission needs review', 'not_sent', detail, 'permissions', 'Review the client’s recorded permissions. Record a permission only when the client has granted it, then preview again.');
  if (/no (fillable|sign-up)|nothing on this page could be filled|no.*form.*found/i.test(detail)) return outcome('form_not_found', 'Form not found', 'not_sent', detail, 'signup_page', 'Check the exact signup page address in the site directory, then preview again.');
  if (report.status === 'error') return outcome('preparation_error', 'Could not prepare the form', 'not_sent', detail, 'preview', 'Check the site and your connection, then use Preview first to inspect a fresh attempt.');
  return outcome('human_review', 'Fields need a person', 'not_sent', detail, 'manual', 'Use the visible hand-fill window to handle unfamiliar questions or choices.');
}

export function submissionOutcome(result: SubmitResult): SubmissionOutcome {
  const { status, detail, evidence } = result;
  if (status === 'confirmed') return outcome('confirmed', 'Confirmed by the site', 'confirmed', detail, 'none', 'Keep this confirmation as the result of this attempt.', evidence);
  if (status === 'confirm_email') return outcome('confirm_email', 'Email confirmation needed', 'unconfirmed', detail, 'email', 'Check the client’s inbox and complete the site’s confirmation steps. Verify the result before marking it done.', evidence);
  if (status === 'already_member') return outcome('already_member', 'Existing membership reported', 'unconfirmed', detail, 'verify', 'Check the existing membership or confirmation email. Do not send another application without checking.', evidence);
  if (status === 'blocked') return outcome('site_blocked', 'Human check or site block', result.attempted === false ? 'not_sent' : 'unconfirmed', detail, 'manual', 'Check the site in a visible browser. A submission may have been attempted; verify it before sending again.', evidence);
  if (status === 'failed' && result.attempted === false) {
    if (/pop.?up|overlay|covering/i.test(detail)) return outcome('popup_blocked', 'Popup blocked submission', 'not_sent', detail, 'manual', 'Use “Fill it, I finish” to dismiss the popup and inspect the form before sending.', evidence);
    return outcome('not_dispatched', 'Stopped before sending', 'not_sent', detail, 'preview', 'Resolve the issue described here, then preview a fresh form before sending.', evidence);
  }
  if (status === 'failed') return outcome('validation_error', 'Site reported a problem', 'unconfirmed', detail, 'verify', 'Read the site’s error and check for an existing submission before editing or trying again.', evidence);
  if (result.likely) return outcome('likely_sent', 'Site response needs verification', 'unconfirmed', detail, 'verify', 'The site responded, but acceptance is not confirmed. Check the site or email before any retry.', evidence);
  return outcome('unconfirmed', 'Submission needs verification', 'unconfirmed', detail, 'verify', 'Check the site or confirmation email before retrying. A missing confirmation does not prove that nothing was sent.', evidence);
}

export function interruptedOutcome(beforeSubmit: boolean, timeout = false): SubmissionOutcome {
  return outcome(timeout ? 'timeout' : 'technical_error', timeout ? 'Attempt timed out' : 'Attempt interrupted', beforeSubmit ? 'not_sent' : 'unconfirmed',
    beforeSubmit ? 'Preparation stopped before the software attempted to send the form.' : 'The attempt stopped without a reliable final result. It may have reached the site.',
    beforeSubmit ? 'preview' : 'verify', beforeSubmit ? 'Check the site and preview again.' : 'Verify the site or confirmation email before any retry.');
}

export function inProgressOutcome(): SubmissionOutcome {
  return outcome('in_progress', 'Attempt in progress', 'unconfirmed', 'A sending attempt is in progress. Its final result has not been recorded yet.',
    'verify', 'Wait for the final result. If this remains after an interruption or restart, verify the site before sending again.');
}

export function isSubmissionOutcome(value: any): value is SubmissionOutcome {
  return !!value && ['confirmed', 'unconfirmed', 'not_sent'].includes(value.delivery) && typeof value.title === 'string' && typeof value.detail === 'string'
    && typeof value.guidance === 'string' && ['none', 'verify', 'email', 'profile', 'permissions', 'signup_page', 'preview', 'manual'].includes(value.nextAction);
}

export interface SiteReliability { score: number; label: string; attempts: number; confirmed: number; siteIssues: number; unconfirmed: number; lastAttempt: string | null }
/** Counts only final outcomes, once per attempt. Client-specific missing data is not a site defect. */
export function summarizeSiteReliability(rows: { siteId: string; at: Date | string; outcome: unknown }[]): Record<string, SiteReliability> {
  const out: Record<string, SiteReliability> = {};
  const issues = new Set(['form_not_found', 'unsupported_form', 'site_blocked', 'popup_blocked', 'not_dispatched', 'preparation_error']);
  for (const row of rows) {
    if (!isSubmissionOutcome(row.outcome) || row.outcome.code === 'in_progress') continue;
    const value = row.outcome;
    const r = out[row.siteId] || (out[row.siteId] = { score: 50, label: 'Limited results', attempts: 0, confirmed: 0, siteIssues: 0, unconfirmed: 0, lastAttempt: null });
    r.attempts++;
    if (value.delivery === 'confirmed') r.confirmed++;
    else if (value.delivery === 'not_sent' && issues.has(value.code)) r.siteIssues++;
    if (value.delivery === 'unconfirmed') r.unconfirmed++;
    const at = new Date(row.at);
    if (Number.isFinite(at.getTime()) && (!r.lastAttempt || at > new Date(r.lastAttempt))) r.lastAttempt = at.toISOString();
  }
  for (const r of Object.values(out)) {
    // Two positive and two negative prior observations prevent one result from dominating.
    r.score = Math.round(100 * (r.confirmed + 2) / (r.confirmed + r.siteIssues + 4));
    r.label = r.siteIssues >= 2 && r.score < 50 ? 'Needs attention' : r.confirmed >= 3 && r.score >= 65 ? 'Repeated confirmations' : r.confirmed ? 'Some confirmations' : 'Limited results';
  }
  return out;
}
