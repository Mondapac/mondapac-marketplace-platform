import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as MapConfigModule from '../src/delivery/map-config.ts';

// How the Deliver to modal's source and the policy see the map configuration (ADR-0048): the map
// reaches the modal only with a live lookup and a token, and a malformed configuration reads as
// off for the Content-Security-Policy.

const state = vi.hoisted(() => ({
  live: true,
  map: null as { token: string; style: string } | null,
}));

vi.mock('next/headers', () => ({ headers: () => Promise.resolve(new Headers()) }));
vi.mock('../src/delivery/places-server.ts', () => ({
  placesDeps: () => ({}),
  lookupIsLive: () => state.live,
}));
vi.mock('../src/delivery/map-config.ts', async (actual) => ({
  ...(await actual<typeof MapConfigModule>()),
  mapConfig: () => state.map,
}));

const MAP = { token: 'pk.eyJ1IjoibW9uZGFwYWMifQ.not-a-real-token', style: 'mapbox://styles/a/b' };

describe('the Deliver to source', () => {
  beforeEach(() => {
    state.live = true;
    state.map = null;
  });

  it('hands the map to the modal only with a live lookup and a token', async () => {
    const { loadDeliveryLocator } = await import('../src/storefront/source.ts');
    state.map = MAP;
    expect((await loadDeliveryLocator()).map).toEqual(MAP);
    state.map = null;
    expect((await loadDeliveryLocator()).map).toBeUndefined();
    state.live = false;
    state.map = MAP;
    expect((await loadDeliveryLocator()).map).toBeUndefined();
  });
});

describe('the policy switch', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function fresh() {
    vi.resetModules();
    vi.doUnmock('../src/delivery/map-config.ts');
    return import('../src/delivery/map-config.ts');
  }

  it('is off without a token and on with a valid one', async () => {
    vi.stubEnv('MAPBOX_MAP_TOKEN', '');
    expect((await fresh()).mapIsOn()).toBe(false);
    vi.stubEnv('MAPBOX_MAP_TOKEN', MAP.token);
    expect((await fresh()).mapIsOn()).toBe(true);
  });

  it('reads a malformed configuration as off, so the policy stays strict', async () => {
    vi.stubEnv('MAPBOX_MAP_TOKEN', 'sk.eyJ1Ijoic2VjcmV0In0.abcdefghijklmnop');
    const config = await fresh();
    expect(() => config.mapConfig()).toThrow(/never sk/);
    expect(config.mapIsOn()).toBe(false);
  });
});
