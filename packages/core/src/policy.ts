export type GrantKind = 'submit' | 'billing' | 'legal_declaration' | 'marketing_optin' | 'credit_inquiry';
export type Blocker = 'captcha' | 'mfa' | 'identity_verification';

export interface SiteInfo {
  automationPolicy: 'unknown' | 'allowed' | 'api_only' | 'manual_only';
  verifiedOfficial: boolean;
}
export interface FormInfo {
  hasPayment: boolean;
  recurringBilling: boolean;
  hasLegalDeclaration: boolean;
  hasMarketingOptIn: boolean;
  blockers: Blocker[];
  /** Application triggers a credit check (e.g. credit card / loan application): needs its own approval. */
  creditInquiry?: boolean;
  /** Sensitive fields (SSN, card number...) that only a human may type directly into the site. */
  manualInputFields?: string[];
}
export interface Decision {
  action: 'proceed' | 'await_human' | 'await_approval' | 'refuse';
  reasons: string[];
  missingGrants: GrantKind[];
}

/** Decides whether the worker may press the final submit button. Pure and deterministic. */
export function decideSubmission(site: SiteInfo, form: FormInfo, grants: Set<GrantKind>): Decision {
  const reasons: string[] = [];
  if (site.automationPolicy === 'manual_only' || site.automationPolicy === 'api_only')
    return { action: 'refuse', reasons: [`site policy ${site.automationPolicy}: use guided manual handoff / official API`], missingGrants: [] };
  if (!site.verifiedOfficial)
    return { action: 'refuse', reasons: ['site not verified as official'], missingGrants: [] };
  const manual = form.manualInputFields ?? [];
  if (form.blockers.length || manual.length)
    return {
      action: 'await_human',
      reasons: [
        ...form.blockers.map(b => `${b} requires a human; never bypassed`),
        ...manual.map(f => `field "${f}" must be typed by a person directly into the site; never stored`),
      ],
      missingGrants: [],
    };
  const needed: GrantKind[] = ['submit'];
  if (form.hasPayment || form.recurringBilling) needed.push('billing');
  if (form.hasLegalDeclaration) needed.push('legal_declaration');
  if (form.hasMarketingOptIn) needed.push('marketing_optin');
  if (form.creditInquiry) needed.push('credit_inquiry');
  const missing = needed.filter(g => !grants.has(g));
  if (missing.length) return { action: 'await_approval', reasons: missing.map(m => `missing explicit ${m} authorization`), missingGrants: missing };
  return { action: 'proceed', reasons, missingGrants: [] };
}
