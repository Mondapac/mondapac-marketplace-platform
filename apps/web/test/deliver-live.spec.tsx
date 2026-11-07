// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../messages/en.json';
import { DeliverModal } from '../src/delivery/deliver-modal.tsx';
import { SEARCH_PAUSE_MS, SearchProblem, liveLookup } from '../src/delivery/lookup.ts';
import {
  forwardUrl,
  parseMapboxConfig,
  placeOfFeature,
  placesOf,
  placesWithPostcodes,
  pointOf,
  postcodeOf,
  postcodeUrl,
  reverseUrl,
} from '../src/delivery/mapbox.ts';
import {
  answerSearch,
  answerSuburb,
  lookupIsLive,
  placesDepsOf,
  type PlacesDeps,
} from '../src/delivery/places-server.ts';
import { clientKey, fixedWindowLimiter } from '../src/delivery/rate-limit.ts';
import { Header } from '../src/shell/header.tsx';
import { StoreProvider } from '../src/shell/store-context.tsx';
import { SAMPLE_DELIVERY_LOCATOR as SOURCE } from '../src/storefront/sample-delivery.ts';
import type { DeliveryAreaAnswer, GeoPoint } from '../src/storefront/types.ts';

const { deliveryAreaFor } = vi.hoisted(() => ({
  deliveryAreaFor: vi.fn<(postcode: string) => Promise<DeliveryAreaAnswer>>(),
}));
vi.mock('../src/checkout/actions.ts', () => ({ deliveryAreaFor }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
}));

const TOKEN = 'pk.test-token-not-real-0123456789';

/** A Mapbox Geocoding v6 locality (suburb) feature: no postcode of its own. */
function locality(name: string, lng: number, lat: number) {
  return {
    type: 'Feature',
    properties: {
      mapbox_id: `loc-${name}`,
      feature_type: 'locality',
      name,
      coordinates: { longitude: lng, latitude: lat },
      context: { place: { name: 'Brisbane' }, region: { name: 'Queensland', region_code: 'QLD' } },
    },
  };
}

/** A Mapbox Geocoding v6 address feature, shaped like the API's answer. */
function feature(
  id: string,
  street: string,
  suburb: string,
  postcode: string,
  lng = 153.03,
  lat = -27.4,
) {
  return {
    type: 'Feature',
    properties: {
      mapbox_id: id,
      feature_type: 'address',
      name: street,
      coordinates: { longitude: lng, latitude: lat },
      context: {
        locality: { name: suburb },
        place: { name: 'Brisbane' },
        postcode: { name: postcode },
        region: { name: 'Queensland', region_code: 'QLD' },
        country: { country_code: 'AU' },
      },
    },
  };
}

describe('Mapbox configuration', () => {
  it('is off when neither value is set', () => {
    expect(parseMapboxConfig({})).toBeNull();
    expect(parseMapboxConfig({ MAPBOX_SEARCH_TOKEN: ' ', MAPBOX_COUNTRIES: '' })).toBeNull();
  });

  it('refuses one value without the other and malformed values', () => {
    expect(() => parseMapboxConfig({ MAPBOX_SEARCH_TOKEN: TOKEN })).toThrow(/together/);
    expect(() => parseMapboxConfig({ MAPBOX_COUNTRIES: 'AU=au' })).toThrow(/together/);
    expect(() =>
      parseMapboxConfig({ MAPBOX_SEARCH_TOKEN: 'x y', MAPBOX_COUNTRIES: 'AU=au' }),
    ).toThrow();
    for (const countries of ['AU', 'au=au', 'AU=aus', 'AU=au,AU=nz', 'AU=au=x'])
      expect(
        () => parseMapboxConfig({ MAPBOX_SEARCH_TOKEN: TOKEN, MAPBOX_COUNTRIES: countries }),
        countries,
      ).toThrow();
  });

  it('maps each Market to its country, with no default Market', () => {
    const config = parseMapboxConfig({
      MAPBOX_SEARCH_TOKEN: TOKEN,
      MAPBOX_COUNTRIES: 'AU=AU, NZ=nz',
    });
    expect([...config!.countries]).toEqual([
      ['AU', 'au'],
      ['NZ', 'nz'],
    ]);
  });
});

