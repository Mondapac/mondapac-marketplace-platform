import { Client } from 'pg';
import { migrationDatabaseUrl } from './test-database';

export default async function globalTeardown(): Promise<void> {
  const name = process.env.TEST_DATABASE_NAME;
  if (!name) return;

  const admin = new Client({ connectionString: migrationDatabaseUrl() });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}
