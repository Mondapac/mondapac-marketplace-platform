// The production guards of the operational test data loader (and of the demo seed it replaces).
// The loader runs only when every one of them holds; there is no flag that switches any of them
// off (operational test data design, "guards: never on production"):
//   1. NODE_ENV is unset, development or test (the demo seed's strict rule, unchanged);
//   2. the API, the mail catcher and the database are on this machine;
//   3. the database carries the operational test marker in its database-level settings
//      (ALTER DATABASE ... SET mondapac.env = 'ops-test', no migration, no table);
//   4. a Stripe key, when one is set, is a test-mode key (sk_test_ or rk_test_).
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The database-level setting that marks an operational test database, and its one value. */
export const DB_MARKER_SETTING = 'mondapac.env';
export const DB_MARKER_VALUE = 'ops-test';

/** Reads the repository's `.env` without overriding variables already set (as the API does). */
export function loadDotEnv() {
  const file = resolve(ROOT, '.env');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const found = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (found && !(found[1] in process.env)) process.env[found[1]] = found[2];
  }
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const isLocalHost = (host) => LOCAL_HOSTS.has(host) || host.endsWith('.localhost');

/** Throws unless the environment is a local development one (guards 1 and 2). */
export function assertLocalDevelopment({ urls }) {
  const problems = [];
  const env = process.env.NODE_ENV;
  if (env !== undefined && env !== '' && env !== 'development' && env !== 'test') {
    problems.push(`NODE_ENV is "${env}"; this runs only in development or test`);
  }
  for (const [name, value] of Object.entries(urls)) {
    let host;
    try {
      const url = new URL(value);
      host = url.hostname;
      for (const key of ['host', 'hostaddr', 'service']) {
        if (url.searchParams.has(key)) problems.push(`${name} overrides the host with "${key}"`);
      }
    } catch {
      problems.push(`${name} is not a URL`);
      continue;
    }
    if (!isLocalHost(host)) problems.push(`${name} points at "${host}", not at this machine`);
  }
  if (problems.length > 0) {
    throw new Error(`This script refuses to run:\n  - ${problems.join('\n  - ')}`);
  }
}

/** Throws unless the Stripe key, when set, is a test-mode key (guard 4). Never prints the key. */
export function assertStripeTestKey(key) {
  if (key === undefined || key === '') return;
  if (!/^(sk|rk)_test_/.test(key)) {
    throw new Error(
      'This script refuses to run:\n  - STRIPE_SECRET_KEY is not a Stripe test-mode key (sk_test_ or rk_test_)',
    );
  }
}

/**
 * The marker of the connected database: its database-level value of `mondapac.env`, or null.
 * Read from pg_db_role_setting (the database's own setting, all roles), not current_setting(),
 * which any session can change with SET.
 */
export async function readDatabaseMarker(db) {
  const answer = await db.query(
    `SELECT s.setconfig FROM pg_catalog.pg_db_role_setting s
       JOIN pg_catalog.pg_database d ON d.oid = s.setdatabase
      WHERE d.datname = current_database() AND s.setrole = 0`,
  );
  const prefix = `${DB_MARKER_SETTING}=`;
  for (const entry of answer.rows[0]?.setconfig ?? []) {
    if (entry.startsWith(prefix)) return entry.slice(prefix.length);
  }
  return null;
}

/** Throws unless the connected database carries the operational test marker (guard 3). */
export async function assertDatabaseMarker(db) {
  const marker = await readDatabaseMarker(db);
  if (marker !== DB_MARKER_VALUE) {
    throw new Error(
      'This script refuses to run:\n  - the database has no operational test marker ' +
        `(${DB_MARKER_SETTING} = '${DB_MARKER_VALUE}'${marker === null ? '' : `; it has '${marker}'`}).\n` +
        '    If this is your local test database, run: node scripts/ops-data/mark-database.mjs',
    );
  }
}
