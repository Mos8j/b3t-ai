import { describe, it, expect } from 'vitest';
import { parseBookmarkHtml, parseCsv, parseText, parseSiteList, buildEntries, summarize, toCsv } from './index';

describe('bookmark html', () => {
  it('extracts name and url, decodes entities, strips tags', () => {
    const rows = parseBookmarkHtml('<DT><A HREF="https://a.com/x?a=1&amp;b=2" ADD_DATE="1"><span class="s1">Site &amp; Co</span></A>');
    expect(rows).toHaveLength(1);
    expect(rows[0].url).toBe('https://a.com/x?a=1&b=2');
    expect(rows[0].name).toBe('Site & Co');
  });
});

describe('csv', () => {
  it('reads header columns, quoted commas and notes', () => {
    const rows = parseCsv('Name,URL,Category,Notes\n"Acme, Inc",acme.com,rewards,"my note, with comma"\n');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ line: 1, name: 'Acme, Inc', url: 'acme.com', category: 'rewards', notes: 'my note, with comma' });
  });
  it('handles headerless name,url files', () => {
    const rows = parseCsv('Netflix,https://netflix.com\nCostco,costco.com\n');
    expect(rows).toHaveLength(2);
    expect(rows[1].name).toBe('Costco');
    expect(rows[1].url).toBe('costco.com');
  });
});

describe('plain text', () => {
  it('finds urls in mixed lines and keeps lines without one', () => {
    const rows = parseText('Netflix https://www.netflix.com/signup\ncostco.com\njust some words\n');
    expect(rows).toHaveLength(3);
    expect(rows[0].url).toBe('https://www.netflix.com/signup');
    expect(rows[0].name).toBe('Netflix');
    expect(rows[1].url).toBe('costco.com');
    expect(rows[2].url).toBe('');
    expect(rows[2].name).toBe('just some words');
  });
});

describe('format detection', () => {
  it('rejects xlsx with a clear message instead of guessing', () => {
    let msg = '';
    try { parseSiteList('list.xlsx', 'x'); } catch (e: any) { msg = e.message; }
    expect(msg).toContain('Save As > CSV');
  });
});

describe('directory building', () => {
  const rows = parseText('A https://www.a.com/join\nA again a.com/other\nbroken line\nChexSystems https://chexsystems.eto.fiscloudservices.com/#/registration\n');
  const entries = buildEntries(rows);
  it('keeps every row: duplicates flagged, unparseable kept', () => {
    expect(entries).toHaveLength(4);
    expect(entries.map(e => e.status)).toEqual(['ok', 'duplicate', 'unparseable', 'ok']);
    expect(entries[1].duplicateOfLine).toBe(1);
    expect(summarize(entries)).toEqual({ total: 4, ok: 2, duplicates: 1, unparseable: 1, sensitive: 1 });
  });
  it('suggests manual-only for sensitive sites and keeps #/ routes', () => {
    expect(entries[3].sensitive).toBe(true);
    expect(entries[3].suggestedAutomationPolicy).toBe('manual_only');
    expect(entries[3].normalizedUrl).toBe('https://chexsystems.eto.fiscloudservices.com/#/registration');
  });
  it('labels category source honestly', () => {
    const e = buildEntries(parseCsv('name,url,category\nX,x.com,Rewards program\nNewsletter Y,y.com,\nZ,z.com,\n'));
    expect(e[0].categorySource).toBe('supplied');
    expect(e[0].category).toBe('rewards');
    expect(e[1].categorySource).toBe('heuristic');
    expect(e[2].categorySource).toBe('none');
  });
});

describe('csv export', () => {
  it('round-trips names with quotes and commas and keeps original url and notes', () => {
    const entries = buildEntries(parseCsv('name,url,notes\n"He said ""hi"", ok",hi.com,"keep, me"\n'));
    const back = parseCsv(toCsv(entries));
    expect(back).toHaveLength(1);
    expect(back[0].name).toBe('He said "hi", ok');
    expect(back[0].url).toBe('hi.com');
    expect(back[0].notes).toBe('keep, me');
  });
});
