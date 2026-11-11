/** Jaccard overlap of two fingerprints: 0 (nothing alike) to 1 (identical). */
export function similarity(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const B = new Set(b);
  const inter = a.filter(x => B.has(x)).length;
  return inter / (a.length + b.length - inter);
}

/** How alike a candidate is to the sites that already work without staff: the mean of its 3 closest matches. */
export function scoreAgainst(candidate: string[], good: string[][]): number {
  const top = good.map(g => similarity(candidate, g)).sort((x, y) => y - x).slice(0, 3);
  return top.length ? Math.round((top.reduce((s, x) => s + x, 0) / top.length) * 1000) / 1000 : 0;
}
