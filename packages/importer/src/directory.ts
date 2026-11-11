import { normalizeUrl, dedupeKey } from '../../core/src/url';
import type { RawRow } from './parse';

export type CategoryName = 'subscription' | 'rewards' | 'membership' | 'employment' | 'other';

export interface DirectoryEntry {
  line: number; name: string; originalUrl: string; notes: string;
  normalizedUrl: string | null; domain: string | null;
  duplicateOfLine: number | null;
  suppliedCategory: string;
  category: CategoryName;
  /** 'heuristic' means a keyword guess, NOT a verified classification. */
  categorySource: 'supplied' | 'heuristic' | 'none';
  /** Credit, identity, banking, insurance, health-account sites: suggest manual-only handling. */
  sensitive: boolean;
  suggestedAutomationPolicy: 'manual_only' | 'unknown';
  status: 'ok' | 'duplicate' | 'unparseable';
}

const CATEGORY_RULES: [CategoryName, RegExp][] = [
  ['employment', /career|\bjobs?\b|hiring|recruit|employ|indeed|glassdoor|monster\.com/i],
  ['rewards', /reward|loyalty|points|perks|coupon|savings|deals|\bclub\b/i],
  ['subscription', /subscri|newsletter|magazine|sample|freebie|\bbox\b/i],
  ['membership', /member|association|society|\bjoin\b/i],
];
const SENSITIVE =
  /credit|loan|chexsystems|innovis|lexisnexis|factortrust|sagestream|optoutprescreen|corelogic|credco|\bbank|mortgage|healthcare\.gov|insurance|financ|ssa\.gov/i;

function fromSupplied(s: string): CategoryName {
  const m = CATEGORY_RULES.find(([, re]) => re.test(s));
  return m ? m[0] : 'other';
}

/** Turns raw rows into directory entries. Every input row yields exactly one entry (nothing is dropped). */
export function buildEntries(rows: RawRow[]): DirectoryEntry[] {
  const seen = new Map<string, number>();
  return rows.map((r): DirectoryEntry => {
    const normalizedUrl = r.url ? normalizeUrl(r.url) : null;
    const domain = normalizedUrl ? dedupeKey(normalizedUrl) : null;
    let duplicateOfLine: number | null = null;
    if (domain) {
      if (seen.has(domain)) duplicateOfLine = seen.get(domain)!;
      else seen.set(domain, r.line);
    }
    const hay = `${r.name} ${r.url}`;
    let category: CategoryName = 'other';
    let categorySource: DirectoryEntry['categorySource'] = 'none';
    if (r.category) { category = fromSupplied(r.category); categorySource = 'supplied'; }
    else {
      const m = CATEGORY_RULES.find(([, re]) => re.test(hay));
      if (m) { category = m[0]; categorySource = 'heuristic'; }
    }
    const sensitive = SENSITIVE.test(hay);
    return {
      line: r.line, name: r.name, originalUrl: r.url, notes: r.notes,
      normalizedUrl, domain, duplicateOfLine,
      suppliedCategory: r.category, category, categorySource,
      sensitive, suggestedAutomationPolicy: sensitive ? 'manual_only' : 'unknown',
      status: !normalizedUrl ? 'unparseable' : duplicateOfLine ? 'duplicate' : 'ok',
    };
  });
}

export function summarize(entries: DirectoryEntry[]) {
  const c = (f: (e: DirectoryEntry) => boolean) => entries.filter(f).length;
  return {
    total: entries.length, ok: c(e => e.status === 'ok'), duplicates: c(e => e.status === 'duplicate'),
    unparseable: c(e => e.status === 'unparseable'), sensitive: c(e => e.sensitive),
  };
}
