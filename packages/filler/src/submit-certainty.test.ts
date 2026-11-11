import { describe, it, expect } from 'vitest';
import { createFiller } from './filler';

async function practiceSession(options: { popup?: boolean; noButton?: boolean } = {}) {
  const calls = { clicks: 0, requestSubmit: 0, enter: 0 };
  const locator = (selector: string): any => ({
    first() { return this; }, nth() { return this; },
    count: async () => options.noButton && selector.includes('button') ? 0 : 1,
    fill: async () => {}, scrollIntoViewIfNeeded: async () => {},
    click: async () => { calls.clicks++; throw new Error('Click timed out after dispatch'); },
    press: async () => { calls.enter++; },
  });
  const page: any = {
    route: async () => {}, goto: async () => ({ status: () => 200 }),
    waitForLoadState: async () => {}, waitForTimeout: async () => {}, title: async () => 'Join our club',
    content: async () => '<form><input type="email" name="email"><button type="submit">Join</button></form>',
    url: () => 'https://practice.example/join', locator, getAttribute: async () => '/submit', on() {}, off() {},
    evaluate: async (script: any) => {
      if (typeof script === 'function') return 'Join our club';
      if (script.includes('var isControl')) return [{ idx: 0, tag: 'input', type: 'email', name: 'email', id: '', label: 'Email', placeholder: '', autocomplete: '', required: true, options: [] }];
      if (script.includes('.grecaptcha-badge')) return 'none';
      if (script.includes('var other = n.querySelector')) return !!options.popup;
      if (script.includes('var words =')) return false;
      if (script.includes("typeof f.requestSubmit==='function'")) return true;
      if (script.includes('f.requestSubmit();')) { calls.requestSubmit++; return false; }
      return undefined;
    },
  };
  const filler = createFiller({ popupWaitMs: 0, channels: [undefined],
    lookup: async () => [{ address: '93.184.216.34' }], fetchImpl: async () => new Response('User-agent: *\nAllow: /'),
    loader: async () => ({ chromium: { launch: async () => ({ on() {}, close: async () => {}, newContext: async () => ({ newPage: async () => page, close: async () => {} }) }) } }),
  });
  const session = await filler.prepare('https://practice.example/join', { email: 'practice@example.test' }, { screenshot: false });
  expect(session.report.status).toBe('ready_for_approval');
  return { filler, session, calls };
}

describe('submission certainty and duplicate avoidance', () => {
  it('reports a timed-out click as uncertain and never tries another send method', async () => {
    const { filler, session, calls } = await practiceSession();
    try {
      expect(await session.submit()).toMatchObject({ status: 'sent_unconfirmed', attempted: true });
      expect(calls).toEqual({ clicks: 1, requestSubmit: 0, enter: 0 });
    } finally { await session.close(); await filler.close(); }
  });
  it('reports an obstructing signup popup as stopped before sending', async () => {
    const { filler, session, calls } = await practiceSession({ popup: true });
    try {
      expect(await session.submit()).toMatchObject({ status: 'failed', attempted: false });
      expect(calls).toEqual({ clicks: 0, requestSubmit: 0, enter: 0 });
    } finally { await session.close(); await filler.close(); }
  });
  it('does not press Enter after an uncertain requestSubmit attempt', async () => {
    const { filler, session, calls } = await practiceSession({ noButton: true });
    try {
      expect(await session.submit()).toMatchObject({ status: 'sent_unconfirmed', attempted: true });
      expect(calls).toEqual({ clicks: 0, requestSubmit: 1, enter: 0 });
    } finally { await session.close(); await filler.close(); }
  });
});
