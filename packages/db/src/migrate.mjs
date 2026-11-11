// Applies db/migrations/*.sql in order, once each, and records them in schema_migrations.
// Usage: npm run db:migrate   (or  npm run db:status  to only list what is pending)
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'db', 'migrations');
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set. Copy .env.example to .env in the project folder first.');
  process.exit(1);
}
const statusOnly = process.argv.includes('--status');

const client = new pg.Client({ connectionString: url });
try {
  await client.connect();
} catch (e) {
  console.error(`Could not connect to the database: ${e.message}`);
  console.error('Is Docker Desktop running, and did you start the database with: npm run db:up ?');
  process.exit(1);
}

await client.query(
  'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())'
);
const applied = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map(r => r.name));
const files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort();

for (const f of files) {
  if (applied.has(f)) { console.log(`  already applied: ${f}`); continue; }
  if (statusOnly) { console.log(`  PENDING: ${f}`); continue; }
  try {
    await client.query('BEGIN');
    await client.query(readFileSync(join(dir, f), 'utf8'));
    await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
    await client.query('COMMIT');
    console.log(`  applied: ${f}`);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(`  FAILED: ${f}: ${e.message}`);
    await client.end();
    process.exit(1);
  }
}

const t = await client.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'");
console.log(`Done. ${t.rows[0].n} tables in the database.`);
await client.end();
