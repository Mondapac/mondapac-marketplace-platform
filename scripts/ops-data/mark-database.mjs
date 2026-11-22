#!/usr/bin/env node
// Marks the local database as an operational test database, so the loader accepts it:
//
//   ALTER DATABASE <current> SET mondapac.env = 'ops-test'
//
// A database-level setting, written by the migration role (the database owner): no migration and
// no table, so a production database never has it. Run once on a fresh database; `ops reset`
// (phase 3) runs it again after every rebuild or restore.
//
//   node scripts/ops-data/mark-database.mjs
//
// The migration role may set this one parameter because scripts/db/bootstrap-dev.sql grants it
// (GRANT SET ON PARAMETER, development and CI clusters only). On a Compose volume created before
// that grant, run `pnpm db:bootstrap` once.
import {
  DB_MARKER_SETTING,
  DB_MARKER_VALUE,
  assertLocalDevelopment,
  loadDotEnv,
  readDatabaseMarker,
} from './guard.mjs';
import { connect } from './db.mjs';

loadDotEnv();
const url = process.env.MIGRATION_DATABASE_URL;
if (!url) {
  console.error('MIGRATION_DATABASE_URL is not set (copy .env.example to .env).');
  process.exit(1);
}
assertLocalDevelopment({ urls: { MIGRATION_DATABASE_URL: url } });

const db = await connect(url);
try {
  if ((await readDatabaseMarker(db)) === DB_MARKER_VALUE) {
    console.log('The database is already marked as an operational test database.');
  } else {
    const name = (await db.query('SELECT current_database() AS name')).rows[0].name;
    const quoted = `"${name.replaceAll('"', '""')}"`;
    try {
      await db.query(`ALTER DATABASE ${quoted} SET ${DB_MARKER_SETTING} = '${DB_MARKER_VALUE}'`);
    } catch (error) {
      if (error.code === '42501') {
        console.error(
          `The migration role may not set ${DB_MARKER_SETTING} yet, or does not own this database: run \`pnpm db:bootstrap\` once ` +
            '(it grants that one parameter on development clusters), then run this again.',
        );
        process.exit(1);
      }
      throw error;
    }
    console.log(`Marked database ${name} as an operational test database.`);
  }
} finally {
  await db.end();
}