describe('Mapbox requests and answers', () => {
  it('searches street addresses and suburbs in the Market country only', () => {
    const url = new URL(forwardUrl(TOKEN, 'nz', '12 Example St'));
    expect(url.origin + url.pathname).toBe('https://api.mapbox.com/search/geocode/v6/forward');
    expect(url.searchParams.get('q')).toBe('12 Example St');
    expect(url.searchParams.get('country')).toBe('nz');
    expect(url.searchParams.get('types')).toBe('address,locality');
    expect(url.searchParams.get('autocomplete')).toBe('true');
    expect(url.searchParams.has('proximity')).toBe(false);
  });

  it('ranks towards the pin when one is given', () => {
    const url = new URL(
      forwardUrl(TOKEN, 'au', '100 Queen St', { lat: -27.46981, lng: 153.02512 }),
    );
    expect(url.searchParams.get('proximity')).toBe('153.0251,-27.4698');
  });

  it('finds the postcode of a suburb at its centre', async () => {
    const url = new URL(postcodeUrl(TOKEN, 'au', { lat: -27.5424, lng: 153.0727 }));
    expect(url.pathname).toBe('/search/geocode/v6/reverse');
    expect(url.searchParams.get('types')).toBe('postcode');
    expect(
      postcodeOf({ features: [{ properties: { feature_type: 'postcode', name: '4122' } }] }),
    ).toBe('4122');
    expect(postcodeOf({ features: [{ properties: { feature_type: 'place', name: 'x' } }] })).toBe(
      '',
    );
    expect(postcodeOf(null)).toBe('');
    const asked: GeoPoint[] = [];
    const places = await placesWithPostcodes(
      {
        features: [
          locality('Mount Gravatt', 153.0727, -27.5424),
          feature('m1', '1 Logan Rd', 'Mount Gravatt', '4122'),
          locality('Mount Gravatt East', 153.0839, -27.5328),
          locality('Upper Mount Gravatt', 153.08, -27.55),
        ],
      },
      (point) => {
        asked.push(point);
        return Promise.resolve(point.lng === 153.0839 ? '' : '4122');
      },
    );
    // At most two suburbs are looked up; one without a postcode is left out.
    expect(asked).toHaveLength(2);
    expect(places.map((p) => `${p.street}|${p.suburb}|${p.postcode}|${p.id}`)).toEqual([
      '|Mount Gravatt|4122|4122:Mount Gravatt',
      '1 Logan Rd|Mount Gravatt|4122|m1',
    ]);
  });

  it('reverse geocodes a point to one address', () => {
    const url = new URL(reverseUrl(TOKEN, 'au', { lat: -27.4, lng: 153.03 }));
    expect(url.pathname).toBe('/search/geocode/v6/reverse');
    expect(url.searchParams.get('latitude')).toBe('-27.400000');
    expect(url.searchParams.get('longitude')).toBe('153.030000');
    expect(url.searchParams.get('limit')).toBe('1');
  });

  it('turns a feature into a place with suburb, region and postcode', () => {
    expect(placeOfFeature(feature('m1', '12 Example Street', 'Kedron', '4031'))).toEqual({
      id: 'm1',
      street: '12 Example Street',
      suburb: 'Kedron',
      region: 'QLD',
      postcode: '4031',
      point: { lat: -27.4, lng: 153.03 },
    });
  });

  it('drops features without a suburb, postcode or position, and duplicates', () => {
    const noPostcode = feature('m2', '1 A St', 'Kedron', '');
    const noPoint = {
      properties: { ...feature('m3', '1 A St', 'Kedron', '4031').properties, coordinates: {} },
    };
    const body = {
      features: [
        feature('m1', '1 A St', 'Kedron', '4031'),
        noPostcode,
        noPoint,
        feature('m1', '1 A St', 'Kedron', '4031'),
        null,
        'x',
      ],
    };
    expect(placesOf(body).map((p) => p.id)).toEqual(['m1']);
    expect(placesOf(null)).toEqual([]);
    expect(placesOf({ features: 'no' })).toEqual([]);
  });

  it('accepts only real coordinates for a point', () => {
    expect(pointOf('-27.4', '153.03')).toEqual({ lat: -27.4, lng: 153.03 });
    for (const [lat, lng] of [
      [null, '1'],
      ['', '1'],
      ['91', '0'],
      ['0', '181'],
      ['x', '1'],
      ['Infinity', '1'],
    ])
      expect(pointOf(lat as string | null, lng as string), `${lat},${lng}`).toBeNull();
  });
});

