// Usage: node scripts/check-links.mjs urls_to_check.txt results.csv   (Node 18+, no dependencies)
// Run this on your own machine. A site is "alive" if it answers with HTTP < 400 after redirects.
// 401/403/429 are reported as "blocked" (bot protection) rather than dead, so they are NOT removed.
import { readFileSync, writeFileSync } from 'node:fs';
const [, , input, output] = process.argv;
const urls = readFileSync(input, 'utf8').split('\n').map(s => s.trim()).filter(Boolean);
const CONCURRENCY = 10, TIMEOUT_MS = 15000;
const UA = 'Mozilla/5.0 (compatible; UCAAS-linkcheck/0.1)';

async function check(url) {
  for (const method of ['HEAD', 'GET']) {
    try {
      const r = await fetch(url, { method, redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'user-agent': UA } });
      if (method === 'HEAD' && r.status >= 400) continue; // many sites reject HEAD; retry with GET
      const status = r.status < 400 ? 'alive' : [401, 403, 429].includes(r.status) ? 'blocked' : 'dead';
      return { url, status, http: r.status, final_url: r.url };
    } catch (e) {
      if (method === 'GET') {
        const code = e?.cause?.code ?? e?.name ?? 'error';
        const dns = ['ENOTFOUND', 'EAI_AGAIN'].includes(code);
        return { url, status: dns ? 'dead' : 'unreachable', http: '', final_url: '', error: code };
      }
    }
  }
}
const results = []; let i = 0;
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (i < urls.length) { const u = urls[i++]; results.push(await check(u)); if (results.length % 25 === 0) console.log(`${results.length}/${urls.length}`); }
}));
const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
writeFileSync(output, ['url,status,http,final_url,error', ...results.map(r => [r.url, r.status, r.http, r.final_url, r.error].map(q).join(','))].join('\n'));
const tally = {}; for (const r of results) tally[r.status] = (tally[r.status] ?? 0) + 1;
console.log(tally);
