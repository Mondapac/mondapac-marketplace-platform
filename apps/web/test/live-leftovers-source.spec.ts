import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as MapConfigModule from '../src/delivery/map-config.ts';

// With the API on, the leftover reads answer no sample: a closed store is an unknown slug, the
// account has no sample lists or email choices, and the Deliver to stub offers no made-up
// addresses or suburbs. Without the API the preview keeps its samples.

const world = vi.hoisted(() => ({ api: true }));

vi.mock('next/headers', () => ({ headers: () => Promise.resolve(new Headers()) }));
vi.mock('next-intl/server', () => ({
  getTranslations: () => Promise.resolve((key: string) => key),
  getLocale: () => Promise.resolve('en'),
}));
vi.mock('../src/delivery/places-server.ts', () => ({
  placesDeps: () => ({}),
  lookupIsLive: () => false,
}));
vi.mock('../src/delivery/map-config.ts', async (actual) => ({
  ...(await actual<typeof MapConfigModule>()),
  mapConfig: () => null,
}));
vi.mock('../src/storefront/session.ts', () => ({
  sessionGet: () => Promise.resolve({ kind: 'ok', body: { items: [] } }),
}));
vi.mock('../src/storefront/config.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  storefrontApiConfig: () =>
    world.api
      ? { apiBaseUrl: 'https://api.shop.example', hosts: [], clientAddressKey: null }
      : null,
}));

const { loadAccount, loadClosedStore, loadDeliveryLocator } =
  await import('../src/storefront/source.ts');

beforeEach(() => {
  world.api = true;
});

describe('with the API on', () => {
  it('knows no closed store: the sample slug is an unknown store', async () => {
    expect(await loadClosedStore('west-end-grocer')).toBeUndefined();
  });

  it('gives the account no sample lists and no email choices', async () => {
    const account = await loadAccount();
    expect(account.live).toBe(true);
    expect(account.lists).toEqual([]);
    expect(account.emails).toEqual({
      offers: false,
      recommendations: false,
      sellerMessages: false,
    });
  });

  it('offers no made-up address or suburb to the Deliver to stub', async () => {
    const locator = await loadDeliveryLocator();
    expect(locator.addresses).toEqual([]);
    expect(locator.suburbs).toEqual([]);
    expect(locator.area.name).toBe('Greater Brisbane');
  });
});

describe('without the API (the preview)', () => {
  it('keeps the samples', async () => {
    world.api = false;
    expect(await loadClosedStore('west-end-grocer')).toBeDefined();
    expect((await loadAccount()).lists.length).toBeGreaterThan(0);
    expect((await loadDeliveryLocator()).addresses.length).toBeGreaterThan(0);
  });
});
