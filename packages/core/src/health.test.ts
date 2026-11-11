import { describe, it, expect } from 'vitest';
import { assessSiteHealth, type TestRun, type Outcome } from './health';

const runs = (...o: Outcome[]): TestRun[] => o.map((outcome, i) => ({ outcome, at: `2026-10-${10 + i}` }));

describe('site health policy', () => {
  it('keeps untested sites and sites whose latest test passed', () => {
    expect(assessSiteHealth([]).action).toBe('keep');
    expect(assessSiteHealth(runs('timeout', 'timeout', 'ok')).action).toBe('keep');
  });
  it('removes invalid certificates immediately', () => {
    expect(assessSiteHealth(runs('bad_certificate')).action).toBe('remove');
  });
  it('needs two consecutive DNS failures to remove', () => {
    expect(assessSiteHealth(runs('dns_gone')).action).toBe('watch');
    expect(assessSiteHealth(runs('dns_gone', 'dns_gone')).action).toBe('remove');
    expect(assessSiteHealth(runs('dns_gone', 'ok', 'dns_gone')).action).toBe('watch');
  });
  it('needs three consecutive timeouts; a pass resets the count', () => {
    expect(assessSiteHealth(runs('timeout', 'timeout')).action).toBe('watch');
    expect(assessSiteHealth(runs('timeout', 'timeout', 'timeout')).action).toBe('remove');
    expect(assessSiteHealth(runs('timeout', 'timeout', 'ok', 'timeout')).action).toBe('watch');
  });
  it('removes after three failed automated form tests', () => {
    expect(assessSiteHealth(runs('form_failed', 'form_failed')).action).toBe('watch');
    expect(assessSiteHealth(runs('form_failed', 'form_failed', 'form_failed')).action).toBe('remove');
  });
  it('never removes sites for 404s or bot protection', () => {
    expect(assessSiteHealth(runs('page_missing')).action).toBe('needs_new_url');
    expect(assessSiteHealth(runs('bot_blocked', 'bot_blocked', 'bot_blocked')).action).toBe('manual_only');
  });
});
