import { existsSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../../../..');

/** Base connection URL used to create and drop the throwaway test database. */
export function baseDatabaseUrl(): string {
  const envFile = path.join(REPO_ROOT, '.env');
  if (!process.env.DATABASE_URL && existsSync(envFile)) {
    process.loadEnvFile(envFile);
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is required for database tests. Start the services with ' +
        '`docker compose up -d` and copy .env.example to .env.',
    );
  }
  return url;
}

/** Connection URL of the migrated throwaway database of this test run. */
export function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error('TEST_DATABASE_URL is not set: database tests must run via jest.db.config.cjs');
  }
  return url;
}

export { REPO_ROOT };
