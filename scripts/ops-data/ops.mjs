#!/usr/bin/env node
// Reset and restore of the LOCAL operational test environment (operational test data design,
// phase 3). Called by scripts/ops-local.bat; the steps that need the API (the loader) are run by it.
//
//   node scripts/ops-data/ops.mjs wipe [--replace-unmarked]   empty database, roles re-granted, marked
//   node scripts/ops-data/ops.mjs backup                      save the finished database (pg_dump)
//   node scripts/ops-data/ops.mjs restore                     `fast`: bring the backup back
//   node scripts/ops-data/ops.mjs check [--fast]                      exit 3 when the database holds other data (the demo)
//   node scripts/ops-data/ops.mjs unlock                      clear a lock left by a crashed run
//
// Every command runs the guards first (guard.mjs: local development only, local URLs, a test-mode
// Stripe key). `wipe` and `restore` touch only a database that carries the operational test marker
// or has no tables; a database with other data (the demo) needs --replace-unmarked, which the .bat
// passes only after you typed YES. The database is dropped and created through the Compose
// container as its superuser, then handed to the migration role again with bootstrap-dev.sql; the
// backup is a pg_dump -Fc inside the container, without owners but with the table grants, restored as the owner.
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  DB_MARKER_SETTING,
  DB_MARKER_VALUE,
  ROOT,
  assertLocalDevelopment,
  assertStripeTestKey,
  loadDotEnv,
} from './guard.mjs';
import { beginReset, endReset, unlock } from './lock.mjs';
import { STATE_DIR } from './state.mjs';

export const BACKUP_DIR = resolve(STATE_DIR, 'backup');
const BOOTSTRAP = '/docker-entrypoint-initdb.d/10-bootstrap-dev.sql';

/** The migrations of this checkout, in order: what a backup must match to be restored. */
export function migrationNames(root = ROOT) {
  const dir = resolve(root, 'prisma/migrations');
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(resolve(dir, entry.name, 'migration.sql')))
    .map((entry) => entry.name)
    .sort();
}

/** Null when the backup's migrations are this checkout's, else what differs (for the message). */
export function migrationMismatch(saved, current) {
  const missing = saved.filter((name) => !current.includes(name));
  const added = current.filter((name) => !saved.includes(name));
  if (missing.length === 0 && added.length === 0) return null;
  return `${added.length} migration(s) added and ${missing.length} removed since the backup`;
}

function compose(args, options = {}) {
  return spawnSync('docker', ['compose', ...args], { cwd: ROOT, ...options });
}

function psql(database, ...statements) {
  const args = [
    'exec',
    '-T',
    'postgres',
    'psql',
    '-U',
    'postgres',
    '-d',
    database,
    '-v',
    'ON_ERROR_STOP=1',
  ];
  for (const statement of statements) args.push('-c', statement);
  const run = compose(args, { stdio: 'inherit' });
  if (run.status !== 0) {
    throw new Error(
      'Could not run psql in the Compose database container (is `docker compose up -d` done?).',
    );
  }
}

function databaseName(url) {
  const name = decodeURIComponent(new URL(url).pathname.slice(1));
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`unsupported database name "${name}"`);
  return name;
}

/** Runs a query in the Compose database container as its superuser; the answer's lines. */
function query(database, sql) {
  const run = compose(
    [
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      'postgres',
      '-d',
      database,
      '-v',
      'ON_ERROR_STOP=1',
      '-At',
      '-c',
      sql,
    ],
    { encoding: 'utf8' },
  );
  if (run.status !== 0) {
    throw new Error(
      'Could not query the Compose database container (is `docker compose up -d` done?).',
    );
  }
  return run.stdout.split(/\r?\n/).filter(Boolean);
}

/**
 * The marker of the database and whether it has tables, read in the same container that a wipe
 * would drop in (never through the URL, which could name another server on a forwarded port).
 */
