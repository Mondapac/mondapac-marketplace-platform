import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { baseDatabaseUrl, REPO_ROOT } from './test-database';

/**
 * Creates a fresh database for this run and applies all migrations to it. Tests never
 * clean tables (the audit log is append-only by design); the whole database is dropped
 * in global teardown instead.
 */
export default async function globalSetup(): Promise<void> {
  const baseUrl = baseDatabaseUrl();
  const name = `mondapac_test_${randomBytes(6).toString('hex')}`;
  const testUrl = new URL(baseUrl);
  testUrl.pathname = `/${name}`;

  const admin = new Client({ connectionString: baseUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }

  process.env.TEST_DATABASE_NAME = name;
  process.env.TEST_DATABASE_URL = testUrl.toString();

  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_URL: testUrl.toString() },
    stdio: ['ignore', 'ignore', 'inherit'],
    shell: process.platform === 'win32',
  });
}
