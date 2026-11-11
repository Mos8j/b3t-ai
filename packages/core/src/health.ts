/**
 * Site health policy: keep sites that run smoothly, drop sites that keep causing problems.
 * "Remove" is always a soft removal: the site moves to a removed list with its reason and can be restored.
 */
export type Outcome = 'ok' | 'dns_gone' | 'bad_certificate' | 'page_missing' | 'bot_blocked' | 'timeout' | 'form_failed';
export interface TestRun { outcome: Outcome; at: string }
export type HealthAction = 'keep' | 'watch' | 'remove' | 'needs_new_url' | 'manual_only';
export interface Health { action: HealthAction; reason: string }

/** How many of the most recent runs in a row have this outcome. */
function streak(runs: TestRun[], o: Outcome): number {
  let n = 0;
  for (let i = runs.length - 1; i >= 0 && runs[i].outcome === o; i--) n++;
  return n;
}

export function assessSiteHealth(runs: TestRun[]): Health {
  if (!runs.length) return { action: 'keep', reason: 'not tested yet' };
  const last = runs[runs.length - 1].outcome;
  switch (last) {
    case 'ok':
      return { action: 'keep', reason: 'last test passed' };
    case 'bad_certificate':
      return { action: 'remove', reason: 'invalid or expired security certificate; client data must not be sent' };
    case 'dns_gone':
      return streak(runs, 'dns_gone') >= 2
        ? { action: 'remove', reason: 'domain not found on 2 consecutive checks' }
        : { action: 'watch', reason: 'domain not found once; recheck before removing' };
    case 'page_missing':
      return { action: 'needs_new_url', reason: 'site is up but the registration page returned 404; find the new URL' };
    case 'bot_blocked':
      return { action: 'manual_only', reason: 'site blocks automation; guided manual handoff only (protections are never bypassed)' };
    case 'timeout':
      return streak(runs, 'timeout') >= 3
        ? { action: 'remove', reason: 'timed out on 3 consecutive checks' }
        : { action: 'watch', reason: `timed out ${streak(runs, 'timeout')} time(s) in a row` };
    case 'form_failed':
      return streak(runs, 'form_failed') >= 3
        ? { action: 'remove', reason: 'automated form test failed 3 times in a row' }
        : { action: 'watch', reason: `automated form test failed ${streak(runs, 'form_failed')} time(s) in a row` };
  }
}
