#!/usr/bin/env node
// Marks the local database as an operational test database, so the loader accepts it:
//
//   ALTER DATABASE <db> SET mondapac.env = 'ops-test'
//
// A database-level setting: no migration and no table, so a production database never has it.
// `mondapac.env` is a placeholder setting, which only a superuser may set at database level, and
// the roles of the platform hold no parameter grant (docs/design/data/platform.md 10.5). So this
// runs as the local cluster superuser, the way `pnpm db:bootstrap` does: through the Compose
// container, or with OPS_SUPERUSER_DATABASE_URL for a native PostgreSQL on this machine. Run it
// once on a fresh database; `ops reset` (phase 3) runs it again after every rebuild or restore.
//
//   node scripts/ops-data/mark-database.mjs
import { spawnSync } from 'node:child_process';
import { connect } from './db.mjs';
import {
  DB_MARKER_SETTING,
  DB_MARKER_VALUE,
  ROOT,
  assertLocalDevelopment,
  loadDotEnv,
  readDatabaseMarker,
} from './guard.mjs';

loadDotEnv();
const url = process.env.MIGRATION_DATABASE_URL;
if (!url) {
  console.error('MIGRATION_DATABASE_URL is not set (copy .env.example to .env).');
  process.exit(1);
}
const superuserUrl = process.env.OPS_SUPERUSER_DATABASE_URL;
assertLocalDevelopment({
  urls: {
    MIGRATION_DATABASE_URL: url,
    ...(superuserUrl ? { OPS_SUPERUSER_DATABASE_URL: superuserUrl } : {}),
  },
});

const db = await connect(url);
try {
  if ((await readDatabaseMarker(db)) === DB_MARKER_VALUE) {
    console.log('The database is already marked as an operational test database.');
    process.exit(0);
  }
  const name = (await db.query('SELECT current_database() AS name')).rows[0].name;
  const statement = `ALTER DATABASE "${name.replaceAll('"', '""')}" SET ${DB_MARKER_SETTING} = '${DB_MARKER_VALUE}'`;
  if (superuserUrl) {
    const admin = await connect(superuserUrl);
    try {
      await admin.query(statement);
    } finally {
      await admin.end();
    }
  } else {
    const run = spawnSync(
      'docker',
      [
        'compose',
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
        '-c',
        statement,
      ],
      { cwd: ROOT, stdio: 'inherit' },
    );
    if (run.status !== 0) {
      console.error(
        'Could not reach the Compose database as its superuser. On a native PostgreSQL, set ' +
          'OPS_SUPERUSER_DATABASE_URL (a superuser on this machine) and run this again, or run as ' +
          `the superuser: ${statement};`,
      );
      process.exit(1);
    }
  }
  if ((await readDatabaseMarker(db)) !== DB_MARKER_VALUE)
    throw new Error('the marker is still missing after ALTER DATABASE');
  console.log(`Marked database ${name} as an operational test database.`);
} finally {
  await db.end();
}