function inspect(name) {
  if (query('postgres', `SELECT 1 FROM pg_database WHERE datname = '${name}'`).length === 0) {
    return { exists: false, marker: null, tables: 0 };
  }
  const settings = query(
    name,
    `SELECT unnest(s.setconfig) FROM pg_catalog.pg_db_role_setting s
       JOIN pg_catalog.pg_database d ON d.oid = s.setdatabase
      WHERE d.datname = '${name}' AND s.setrole = 0`,
  );
  const prefix = `${DB_MARKER_SETTING}=`;
  const marker = settings.find((entry) => entry.startsWith(prefix))?.slice(prefix.length) ?? null;
  const tables = Number(
    query(name, `SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'`)[0],
  );
  return { exists: true, marker, tables };
}

function recreateDatabase(name) {
  psql(
    'postgres',
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${name}' AND pid <> pg_backend_pid()`,
    `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`,
    `CREATE DATABASE "${name}" OWNER mondapac_migrator`,
  );
}

function bootstrap(name) {
  const run = compose(
    [
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      'postgres',
      '-d',
      name,
      '-v',
      'ON_ERROR_STOP=1',
      '-q',
      '-f',
      BOOTSTRAP,
    ],
    { stdio: 'inherit' },
  );
  if (run.status !== 0) throw new Error('bootstrap-dev.sql failed');
}

function flushRedis() {
  const run = compose(['exec', '-T', 'redis', 'redis-cli', 'FLUSHALL'], { stdio: 'inherit' });
  if (run.status !== 0)
    throw new Error('could not empty Redis (queues and sessions of the old data)');
}

function clearLoaderState() {
  if (!existsSync(STATE_DIR)) return;
  for (const file of readdirSync(STATE_DIR)) {
    if (file.endsWith('.json') && file !== 'lock.json') rmSync(resolve(STATE_DIR, file));
  }
}

