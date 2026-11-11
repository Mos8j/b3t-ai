// Usage: tsx scripts/import-bookmarks.ts <bookmarks.html> <outdir>
// Parses a browser bookmark export, preserves every original entry, normalizes URLs,
// flags duplicates, and writes a CSV. Category is a keyword HEURISTIC (provenance: heuristic, unverified).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { normalizeUrl, dedupeKey } from '../packages/core/src/url';

const [, , input, outDir] = process.argv;
const html = readFileSync(input, 'utf8');
const decode = (s: string) => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();

const rows = [...html.matchAll(/<A[^>]*HREF="([^"]+)"[^>]*>([\s\S]*?)<\/A>/gi)].map((m, i) => ({
  line: i + 1, original_url: m[1], name: decode(m[2]),
}));

const CATS: [string, RegExp][] = [
  ['employment', /career|jobs?\b|hiring|indeed|glassdoor|ziprecruiter|apply.*(work|job)|employ/i],
  ['rewards', /reward|loyalty|points|perks|coupon|savings|deals|club/i],
  ['subscription', /subscri|newsletter|magazine|sample|freebie|box/i],
  ['membership', /member|association|society|join/i],
];
const SENSITIVE = /credit|loan|chexsystems|innovis|lexisnexis|factortrust|sagestream|optoutprescreen|corelogic|bank|mortgage|healthcare\.gov|insurance|financ/i;

const seen = new Map<string, number>();
const out = rows.map(r => {
  const norm = normalizeUrl(r.original_url);
  const key = norm ? dedupeKey(norm) : null;
  let dupOf = '';
  if (key) { if (seen.has(key)) dupOf = String(seen.get(key)); else seen.set(key, r.line); }
  const hay = `${r.name} ${r.original_url}`;
  const cat = CATS.find(([, re]) => re.test(hay))?.[0] ?? 'other';
  return {
    ...r, normalized_url: norm ?? '', domain: key ?? '', duplicate_of_line: dupOf,
    category_heuristic: cat, sensitive_flag: SENSITIVE.test(hay) ? 'yes' : '',
  };
});

const q = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
const cols = ['line', 'name', 'original_url', 'normalized_url', 'domain', 'duplicate_of_line', 'category_heuristic', 'sensitive_flag'] as const;
mkdirSync(outDir, { recursive: true });
writeFileSync(`${outDir}/directory_import.csv`, [cols.join(','), ...out.map(r => cols.map(c => q((r as any)[c])).join(','))].join('\n'));
const unique = out.filter(r => !r.duplicate_of_line && r.normalized_url);
writeFileSync(`${outDir}/urls_to_check.txt`, unique.map(r => r.normalized_url).join('\n') + '\n');
const count = (f: (r: typeof out[0]) => boolean) => out.filter(f).length;
console.log(JSON.stringify({
  total: out.length, unparseable: count(r => !r.normalized_url), duplicates: count(r => !!r.duplicate_of_line),
  unique_domains: unique.length, sensitive: count(r => !!r.sensitive_flag),
  by_category: Object.fromEntries(['employment', 'rewards', 'subscription', 'membership', 'other'].map(c => [c, count(r => r.category_heuristic === c)])),
}, null, 1));
