import type { DirectoryEntry } from './directory';

const q = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const COLS: [string, (e: DirectoryEntry) => unknown][] = [
  ['line', e => e.line], ['name', e => e.name], ['url', e => e.originalUrl], ['normalized_url', e => e.normalizedUrl],
  ['domain', e => e.domain], ['duplicate_of_line', e => e.duplicateOfLine], ['category', e => e.category],
  ['category_source', e => e.categorySource], ['notes', e => e.notes], ['sensitive', e => (e.sensitive ? 'yes' : '')],
  ['suggested_automation_policy', e => e.suggestedAutomationPolicy], ['status', e => e.status],
];

/** Exports the directory to CSV (opens in Excel). Original url and notes are always included. */
export function toCsv(entries: DirectoryEntry[]): string {
  return [COLS.map(([h]) => h).join(','), ...entries.map(e => COLS.map(([, f]) => q(f(e))).join(','))].join('\n');
}