function markDatabase() {
  const run = spawnSync(process.execPath, [resolve(ROOT, 'scripts/ops-data/mark-database.mjs')], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if (run.status !== 0) throw new Error('marking the database failed');
}

/** The backup's meta, or throws when there is none or it is not this code's. */
function readBackup() {
  const metaFile = resolve(BACKUP_DIR, 'meta.json');
  if (!existsSync(metaFile) || !existsSync(resolve(BACKUP_DIR, 'mondapac.dump'))) {
    throw new Error('There is no backup yet. Run a full reset first: scripts\\ops-local.bat reset');
  }
  const meta = JSON.parse(readFileSync(metaFile, 'utf8'));
  const mismatch = migrationMismatch(meta.migrations, migrationNames());
  if (mismatch) {
    throw new Error(
      `The backup does not match this code (${mismatch}). Run a full reset: scripts\\ops-local.bat reset`,
    );
  }
  return meta;
}

async function main() {
  const command = process.argv[2];
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: {
      'replace-unmarked': { type: 'boolean', default: false },
      // check --fast: also check that a backup exists and matches this code (before windows close)
      fast: { type: 'boolean', default: false },
    },
  });
  if (!['wipe', 'backup', 'restore', 'check', 'unlock'].includes(command)) {
    console.error('usage: node scripts/ops-data/ops.mjs wipe|backup|restore|check|unlock');
    process.exit(2);
  }
  if (command === 'unlock') {
    unlock(STATE_DIR);
    console.log('Lock cleared.');
    return;
  }

  loadDotEnv();
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) throw new Error('MIGRATION_DATABASE_URL is not set (copy .env.example to .env).');
  assertLocalDevelopment({
    urls: {
      MIGRATION_DATABASE_URL: url,
      ...(process.env.DATABASE_URL ? { DATABASE_URL: process.env.DATABASE_URL } : {}),
    },
  });
  assertStripeTestKey(process.env.STRIPE_SECRET_KEY);
  const name = databaseName(url);

  if (command === 'wipe' || command === 'restore' || command === 'check') {
    const state = inspect(name);
    if (
      state.exists &&
      state.marker !== DB_MARKER_VALUE &&
      state.tables > 0 &&
      !values['replace-unmarked']
    ) {
      console.error(
        `The database "${name}" holds tables and is not marked as an operational test database ` +
          `(for example the demo's). Not touching it. Run: scripts\\ops-local.bat reset`,
      );
      process.exit(3);
    }
    if (command === 'check') {
      if (values.fast) readBackup();
      return;
    }
  }

  if (command === 'wipe') {
    beginReset(STATE_DIR, 'reset');
    recreateDatabase(name);
    bootstrap(name);
    flushRedis();
    clearLoaderState();
    console.log(
      `Database ${name} is empty. Next: pnpm db:migrate, mark-database.mjs, the loader, then backup.`,
    );
    return;
  }

  if (command === 'backup') {
    const state = inspect(name);
    if (state.marker !== DB_MARKER_VALUE) {
      throw new Error('the database has no operational test marker; nothing to back up');
    }
    mkdirSync(BACKUP_DIR, { recursive: true });
    const dumpFile = resolve(BACKUP_DIR, 'mondapac.dump');
    // Written beside the old backup and renamed last, so a failed dump never costs the good one.
    const tmpDump = `${dumpFile}.tmp`;
    const out = openSync(tmpDump, 'w');
    let run;
    try {
      run = compose(
        [
          'exec',
          '-T',
          'postgres',
          'pg_dump',
          '-U',
          'mondapac_migrator',
          '-d',
          name,
          '-Fc',
          '--no-owner',
        ],
        { stdio: ['ignore', out, 'inherit'] },
      );
    } finally {
      closeSync(out);
    }
    if (run.status !== 0) {
      rmSync(tmpDump, { force: true });
      throw new Error('pg_dump failed');
    }
    // The loader's state goes with the data: it holds the admin's authenticator secret.
    const states = existsSync(STATE_DIR)
      ? readdirSync(STATE_DIR).filter((f) => f.endsWith('.json') && f !== 'lock.json')
      : [];
    mkdirSync(resolve(BACKUP_DIR, 'state'), { recursive: true });
    for (const file of states)
      copyFileSync(resolve(STATE_DIR, file), resolve(BACKUP_DIR, 'state', file));
    const tmpMeta = resolve(BACKUP_DIR, 'meta.json.tmp');
    writeFileSync(
      tmpMeta,
      `${JSON.stringify({ createdAt: new Date().toISOString(), database: name, migrations: migrationNames(), states }, null, 2)}\n`,
    );
    renameSync(tmpDump, dumpFile);
    renameSync(tmpMeta, resolve(BACKUP_DIR, 'meta.json'));
    endReset(STATE_DIR);
    console.log(`Backup saved in .local/ops-data/backup (${states.length} loader state file(s)).`);
    return;
  }

  // restore (the `fast` mode)
  const meta = readBackup();
  const dumpFile = resolve(BACKUP_DIR, 'mondapac.dump');
  beginReset(STATE_DIR, 'fast restore');
  recreateDatabase(name);
  bootstrap(name);
  const input = openSync(dumpFile, 'r');
  let run;
  try {
    run = compose(
      [
        'exec',
        '-T',
        'postgres',
        'pg_restore',
        '-U',
        'mondapac_migrator',
        '-d',
        name,
        '--no-owner',
        '--exit-on-error',
      ],
      { stdio: [input, 'inherit', 'inherit'] },
    );
  } finally {
    closeSync(input);
  }
  if (run.status !== 0)
    throw new Error('pg_restore failed; run a full reset: scripts\\ops-local.bat reset');
  bootstrap(name);
  markDatabase();
  flushRedis();
  clearLoaderState();
  mkdirSync(STATE_DIR, { recursive: true });
  for (const file of meta.states)
    copyFileSync(resolve(BACKUP_DIR, 'state', file), resolve(STATE_DIR, file));
  endReset(STATE_DIR);
  console.log(`Restored the backup of ${meta.createdAt}.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
