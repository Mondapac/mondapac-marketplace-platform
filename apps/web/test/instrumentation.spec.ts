import { afterEach, describe, expect, it, vi } from 'vitest';
import { register } from '../instrumentation.ts';

// The start-up hook: a production server without API_BASE_URL must not start (sample data would
// reach buyers); the build and the local preview must.

afterEach(() => {
  vi.unstubAllEnvs();
});

function server(env: Readonly<Record<string, string>>): void {
  vi.stubEnv('NEXT_RUNTIME', 'nodejs');
  vi.stubEnv('API_BASE_URL', '');
  vi.stubEnv('NEXT_PHASE', '');
  // The other start-up checks run with their features unset, whatever the machine has.
  for (const key of [
    'MAPBOX_SEARCH_TOKEN',
    'MAPBOX_COUNTRIES',
    'MAPBOX_MAP_TOKEN',
    'MAPBOX_MAP_STYLE',
    'EDGE_GEO_COUNTRY_HEADER',
    'EDGE_GEO_REGION_HEADER',
    'STRIPE_TEST_PUBLISHABLE_KEY',
    'SELLER_SIGN_IN_URLS',
  ]) {
    vi.stubEnv(key, '');
  }
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
}

describe('register', () => {
  it('refuses to start in production without API_BASE_URL', async () => {
    server({ NODE_ENV: 'production' });
    await expect(register()).rejects.toThrow(/API_BASE_URL is empty in production/);
  });

  it('starts during next build without API_BASE_URL', async () => {
    server({ NODE_ENV: 'production', NEXT_PHASE: 'phase-production-build' });
    await expect(register()).resolves.toBeUndefined();
  });

  it('starts in production with API_BASE_URL set', async () => {
    server({
      NODE_ENV: 'production',
      API_BASE_URL: 'http://localhost:3000',
      STOREFRONT_HOSTS: 'http://storefront.localhost:3003=AU',
    });
    await expect(register()).resolves.toBeUndefined();
  });
});
