import { describe, it, expect } from 'vitest';
import { preparationOutcome, submissionOutcome, interruptedOutcome } from './submission-results';
import { MemoryRepo } from './memory-repo';
import type { FillReport } from '../../../packages/filler/src/index';

const report = (reason: string, needsHuman: string[] = []): FillReport => ({ status: 'needs_human', reason, needsHuman, filled: [], skipped: [], ticked: [] });

describe('accurate delivery and recovery guidance', () => {
  it('separates missing fields, permissions, and missing forms before sending', () => {
    expect(preparationOutcome(report('A person has to handle the items listed.', ['Last name (no information on file)']))).toMatchObject({ code: 'missing_information', delivery: 'not_sent', nextAction: 'profile' });
    expect(preparationOutcome(report('The client permission is not recorded'))).toMatchObject({ code: 'consent_required', nextAction: 'permissions' });
    expect(preparationOutcome(report('no fillable sign-up fields were found'))).toMatchObject({ code: 'form_not_found', nextAction: 'signup_page' });
  });
  it('does not label a failure after a send attempt as not sent or offer another send', () => {
    expect(submissionOutcome({ status: 'failed', attempted: true, detail: 'The site did not accept the form.' })).toMatchObject({ code: 'validation_error', delivery: 'unconfirmed', retryAllowed: false, nextAction: 'verify' });
    expect(submissionOutcome({ status: 'failed', detail: 'Unspecified failure' }).delivery).toBe('unconfirmed');
  });
  it('distinguishes a popup that stopped the send from uncertainty after a timeout', () => {
    expect(submissionOutcome({ status: 'failed', attempted: false, detail: 'Nothing was sent: a popup is covering the form.' })).toMatchObject({ code: 'popup_blocked', delivery: 'not_sent', nextAction: 'manual' });
    expect(interruptedOutcome(false, true)).toMatchObject({ code: 'timeout', delivery: 'unconfirmed', retryAllowed: false });
    expect(interruptedOutcome(true, true).delivery).toBe('not_sent');
  });
  it('preserves site evidence, redacts contacts, and keeps email confirmation distinct', () => {
    const result = submissionOutcome({ status: 'confirm_email', attempted: true, detail: 'Check your email.', evidence: 'Sent to alice@example.com or 415-555-0134' });
    expect(result).toMatchObject({ code: 'confirm_email', delivery: 'unconfirmed', nextAction: 'email', retryAllowed: false });
    expect(result.evidence).not.toContain('alice@example.com');
    expect(result.evidence).not.toContain('415-555-0134');
    expect(submissionOutcome({ status: 'confirmed', detail: 'Accepted.', evidence: 'Welcome aboard.' })).toMatchObject({ delivery: 'confirmed', evidence: 'Welcome aboard.', nextAction: 'none' });
  });
});

describe('saved submission history', () => {
  it('returns newest first, filters and paginates without the generic audit limit', async () => {
    const repo = new MemoryRepo();
    await repo.importSites('test', [], [{ name: 'Practice site', domain: 'practice.example', url: 'https://practice.example', category: 'other', automationPolicy: 'unknown', notes: '' }], { removed: {}, research: [] }, 'user');
    const site = [...repo.sites.values()][0];
    repo.clientSites.set('client:' + site.id, { clientId: 'client', siteId: site.id, status: 'sent', note: null, seq: 0 });
    for (let i = 0; i < 205; i++) await repo.audit({ userId: 'user', clientId: 'client', action: 'submission.result', detail: { siteId: site.id, outcome: interruptedOutcome(false) } });
    await repo.audit({ userId: 'user', clientId: 'client', action: 'submission.result', detail: { siteId: site.id, outcome: submissionOutcome({ status: 'confirmed', detail: 'Accepted.' }) } });
    const results = await repo.listSubmissionResults('client', { limit: 10, offset: 0 });
    expect(results.total).toBe(206);
    expect(results.entries[0].outcome.delivery).toBe('confirmed');
    expect(results.counts).toEqual({ confirmed: 1, unconfirmed: 205, not_sent: 0 });
    expect((await repo.listSubmissionResults('client', { limit: 10, offset: 200, delivery: 'unconfirmed' })).entries).toHaveLength(5);
    expect((await repo.listSubmissionResults('someone-else', { limit: 10, offset: 0 })).total).toBe(0);
    await repo.audit({ userId: 'user', clientId: 'client', action: 'submission.result', detail: { siteId: site.id, attemptId: 'same-attempt', outcome: interruptedOutcome(false, true) } });
    await repo.audit({ userId: 'user', clientId: 'client', action: 'submission.result', detail: { siteId: site.id, attemptId: 'same-attempt', outcome: submissionOutcome({ status: 'confirmed', detail: 'Late confirmation.' }) } });
    const updated = await repo.listSubmissionResults('client', { limit: 10, offset: 0 });
    expect(updated.total).toBe(207); // final outcome replaces the timeout for this attempt, rather than counting another attempt
    expect(updated.counts).toEqual({ confirmed: 2, unconfirmed: 205, not_sent: 0 });
    site.needsStaff = true;
    expect((await repo.listSubmissionResults('client', { limit: 10, offset: 0, hideStaff: true })).total).toBe(0);
  });
});
