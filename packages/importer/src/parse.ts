/** One row exactly as supplied by the user. Nothing here is ever dropped. */
export interface RawRow { line: number; name: string; url: string; category: string; notes: string }

const decodeEntities = (s: string) =>
  s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const stripTags = (s: string) => decodeEntities(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
const URLISH = /^(https?:\/\/)?([a-z0-9-]+\.)+[a-z]{2,}(\/\S*)?$/i;
export const looksLikeUrl = (s: string) => URLISH.test(s.trim());

export function parseBookmarkHtml(content: string): RawRow[] {
  return [...content.matchAll(/<A[^>]*HREF="([^"]+)"[^>]*>([\s\S]*?)<\/A>/gi)].map((m, i) => ({
    line: i + 1, name: stripTags(m[2]), url: decodeEntities(m[1]), category: '', notes: '',
  }));
}

/** RFC-4180-style CSV: quoted fields, escaped quotes, commas/newlines inside quotes, BOM. */
export function parseCsvRecords(content: string): string[][] {
  const s = content.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [], cur = '', inQ = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQ) {
      if (c === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cur); cur = ''; rows.push(row); row = [];
    } else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim() !== ''));
}

export function parseCsv(content: string): RawRow[] {
  const recs = parseCsvRecords(content);
  if (!recs.length) return [];
  const header = recs[0].map(h => h.trim().toLowerCase());
  const find = (re: RegExp) => header.findIndex(h => re.test(h));
  let urlIdx = find(/^(url|link|website|web\s*site|site|address|domain)$/);
  let body = recs;
  let nameIdx = -1, catIdx = -1, notesIdx = -1;
  if (urlIdx >= 0) { // has a header row
    body = recs.slice(1);
    nameIdx = find(/^(name|title|site\s*name|company|brand)$/);
    catIdx = find(/^(category|type)$/);
    notesIdx = find(/^(notes?|comments?|description)$/);
  } else { // headerless: use the column that most looks like URLs
    const width = Math.max(...recs.map(r => r.length));
    let best = -1, bestCount = 0;
    for (let c = 0; c < width; c++) {
      const n = recs.filter(r => looksLikeUrl(r[c] ?? '')).length;
      if (n > bestCount) { best = c; bestCount = n; }
    }
    urlIdx = best;
    if (best > 0) nameIdx = 0;
  }
  return body.map((r, i) => ({
    line: i + 1,
    name: (nameIdx >= 0 ? r[nameIdx] : '')?.trim() ?? '',
    url: (urlIdx >= 0 ? r[urlIdx] : '')?.trim() ?? '',
    category: (catIdx >= 0 ? r[catIdx] : '')?.trim() ?? '',
    // If there is no URL column at all, keep the raw row in notes so nothing is lost.
    notes: ((notesIdx >= 0 ? r[notesIdx] : urlIdx < 0 ? r.join(' | ') : '') ?? '').trim(),
  }));
}

const URL_IN_LINE = /(https?:\/\/[^\s,;|"'<>]+|(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s,;|"'<>]*)?)/i;
export function parseText(content: string): RawRow[] {
  return content.split(/\r?\n/).map(l => l.trim()).filter(Boolean).map((l, i) => {
    const m = l.match(URL_IN_LINE);
    if (!m) return { line: i + 1, name: l, url: '', category: '', notes: 'no URL found on this line' };
    const rest = (l.slice(0, m.index) + ' ' + l.slice((m.index ?? 0) + m[0].length)).replace(/^[\s,;|:-]+|[\s,;|:-]+$/g, '').trim();
    return { line: i + 1, name: rest, url: m[0], category: '', notes: '' };
  });
}

export function parseSiteList(filename: string, content: string): RawRow[] {
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  if (ext === 'xlsx' || ext === 'xls')
    throw new Error('Excel import is not built yet. In Excel use File > Save As > CSV, then import the CSV.');
  if (ext === 'html' || ext === 'htm' || (/<A\s[^>]*HREF=/i.test(content) && ext !== 'csv')) return parseBookmarkHtml(content);
  if (ext === 'csv') return parseCsv(content);
  return parseText(content);
}