describe('rate limit', () => {
  it('allows the limit per key per window, then refuses until the next window', () => {
    let now = 0;
    const limiter = fixedWindowLimiter(2, 1000, { now: () => now });
    expect([limiter.take('a'), limiter.take('a'), limiter.take('a'), limiter.take('b')]).toEqual([
      true,
      true,
      false,
      true,
    ]);
    now = 1000;
    expect(limiter.take('a')).toBe(true);
  });

  it('puts new keys in one shared bucket once the table is full, without locking out known keys', () => {
    const limiter = fixedWindowLimiter(2, 1000, { maxKeys: 2, now: () => 0 });
    expect([limiter.take('a'), limiter.take('b')]).toEqual([true, true]);
    // c and d share the overflow bucket of 2.
    expect([limiter.take('c'), limiter.take('d'), limiter.take('e')]).toEqual([true, true, false]);
    expect(limiter.take('a')).toBe(true);
  });

  it('caps all keys together per window and reports it', () => {
    let now = 0;
    const onTotalSpent = vi.fn();
    const limiter = fixedWindowLimiter(5, 1000, { total: 3, now: () => now, onTotalSpent });
    expect(['a', 'b', 'c', 'd', 'e'].map((key) => limiter.take(key))).toEqual([
      true,
      true,
      true,
      false,
      false,
    ]);
    expect(onTotalSpent).toHaveBeenCalledTimes(1);
    now = 1000;
    expect(limiter.take('d')).toBe(true);
  });

  it('counts IPv6 clients by their /64 and IPv4 by address', () => {
    expect(clientKey('2001:db8:1:2:aaaa::1')).toBe('2001:db8:1:2::/64');
    expect(clientKey('2001:0db8:0001:0002:ffff:ffff:ffff:ffff')).toBe('2001:db8:1:2::/64');
    expect(clientKey('2001:db8::5')).toBe('2001:db8:0:0::/64');
    expect(clientKey('203.0.113.9')).toBe('203.0.113.9');
    expect(clientKey('::ffff:203.0.113.9')).toBe('203.0.113.9');
    expect(clientKey('::FFFF:198.51.100.1')).toBe('198.51.100.1');
    expect(clientKey('64:ff9b::203.0.113.9')).toBe('64:ff9b:0:0::/64');
    expect(clientKey('2001:db8:1:2::203.0.113.9')).toBe('2001:db8:1:2::/64');
    expect(clientKey('unknown')).toBe('unknown');
  });
});

describe('lookup configuration from the environment', () => {
  it('needs STOREFRONT_HOSTS with Mapbox, and names it', () => {
    const env = { MAPBOX_SEARCH_TOKEN: TOKEN, MAPBOX_COUNTRIES: 'AU=au' };
    expect(() => placesDepsOf(env, false)).toThrow(/STOREFRONT_HOSTS is required with MAPBOX/);
    expect(placesDepsOf({}, false).config).toBeNull();
    const deps = placesDepsOf(
      { ...env, STOREFRONT_HOSTS: 'http://storefront.localhost:3003=AU' },
      true,
    );
    expect(lookupIsLive(deps, new Headers({ host: 'storefront.localhost:3003' }))).toBe(true);
  });
});

