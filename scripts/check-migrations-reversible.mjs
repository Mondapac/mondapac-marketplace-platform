// Proves every migration is reversible (ADR-0004 decision 6): on a fresh, throwaway
// database apply all migrations (up), run every down.sql newest-first (down), check that
// nothing is left behind, then apply all migrations again (up).
//
// Usage: DATABASE_URL=postgresql://... node scripts/check-migrations-reversible.mjs
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(path.resolve('apps/api/package.json'));
const { Client } = require('pg');

try {
  process.loadEnvFile();
} catch {
  // No .env file: DATABASE_URL must come from the environment.
}

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error('DATABASE_URL is required.');
  process.exit(1);
}

const migrationsDir = path.resolve('prisma/migrations');
const migrations = readdirSync(migrationsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const missingDown = migrations.filter(
  (name) => !existsSync(path.join(migrationsDir, name, 'down.sql')),
);
if (missingDown.length > 0) {
  console.error(`Migrations without down.sql: ${missingDown.join(', ')}`);
  process.exit(1);
}

const scratchName = `migration_check_${randomBytes(6).toString('hex')}`;
const scratchUrl = new URL(baseUrl);
scratchUrl.pathname = `/${scratchName}`;

function migrateDeploy() {
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: scratchUrl.toString() },
    stdio: ['ignore', 'ignore', 'inherit'],
    shell: process.platform === 'win32',
  });
}

const admin = new Client({ connectionString: baseUrl });
await admin.connect();
let failed = false;
try {
  await admin.query(`CREATE DATABASE "${scratchName}"`);

  console.log(`up:   ${migrations.length} migration(s)`);
  migrateDeploy();

  const scratch = new Client({ connectionString: scratchUrl.toString() });
  await scratch.connect();
  try {
    for (const name of [...migrations].reverse()) {
      console.log(`down: ${name}`);
      await scratch.query(readFileSync(path.join(migrationsDir, name, 'down.sql'), 'utf8'));
    }

    // After all downs only empty schemas and Prisma's own bookkeeping table may remain.
    const leftovers = await scratch.query(`
      SELECT n.nspname || '.' || c.relname AS name
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
         AND c.relname <> '_prisma_migrations' AND c.relkind IN ('r', 'v', 'm', 'S', 'p')
      UNION ALL
      SELECT n.nspname || '.' || p.proname || '()'
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
      UNION ALL
      SELECT n.nspname || '.' || t.typname || ' (type)'
        FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
         AND t.typtype IN ('e', 'd')
    `);
    if (leftovers.rowCount > 0) {
      throw new Error(
        `down.sql left objects behind: ${leftovers.rows.map((row) => row.name).join(', ')}`,
      );
    }

    await scratch.query('DELETE FROM "_prisma_migrations"');
  } finally {
    await scratch.end();
  }

  console.log(`up:   ${migrations.length} migration(s) again`);
  migrateDeploy();
  console.log('Migrations are reversible.');
} catch (error) {
  failed = true;
  console.error(error instanceof Error ? error.message : error);
} finally {
  await admin.query(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`);
  await admin.end();
}
process.exit(failed ? 1 : 0);
