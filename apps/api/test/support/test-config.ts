import path from 'node:path';
import { loadAppConfig, type AppConfig } from '../../src/platform/config/app-config';

const REPO_ROOT = path.resolve(__dirname, '../../../..');

/** The real Market configuration plus the synthetic second market used by tests. */
export const TEST_MARKET_CONFIG_DIRS = [
  path.join(REPO_ROOT, 'config/markets'),
  path.join(REPO_ROOT, 'test/fixtures/markets'),
] as const;

/** Both market fixtures (ADR-0003 decision 9): the launch market and a synthetic one. */
export const TEST_MARKETS = ['AU', 'ZZ'] as const;

/** Application config for tests: both markets hosted, logging quiet unless overridden. */
export function testAppConfig(overrides: Record<string, string> = {}): AppConfig {
  return {
    ...loadAppConfig({
      NODE_ENV: 'test',
      HOSTED_MARKETS: TEST_MARKETS.join(','),
      // Never connected to unless a suite overrides it with a real database.
      DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:1/unused',
      ...overrides,
    }),
    marketConfigDirs: TEST_MARKET_CONFIG_DIRS,
  };
}