describe('server routes', () => {
  const incoming = (host = 'storefront.localhost:3003') =>
    new Headers({ host, 'x-mp-client-address': '203.0.113.9', 'sec-fetch-site': 'same-origin' });
  const mapbox = vi.fn<typeof fetch>();
  const deps = (limit = 10): PlacesDeps => ({
    config: parseMapboxConfig({ MAPBOX_SEARCH_TOKEN: TOKEN, MAPBOX_COUNTRIES: 'AU=au' }),
    hosts: [
      {
        origin: 'http://storefront.localhost:3003',
        host: 'storefront.localhost:3003',
        marketId: 'AU',
      },
    ],
    apiOn: true,
    limiter: fixedWindowLimiter(limit, 60_000),
    fetch: mapbox,
  });
  const search = (q: string, d = deps(), h = incoming()) =>
    answerSearch(
      d,
      h,
      new URL(`http://storefront.localhost:3003/api/deliver-to/search?q=${encodeURIComponent(q)}`),
    );
  beforeEach(() => {
    mapbox.mockReset();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('is off without configuration or for a host whose Market has no country', async () => {
    const off: PlacesDeps = { ...deps(), config: null };
    expect(lookupIsLive(off, incoming())).toBe(false);
    expect((await search('12 Example', off)).status).toBe(404);
    expect(lookupIsLive(deps(), incoming('other.localhost:3003'))).toBe(false);
    expect((await search('12 Example', deps(), incoming('other.localhost:3003'))).status).toBe(404);
    expect(lookupIsLive(deps(), incoming())).toBe(true);
    expect(mapbox).not.toHaveBeenCalled();
  });

  it('stays on sample places while the API is off: the sample boundary fits only them', async () => {
    const apiOff: PlacesDeps = { ...deps(), apiOn: false };
    expect(lookupIsLive(apiOff, incoming())).toBe(false);
    expect((await search('12 Example', apiOff)).status).toBe(404);
  });

  it("answers only this site's own pages", async () => {
    mapbox.mockImplementation(() => Promise.resolve(Response.json({ features: [] })));
    const from = (extra: Record<string, string>) =>
      new Headers({
        host: 'storefront.localhost:3003',
        'x-mp-client-address': '203.0.113.9',
        ...extra,
      });
    expect(
      (await search('12 Example', deps(), from({ 'sec-fetch-site': 'cross-site' }))).status,
    ).toBe(403);
    expect((await search('12 Example', deps(), from({ 'sec-fetch-site': 'none' }))).status).toBe(
      403,
    );
    expect((await search('12 Example', deps(), from({}))).status).toBe(403);
    expect(
      (await search('12 Example', deps(), from({ referer: 'https://evil.example/' }))).status,
    ).toBe(403);
    expect(
      (
        await search(
          '12 Example',
          deps(),
          from({ referer: 'http://storefront.localhost:3003/c/x' }),
        )
      ).status,
    ).toBe(200);
    expect(mapbox).toHaveBeenCalledTimes(1);
  });

  it('answers places for what was typed and never returns the token', async () => {
    mapbox.mockResolvedValue(
      Response.json({ features: [feature('m1', '12 Example Street', 'Kedron', '4031')] }),
    );
    const response = await search('  12   Example ');
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const parsed = JSON.parse(text) as { places: { suburb: string }[] };
    expect(parsed.places.map((p) => p.suburb)).toEqual(['Kedron']);
    expect(text).not.toContain(TOKEN);
    const asked = new URL(mapbox.mock.calls[0]![0] as string);
    expect(asked.searchParams.get('q')).toBe('12 Example');
    expect(asked.searchParams.get('country')).toBe('au');
  });

  it('answers a suburb with the postcode at its centre, ranked towards the pin', async () => {
    mapbox.mockImplementation((input) => {
      const asked = new URL(input as string);
      return Promise.resolve(
        Response.json(
          asked.pathname.endsWith('/forward')
            ? { features: [locality('Mount Gravatt', 153.0727, -27.5424)] }
            : { features: [{ properties: { feature_type: 'postcode', name: '4122' } }] },
        ),
      );
    });
    const url = new URL(
      'http://storefront.localhost:3003/api/deliver-to/search?q=Mt%20Gravatt&near=-27.47,153.02',
    );
    const body = (await (await answerSearch(deps(), incoming(), url)).json()) as {
      places: { suburb: string; postcode: string; street: string }[];
    };
    expect(body.places).toMatchObject([{ suburb: 'Mount Gravatt', postcode: '4122', street: '' }]);
    expect(new URL(mapbox.mock.calls[0]![0] as string).searchParams.get('proximity')).toBe(
      '153.0200,-27.4700',
    );
    expect(new URL(mapbox.mock.calls[1]![0] as string).searchParams.get('types')).toBe('postcode');
  });

  it('counts a suburb postcode against the limit and leaves the suburb out over it', async () => {
    mapbox.mockResolvedValue(
      Response.json({ features: [locality('Mount Gravatt', 153.0727, -27.5424)] }),
    );
    const body = (await (await search('Mt Gravatt', deps(1))).json()) as { places: unknown[] };
    expect(body.places).toEqual([]);
    expect(mapbox).toHaveBeenCalledTimes(1);
  });

  it('refuses a malformed pin', async () => {
    const url = new URL('http://storefront.localhost:3003/api/deliver-to/search?q=12%20Ex&near=x');
    expect((await answerSearch(deps(), incoming(), url)).status).toBe(400);
  });

  it('does not ask Mapbox for a short query and refuses a long one', async () => {
    expect(await (await search('12')).json()).toEqual({ places: [] });
    expect((await search('x'.repeat(121))).status).toBe(400);
    expect(mapbox).not.toHaveBeenCalled();
  });

  it('throttles one client address and says so', async () => {
    mapbox.mockImplementation(() => Promise.resolve(Response.json({ features: [] })));
    const limited = deps(2);
    expect((await search('12 Example', limited)).status).toBe(200);
    expect((await search('12 Example', limited)).status).toBe(200);
    const third = await search('12 Example', limited);
    expect(third.status).toBe(429);
    expect(third.headers.get('retry-after')).toBe('60');
    expect(mapbox).toHaveBeenCalledTimes(2);
  });

  it('answers 503 when Mapbox refuses or fails, and logs no URL', async () => {
    mapbox.mockResolvedValueOnce(new Response('no', { status: 401 }));
    expect((await search('12 Example')).status).toBe(503);
    mapbox.mockRejectedValueOnce(new TypeError('network'));
    expect((await search('12 Example')).status).toBe(503);
    const logged = vi
      .mocked(console.warn)
      .mock.calls.map((call) => String(call[0]))
      .join('\n');
    expect(logged).not.toContain(TOKEN);
    expect(logged).not.toContain('Example');
  });

  it('answers only the suburb at a point, at the point asked', async () => {
    mapbox.mockResolvedValue(
      Response.json({
        features: [feature('m9', '3 Near Road', 'Kedron', '4031', 153.031, -27.401)],
      }),
    );
    const url = new URL(
      'http://storefront.localhost:3003/api/deliver-to/suburb?lat=-27.4&lng=153.03',
    );
    const body = (await (await answerSuburb(deps(), incoming(), url)).json()) as { place: unknown };
    expect(body.place).toMatchObject({
      id: '4031:Kedron',
      street: '',
      suburb: 'Kedron',
      postcode: '4031',
      point: { lat: -27.4, lng: 153.03 },
    });
    const bad = new URL('http://storefront.localhost:3003/api/deliver-to/suburb?lat=x&lng=1');
    expect((await answerSuburb(deps(), incoming(), bad)).status).toBe(400);
  });
});

describe('live lookup in the browser', () => {
  const browserFetch = vi.fn<typeof fetch>();
  const lookup = () => liveLookup({ fetch: browserFetch, area: deliveryAreaFor });
  beforeEach(() => {
    browserFetch.mockReset();
    deliveryAreaFor.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it('asks once per typing pause, for the last text only', async () => {
    vi.useFakeTimers();
    browserFetch.mockResolvedValue(
      Response.json({
        places: [placeOfFeature(feature('m1', '12 Example Street', 'Kedron', '4031'))],
      }),
    );
    const live = lookup();
    void live.search('12 Ex');
    const last = live.search('12 Example', { lat: -27.46981, lng: 153.02512 });
    await vi.advanceTimersByTimeAsync(SEARCH_PAUSE_MS);
    expect((await last).map((p) => p.street)).toEqual(['12 Example Street']);
    expect(browserFetch).toHaveBeenCalledTimes(1);
    expect(browserFetch.mock.calls[0]![0] as string).toBe(
      '/api/deliver-to/search?q=12%20Example&near=-27.4698,153.0251',
    );
  });

  it('says why a search has no list: throttled or failed', async () => {
    vi.useFakeTimers();
    const live = lookup();
    browserFetch.mockResolvedValueOnce(new Response('', { status: 429 }));
    const throttled = live.search('12 Example');
    const caught = throttled.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(SEARCH_PAUSE_MS);
    expect(await caught).toEqual(new SearchProblem('throttled'));
    browserFetch.mockResolvedValueOnce(new Response('', { status: 503 }));
    const failed = live
      .search('12 Example')
      .catch((error: unknown) => (error as SearchProblem).kind);
    await vi.advanceTimersByTimeAsync(SEARCH_PAUSE_MS);
    expect(await failed).toBe('failed');
  });

  it('reads a failed or malformed reverse answer as no result', async () => {
    browserFetch.mockResolvedValueOnce(new Response('', { status: 429 }));
    expect(await lookup().suburbAt({ lat: -27.4, lng: 153 })).toBeNull();
    browserFetch.mockResolvedValueOnce(Response.json({ place: { id: 1 } }));
    expect(await lookup().suburbAt({ lat: -27.4, lng: 153 })).toBeNull();
    browserFetch.mockRejectedValueOnce(new TypeError('offline'));
    expect(await lookup().suburbAt({ lat: -27.4, lng: 153 })).toBeNull();
  });

  it('finds the suburb kept in this browser without its street', async () => {
    browserFetch.mockResolvedValue(
      Response.json({
        places: [
          placeOfFeature(feature('m1', '1 A St', 'Kedron Park', '4030')),
          placeOfFeature(feature('m2', '2 B St', 'Kedron', '4031')),
        ],
      }),
    );
    const place = await lookup().locate({ suburb: 'Kedron', postcode: '4031' });
    expect(place).toMatchObject({ suburb: 'Kedron', postcode: '4031', street: '' });
  });

  it('turns the API delivery-area answer into yes, no or unknown', async () => {
    const live = lookup();
    deliveryAreaFor.mockResolvedValueOnce({ kind: 'in' });
    expect(await live.delivers('4031')).toBe(true);
    deliveryAreaFor.mockResolvedValueOnce({ kind: 'out' });
    expect(await live.delivers('4350')).toBe(false);
    deliveryAreaFor.mockResolvedValueOnce({ kind: 'off' });
    expect(await live.delivers('4031')).toBeNull();
    deliveryAreaFor.mockRejectedValueOnce(new Error('down'));
    expect(await live.delivers('4031')).toBeNull();
  });
});

describe('Deliver to modal with the live lookup', () => {
  const browserFetch = vi.fn<typeof fetch>();
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    browserFetch.mockReset();
    deliveryAreaFor.mockReset();
    vi.stubGlobal('fetch', browserFetch);
    document.cookie = 'sf-deliver-to=; Max-Age=0; Path=/';
    window.matchMedia = (() => ({
      matches: false,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })) as unknown as typeof window.matchMedia;
    Element.prototype.getClientRects = function () {
      return [{}] as unknown as DOMRectList;
    };
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  async function pickAddress(suburb: string, postcode: string) {
    browserFetch.mockResolvedValue(
      Response.json({ places: [placeOfFeature(feature('m1', '9 Real Street', suburb, postcode))] }),
    );
    render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <StoreProvider initialDeliverTo={null}>
          <Header delivery={{ label: 'Brisbane 4000' }} />
          <DeliverModal source={{ ...SOURCE, live: true }} />
        </StoreProvider>
      </NextIntlClientProvider>,
    );
    await act(() => {
      fireEvent.click(screen.getByRole('button', { name: /^Delivery area/ }));
      return Promise.resolve();
    });
    await act(async () => {
      fireEvent.change(screen.getByRole('combobox', { name: 'Search your address' }), {
        target: { value: '9 Real' },
      });
      await vi.advanceTimersByTimeAsync(SEARCH_PAUSE_MS);
    });
    await act(() => {
      fireEvent.click(screen.getByRole('option', { name: new RegExp(suburb) }));
      return Promise.resolve();
    });
  }

  it('confirms an address the API delivers to, keeping only suburb and postcode', async () => {
    deliveryAreaFor.mockResolvedValue({ kind: 'in' });
    await pickAddress('Kedron', '4031');
    expect(deliveryAreaFor).toHaveBeenCalledWith('4031');
    expect(screen.getByText('We deliver to this area')).toBeTruthy();
    expect(screen.getByText(/come from Mapbox/)).toBeTruthy();
    const confirm = screen.getByRole('button', { name: 'Confirm location' });
    expect(confirm.getAttribute('aria-disabled')).toBe('false');
    await act(() => {
      fireEvent.click(confirm);
      return Promise.resolve();
    });
    expect(document.cookie).toContain('sf-deliver-to=Kedron|4031');
    expect(screen.getByRole('button', { name: /^Delivery area/ }).textContent).toContain(
      'Kedron 4031',
    );
  });

  it('refuses an address the API does not deliver to, even inside the preview boundary', async () => {
    deliveryAreaFor.mockResolvedValue({ kind: 'out' });
    await pickAddress('Kedron', '4031');
    expect(screen.getByText(/We do not deliver here yet/)).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Confirm location' }).getAttribute('aria-disabled'),
    ).toBe('true');
  });

  it('waits for the answer before Confirm works', async () => {
    deliveryAreaFor.mockReturnValue(new Promise(() => undefined));
    await pickAddress('Kedron', '4031');
    const confirm = screen.getByRole('button', { name: 'Confirm location' });
    expect(confirm.getAttribute('aria-disabled')).toBe('true');
    // A neutral status, not the boundary preview's "We deliver to this area".
    expect(screen.getByText('Checking delivery to this area')).toBeTruthy();
    expect(screen.queryByText('We deliver to this area')).toBeNull();
    expect(confirm.getAttribute('aria-describedby')).toBeTruthy();
  });

  it('keeps the preview but says so when the API could not answer', async () => {
    deliveryAreaFor.mockResolvedValue({ kind: 'failed' });
    await pickAddress('Kedron', '4031');
    expect(
      screen.getByText('We could not confirm this area. Checkout will check again.'),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Confirm location' }).getAttribute('aria-disabled'),
    ).toBe('false');
  });

  async function typeLive(value: string) {
    render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <StoreProvider initialDeliverTo={null}>
          <Header delivery={{ label: 'Brisbane 4000' }} />
          <DeliverModal source={{ ...SOURCE, live: true }} />
        </StoreProvider>
      </NextIntlClientProvider>,
    );
    await act(() => {
      fireEvent.click(screen.getByRole('button', { name: /^Delivery area/ }));
      return Promise.resolve();
    });
    await act(async () => {
      fireEvent.change(screen.getByRole('combobox', { name: 'Search your address' }), {
        target: { value },
      });
      await vi.advanceTimersByTimeAsync(SEARCH_PAUSE_MS);
    });
  }

  it('asks for 3 characters before searching', async () => {
    await typeLive('12');
    expect(screen.getByText('Keep typing: enter at least 3 characters.')).toBeTruthy();
    expect(browserFetch).not.toHaveBeenCalled();
  });

  it('tells a failed or throttled search apart from no match', async () => {
    browserFetch.mockResolvedValue(new Response('', { status: 429 }));
    await typeLive('12 Example');
    expect(screen.getByText('Too many searches. Wait a minute, then try again.')).toBeTruthy();
    expect(screen.queryByText('No match. Try the street and suburb.')).toBeNull();
  });

  it('says when the search service failed', async () => {
    browserFetch.mockResolvedValue(new Response('', { status: 503 }));
    await typeLive('12 Example');
    expect(
      screen.getByText(
        'We could not search addresses just now. Try again, or tap the map to set your pin.',
      ),
    ).toBeTruthy();
  });
});
