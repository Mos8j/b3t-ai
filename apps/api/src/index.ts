import pg from 'pg';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseCsvRecords } from '../../../packages/importer/src/index';
import { braveProvider, createBrowserChecker, openAiDiscovery } from '../../../packages/discovery/src/index';
import { createFiller, openAiFieldMapper } from '../../../packages/filler/src/index';
import { parseMasterKey } from '../../../packages/security/src/index';
import { createApp } from './server';
import { PgRepo } from './pg-repo';

function fail(msg: string): never { console.error(msg); process.exit(1); }
const need = (name: string) =>
  process.env[name] || fail(`${name} is missing. Copy .env.example to .env in the project folder, then run: npm run keygen`);

let masterKey: Buffer;
try { masterKey = parseMasterKey(need('MASTER_ENCRYPTION_KEY')); }
catch { fail('MASTER_ENCRYPTION_KEY is not a valid key. Run: npm run keygen  and paste the MASTER_ENCRYPTION_KEY line into .env'); }

const sessionSecret = need('SESSION_SECRET');
if (sessionSecret.length < 32) fail('SESSION_SECRET is too short or still the placeholder. Run: npm run keygen  and paste the SESSION_SECRET line into .env');

const pool = new pg.Pool({ connectionString: need('DATABASE_URL') });
try { await pool.query('SELECT 1'); }
catch (e: any) { fail(`Could not reach the database: ${e.message}\nIs Docker Desktop running? Start it with: npm run db:up`); }

// Your earlier link-check decisions (data/removed_sites.csv and data/needs_new_url.csv), if the files are there.
const dataDir = fileURLToPath(new URL('../../../data/', import.meta.url));
function readList(file: string): Record<string, string>[] {
  const f = dataDir + file;
  if (!existsSync(f)) return [];
  const [head, ...rows] = parseCsvRecords(readFileSync(f, 'utf8'));
  return rows.map(r => Object.fromEntries(head.map((h, i) => [h.trim(), r[i] ?? ''])));
}
const cleanup = {
  removed: Object.fromEntries(readList('removed_sites.csv').filter(r => r.domain).map(r => [r.domain, r.reason || 'removed after link check'])),
  research: readList('needs_new_url.csv').map(r => r.domain).filter(Boolean),
};

// The browser check is optional: it needs the Playwright package (installed by npm install) and a browser (Edge, Chrome or Chromium).
let browser = null;
let filler = null;
let handFiller = null;
const aiMapper = process.env.LLM_PROVIDER === 'openai' && process.env.LLM_API_KEY
  ? openAiFieldMapper(process.env.LLM_API_KEY, process.env.LLM_MODEL || 'gpt-4o-mini') : undefined;
try { await import('playwright' as string); browser = createBrowserChecker(); filler = createFiller({ aiMapper }); handFiller = createFiller({ headless: false, sessionMs: 30 * 60_000, popupWaitMs: 2000, aiMapper }); } catch { /* not installed: the buttons will explain */ }

const hosted = process.env.RENDER === 'true';
const setupToken = process.env.B3T_SETUP_TOKEN;
if (hosted && (!setupToken || setupToken.length < 32)) fail('Set B3T_SETUP_TOKEN to a random secret of at least 32 characters.');
const port = Number(process.env.PORT ?? 3000);
const server = createApp(new PgRepo(pool), { masterKey, sessionSecret, secureCookies: hosted || process.env.COOKIE_SECURE === 'true', setupToken, cleanup,
  siteCapacity: Number(process.env.SITE_CAPACITY ?? 2500) || 2500,
  browser, filler, handFiller: hosted ? null : handFiller,
  discoveryAi: process.env.LLM_PROVIDER === 'openai' && process.env.LLM_API_KEY ? openAiDiscovery(process.env.LLM_API_KEY, process.env.LLM_MODEL || 'gpt-4o-mini') : null,
  search: process.env.SEARCH_PROVIDER === 'brave' && process.env.SEARCH_API_KEY ? braveProvider(process.env.SEARCH_API_KEY) : null,
});
// Listens on this computer only. Put it behind HTTPS before exposing it to anyone else.
server.listen(port, hosted ? '0.0.0.0' : '127.0.0.1', () => console.log(`UCAAS is running. Open http://localhost:${port} in your browser.`));
