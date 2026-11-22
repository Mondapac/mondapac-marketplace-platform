// The loader's database connection: the migration role (owner of the database), through the API's
// own `pg` package so the loader adds no dependency. Used for the guards (the operational test
// marker) and for the few reads the API has no route for; every business record is written
// through the API.
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { ROOT } from './guard.mjs';

/** A connected client of `url`; the caller ends it. */
export async function connect(url) {
  const { Client } = createRequire(resolve(ROOT, 'apps/api/package.json'))('pg');
  const db = new Client({ connectionString: url });
  await db.connect();
  return db;
}
