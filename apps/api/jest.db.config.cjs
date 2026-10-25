const base = require('./jest.config.cjs');

/**
 * Database integration tests. They need a reachable PostgreSQL (DATABASE_URL and
 * MIGRATION_DATABASE_URL, for example from `docker compose up -d`); each run migrates its own
 * throwaway database as the migration role and tests it as the application login.
 * @type {import('jest').Config}
 */
module.exports = {
  ...base,
  testRegex: 'test/db/.*\\.db-spec\\.ts$',
  globalSetup: '<rootDir>/test/db/global-setup.ts',
  globalTeardown: '<rootDir>/test/db/global-teardown.ts',
  // Several specs build a whole Nest application per test; with every spec running in parallel
  // that can take longer than Jest's 5 s default, which then fails a hook rather than a check.
  testTimeout: 30_000,
  // A worker that loads many specs keeps growing until V8 aborts it ("Jest worker ran out of
  // memory"), which fails a whole spec file with no test annotation. Restart a worker between spec
  // files once it holds more than 1 GB, so a growing suite cannot cross the heap limit.
  workerIdleMemoryLimit: '1GB',
  // CI sets TEST_DB_MAX_WORKERS to run fewer spec files at once (.github/workflows/ci.yml);
  // unset, Jest's default applies.
  ...(process.env.TEST_DB_MAX_WORKERS
    ? { maxWorkers: Number(process.env.TEST_DB_MAX_WORKERS) }
    : {}),
};
