import { describe, it, expect } from 'vitest';
import { normalizeUrl, registrableDomain, dedupeSites, canTransition, decideSubmission, mapFields } from './index';

describe('url', () => {
  it('normalizes scheme, www, tracking, trailing slash', () => {
    expect(normalizeUrl('HTTP://www.Example.com/join/?utm_source=x&b=2&a=1#top')).toBe('https://example.com/join?a=1&b=2');
    expect(normalizeUrl('example.com')).toBe('https://example.com');
  });
  it('rejects junk and non-http', () => {
    expect(normalizeUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeUrl('notaurl')).toBeNull();
  });
  it('handles two-part suffixes', () => {
    expect(registrableDomain('https://shop.store.co.uk/x')).toBe('store.co.uk');
  });
  it('dedupes but keeps unparseable rows', () => {
    const r = dedupeSites([{ url: 'https://www.a.com' }, { url: 'a.com/join' }, { url: '???' }]);
    expect(r.unique).toHaveLength(2);
    expect(r.duplicates).toHaveLength(1);
  });
});

describe('status machine', () => {
  it('blocks submitted without evidence', () => {
    expect(canTransition('submitting', 'submitted').ok).toBe(false);
    expect(canTransition('submitting', 'submitted', [{ kind: 'submit_response', detail: {} }]).ok).toBe(true);
  });
  it('form_filled cannot jump to submitted', () => {
    expect(canTransition('form_filled', 'submitted', [{ kind: 'submit_response', detail: {} }]).ok).toBe(false);
  });
  it('confirmed requires confirmation evidence', () => {
    expect(canTransition('submitted', 'confirmed').ok).toBe(false);
    expect(canTransition('submitted', 'confirmed', [{ kind: 'confirmation_number', detail: { n: 'X' } }]).ok).toBe(true);
  });
});

const okSite = { automationPolicy: 'allowed', verifiedOfficial: true } as const;
const plain = { hasPayment: false, recurringBilling: false, hasLegalDeclaration: false, hasMarketingOptIn: false, blockers: [] as any[] };

describe('submission policy', () => {
  it('requires explicit submit grant', () => {
    expect(decideSubmission(okSite, plain, new Set()).action).toBe('await_approval');
    expect(decideSubmission(okSite, plain, new Set(['submit'])).action).toBe('proceed');
  });
  it('never bypasses captcha/mfa', () => {
    expect(decideSubmission(okSite, { ...plain, blockers: ['captcha'] }, new Set(['submit'])).action).toBe('await_human');
  });
  it('paid needs billing grant; legal needs legal grant', () => {
    const d = decideSubmission(okSite, { ...plain, recurringBilling: true, hasLegalDeclaration: true }, new Set(['submit']));
    expect(d.missingGrants).toEqual(['billing', 'legal_declaration']);
  });
  it('refuses manual-only and unverified sites', () => {
    expect(decideSubmission({ ...okSite, automationPolicy: 'manual_only' }, plain, new Set(['submit'])).action).toBe('refuse');
    expect(decideSubmission({ ...okSite, verifiedOfficial: false }, plain, new Set(['submit'])).action).toBe('refuse');
  });
});

describe('field mapping', () => {
  it('maps differently named fields and never invents', () => {
    const r = mapFields(
      [{ name: 'fname', label: 'Given Name', required: true },
       { name: 'f2', label: 'Surname', required: true },
       { name: 'x', label: 'Mobile', required: true },
       { name: 'q', label: 'Are you authorized to work?', required: true }],
      { firstName: 'Test', lastName: 'Person' });
    expect(r.values).toEqual({ fname: 'Test', f2: 'Person' });
    expect(r.missing).toEqual(['x']);
    expect(r.unmapped).toEqual(['q']);
  });
});

describe('hash routes', () => {
  it('keeps SPA routes but drops plain anchors', () => {
    expect(normalizeUrl('https://x.com/#/registration')).toBe('https://x.com/#/registration');
    expect(normalizeUrl('https://x.com/page#top')).toBe('https://x.com/page');
  });
});

describe('manual entry and credit inquiry', () => {
  it('pauses for a human when a sensitive field must be typed in', () => {
    const d = decideSubmission(okSite, { ...plain, manualInputFields: ['ssn'] }, new Set(['submit']));
    expect(d.action).toBe('await_human');
  });
  it('credit inquiries need their own grant', () => {
    const d = decideSubmission(okSite, { ...plain, creditInquiry: true }, new Set(['submit']));
    expect(d.action).toBe('await_approval');
    expect(d.missingGrants).toEqual(['credit_inquiry']);
  });
});

describe('sensitive fields are never auto-filled', () => {
  it('routes SSN/card fields to manual even if the profile has them', () => {
    const r = mapFields(
      [{ name: 'ssn', label: 'Social Security Number', required: true },
       { name: 'cc', label: 'Card number', required: true },
       { name: 'e', label: 'Email', required: true }],
      { email: 'a@b.com', ssn: '000-00-0000' });
    expect(r.values).toEqual({ e: 'a@b.com' });
    expect(r.manual).toEqual(['ssn', 'cc']);
  });
});
