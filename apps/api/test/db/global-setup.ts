import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { applicationDatabaseUrl, migrationDatabaseUrl, REPO_ROOT } from './test-database';

/**
 * Creates a fresh database for this run as the migration role and applies all migrations to
 * it. Tests never clean tables (the audit log is append-only by design); the whole database
 * is dropped in global teardown instead. Two URLs of it are exported: the application login
 * and the owner (docs/design/data/platform.md 10.4).
 */
export default async function globalSetup(): Promise<void> {
  const name = `mondapac_test_${randomBytes(6).toString('hex')}`;
  const ownerUrl = new URL(migrationDatabaseUrl());
  ownerUrl.pathname = `/${name}`;
  const applicationUrl = new URL(applicationDatabaseUrl());
  applicationUrl.pathname = `/${name}`;

  const admin = new Client({ connectionString: migrationDatabaseUrl() });
  await admin.connect();
  try {
    // A migration that needs a superuser must fail here, not in production (10.1).
    const { rows } = await admin.query<{ rolsuper: boolean }>(
      'SELECT rolsuper FROM pg_roles WHERE rolname = current_user',
    );
    if (rows[0]?.rolsuper !== false) {
      throw new Error(
        'MIGRATION_DATABASE_URL connects as a superuser; it must name the migration role ' +
          '(see .env.example and scripts/db/bootstrap-dev.sql).',
      );
    }
    await admin.query(`CREATE DATABASE "${name}"`);
    // A new database gets the default ACL, not its template's (10.7).
    await admin.query(`REVOKE ALL ON DATABASE "${name}" FROM PUBLIC`);
    await admin.query(`GRANT CONNECT ON DATABASE "${name}" TO "mondapac_app"`);
  } finally {
    await admin.end();
  }

  process.env.TEST_DATABASE_NAME = name;
  process.env.TEST_DATABASE_URL = applicationUrl.toString();
  process.env.TEST_OWNER_DATABASE_URL = ownerUrl.toString();

  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd: REPO_ROOT,
    env: { ...process.env, MIGRATION_DATABASE_URL: ownerUrl.toString() },
    stdio: ['ignore', 'ignore', 'inherit'],
    shell: process.platform === 'win32',
  });

  await createLockingDatabase(name);
}

/**
 * A copy of the migrated run database for the one spec file that takes table locks and
 * changes triggers on `platform.audit_log` (unit-of-work.db-spec.ts): no other file meets
 * those locks, whatever the role's lock_timeout. Copied before any test connects, since a
 * template must have no other session.
 */
async function createLockingDatabase(template: string): Promise<void> {
  const name = `${template}_locking`;
  const admin = new Client({ connectionString: migrationDatabaseUrl() });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE "${template}"`);
    await admin.query(`REVOKE ALL ON DATABASE "${name}" FROM PUBLIC`);
    await admin.query(`GRANT CONNECT ON DATABASE "${name}" TO "mondapac_app"`);
  } finally {
    await admin.end();
  }
  const ownerUrl = new URL(migrationDatabaseUrl());
  ownerUrl.pathname = `/${name}`;
  const applicationUrl = new URL(applicationDatabaseUrl());
  applicationUrl.pathname = `/${name}`;
  process.env.TEST_LOCKING_DATABASE_NAME = name;
  process.env.TEST_LOCKING_DATABASE_URL = applicationUrl.toString();
  process.env.TEST_LOCKING_OWNER_DATABASE_URL = ownerUrl.toString();
}
