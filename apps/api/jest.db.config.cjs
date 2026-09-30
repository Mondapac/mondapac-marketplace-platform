const base = require('./jest.config.cjs');

/**
 * Database integration tests. They need a reachable PostgreSQL (DATABASE_URL, for example
 * from `docker compose up -d`); each run migrates its own throwaway database.
 * @type {import('jest').Config}
 */
module.exports = {
  ...base,
  testRegex: 'test/db/.*\\.db-spec\\.ts$',
  globalSetup: '<rootDir>/test/db/global-setup.ts',
  globalTeardown: '<rootDir>/test/db/global-teardown.ts',
};
