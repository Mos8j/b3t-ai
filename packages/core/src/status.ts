export type AppStatus =
  | 'queued' | 'in_progress' | 'form_filled' | 'awaiting_approval' | 'awaiting_human'
  | 'submitting' | 'submitted' | 'confirmed' | 'failed' | 'skipped' | 'cancelled';

export type EvidenceKind = 'submit_response' | 'confirmation_page' | 'confirmation_number' | 'email_receipt';
export interface Evidence { kind: EvidenceKind; detail: Record<string, unknown> }

const TRANSITIONS: Record<AppStatus, AppStatus[]> = {
  queued: ['in_progress', 'skipped', 'cancelled'],
  in_progress: ['form_filled', 'awaiting_human', 'failed', 'skipped', 'cancelled'],
  form_filled: ['awaiting_approval', 'awaiting_human', 'failed', 'cancelled'],
  awaiting_approval: ['submitting', 'cancelled', 'skipped'],
  awaiting_human: ['in_progress', 'cancelled', 'skipped', 'failed'],
  submitting: ['submitted', 'failed', 'awaiting_human'],
  submitted: ['confirmed'],
  confirmed: [], failed: ['queued'], skipped: [], cancelled: [],
};

export function canTransition(from: AppStatus, to: AppStatus, evidence: Evidence[] = []): { ok: boolean; reason?: string } {
  if (!TRANSITIONS[from].includes(to)) return { ok: false, reason: `illegal transition ${from} -> ${to}` };
  if (to === 'submitted' && !evidence.some(e => e.kind === 'submit_response' || e.kind === 'confirmation_page'))
    return { ok: false, reason: 'submitted requires submission evidence' };
  if (to === 'confirmed' && !evidence.some(e => ['confirmation_page', 'confirmation_number', 'email_receipt'].includes(e.kind)))
    return { ok: false, reason: 'confirmed requires confirmation evidence' };
  return { ok: true };
}
