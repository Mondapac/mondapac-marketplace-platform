import { Temporal } from '@mondapac/shared-kernel';
import { FixedClock, testMarketContext } from '@mondapac/shared-kernel/testing';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import type {
  CarrierBookingRequest,
  CarrierQuoteRequest,
} from '../application/ports/carrier-gateway';
import { MAX_ANSWER_BYTES } from './drive-http-client';
import { CircuitBreaker } from './circuit-breaker';
import {
  ConfigZoom2uPolicy,
  type Zoom2uConfig,
  type Zoom2uCredentials,
} from './config-zoom2u-policy';
import { QUOTE_CACHE_MS, toFleetStatus, Zoom2uCarrier } from './zoom2u-carrier';
import {
  ZOOM2U_API_PREFIX,
  ZOOM2U_API_URLS,
  Zoom2uHttpClient,
  type Zoom2uFetch,
} from './zoom2u-http-client';

// The Zoom2u adapter against a mocked `fetch` (no network at all), on both Market fixtures
// (AU: AUD, ZZ: JPY). The fake speaks the shape of Zoom2u's public API (developer.zoom2u.com):
// a bearer key, then `quote`, `create`, `status/{reference}` and `cancel/{reference}` under
// `/api/v1/delivery/`, with prices as decimals in the local currency and no currency field.

const realMarkets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const T0 = Temporal.Instant.from('2026-10-24T10:00:00Z');
const API_KEY = 'zoom2u.key_test_0123456789abcdef';
const CREDENTIALS: Zoom2uCredentials = { apiKeys: { AU: API_KEY, ZZ: API_KEY } };
const API = `${ZOOM2U_API_URLS.sandbox}${ZOOM2U_API_PREFIX}`;

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string | undefined;
  readonly json: Record<string, unknown>;
}

type Scripted =
  { readonly status: number; readonly body?: unknown; readonly raw?: string } | 'hang' | 'network';

const streamOf = (text: string): ReadableStream<Uint8Array> => new Response(text).body!;

/** A fake Zoom2u: scripted answers first, then the real behaviour, through an injected fetch. */
class FakeZoom2u {
  readonly seen: Seen[] = [];
  readonly script: Scripted[] = [];
  readonly bookings = new Map<string, Record<string, unknown>>();
  /** The price (a decimal, like Zoom2u's) the fake quotes. */
  price: number = 12.5;
  #bookings = 0;

  reset(): void {
    this.#bookings = 0;
  }

  readonly fetch: Zoom2uFetch = async (url, init) => {
    const json =
      init.body?.startsWith('{') === true ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    this.seen.push({
      method: init.method,
      url,
      headers: init.headers,
      body: init.body,
      json,
    });
    expect(init.redirect).toBe('error');
    const next = this.script.shift();
    if (next === 'network') throw new Error('socket hang up');
    if (next === 'hang') {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }
    const send = (status: number, answer?: unknown, raw?: string) => ({
      status,
      body:
        answer === undefined && raw === undefined ? null : streamOf(raw ?? JSON.stringify(answer)),
    });
    if (next !== undefined)
      return send(next.status, next.body ?? { message: 'scripted' }, next.raw);
    if (init.headers.authorization !== `Bearer ${API_KEY}`) return send(401, { message: 'no' });
    const path = url.slice(API.length);
    if (init.method === 'POST' && path === '/quote') {
      return send(200, {
        deliverySpeed: json.DeliverySpeed,
        price: this.price,
        deliveredBy: '2026-10-24T14:00:00Z',
      });
    }
    if (init.method === 'POST' && path === '/create') {
      const order = String(json.PurchaseOrderNumber);
      // Zoom2u has no idempotency key: every create is a new booking.
      this.#bookings += 1;
      const reference = `T2026102400${String(this.#bookings).padStart(4, '0')}`;
      this.bookings.set(reference, { reference, status: 'Unassigned', order });
      return send(200, {
        reference,
        price: this.price,
        'tracking-link': 'https://track.zoom2u.com/abc',
        trackingCode: 'abc',
      });
    }
    const cancel = /^\/cancel\/(T[0-9]+)$/.exec(path);
    if (init.method === 'POST' && cancel !== null) {
      const booking = this.bookings.get(cancel[1]!);
      if (booking === undefined) return send(404, { message: 'not found' });
      booking.status = 'Cancelled';
      return send(200);
    }
    const one = /^\/status\/(T[0-9]+)$/.exec(path);
    if (init.method === 'GET' && one !== null) {
      const booking = this.bookings.get(one[1]!);
      return booking === undefined
        ? send(404, {})
        : send(200, {
            reference: booking.reference,
            status: booking.status,
            statusChangeDateTime: null,
            purchaseOrderNumber: booking.order,
            courier: { id: 7, name: 'Courier Person', phone: '0400000000' },
          });
    }
    return send(404, { message: 'route' });
  };
}

/** The Market registry with Zoom2u switched on (and any override) for every Market. */
const registryWith = (override: Partial<Zoom2uConfig> = {}): MarketRegistry =>
  ({
    get: (id: string) => {
      const real = realMarkets.get(id as never);
      return {
        ...real,
        shipping: {
          ...real.shipping,
          zoom2u: { ...real.shipping!.zoom2u!, enabled: true, ...override },
        },
      };
    },
  }) as unknown as MarketRegistry;

describe.each([['AU'], ['ZZ']] as const)('Zoom2uCarrier in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const real = realMarkets.get(market.marketId);
  const country = real.customers!.address.countryCode;
  const configured = real.shipping!.zoom2u!;
  const zoom = new FakeZoom2u();
  let clock: FixedClock;
  let slept: number[];

  const build = (override: Partial<Zoom2uConfig> = {}, credentials = CREDENTIALS) => {
    const http = new Zoom2uHttpClient(new CircuitBreaker(clock), zoom.fetch, (ms) => {
      slept.push(ms);
      return Promise.resolve();
    });
    return new Zoom2uCarrier(
      new ConfigZoom2uPolicy(registryWith(override), credentials),
      http,
      clock,
    );
  };
  let carrier: Zoom2uCarrier;

  const request: CarrierBookingRequest = {
    externalReference: '01990000-0000-7000-8000-0000000000a1',
    pickup: {
      contactName: 'Test Halal Butcher',
      contactPhone: '+61 7 3000 0000',
      addressLines: ['1 Shop Street'],
      postcode: code === 'AU' ? '4109' : '1000001',
      locality: 'Sunnybank',
      region: code === 'AU' ? 'QLD' : null,
      location: null,
      notes: null,
    },
    dropoff: {
      contactName: 'Aisha Rahman',
      contactPhone: '+61412345678',
      addressLines: ['12 Example Street'],
      postcode: code === 'AU' ? '4109' : '1000002',
      locality: 'Sunnybank',
      region: code === 'AU' ? 'QLD' : null,
      location: { lat: -27.58, lng: 153.06 },
      notes: 'Leave at the door',
    },
    parcel: {
      weightGrams: 5000,
      volumeLitres: 20,
      temperature: 'ambient',
      itemCount: 2,
      declaredValue: { amount: 12_000n, currency: real.defaultCurrency },
    },
    mode: 'on_demand',
    window: null,
  };
  const quote: CarrierQuoteRequest = {
    pickup: { postcode: request.pickup.postcode, locality: null, region: null },
    dropoff: { postcode: request.dropoff.postcode, locality: null, region: null },
    parcel: request.parcel,
    mode: 'on_demand',
  };
  const other: CarrierQuoteRequest = {
    ...quote,
    dropoff: { postcode: code === 'AU' ? '4000' : '1000003', locality: null, region: null },
  };
  const window = {
    start: T0.add({ hours: 3 }),
    end: T0.add({ hours: 5 }),
  };
  const unauthorized = { ok: false, error: { code: 'carrier.unauthorized' } };
  const unavailable = { ok: false, error: { code: 'carrier.unavailable' } };
  const refused = { ok: false, error: { code: 'carrier.refused' } };
  // Prices are decimals in the Market's currency: 12.50 AUD is 1250 minor units, 12.5 JPY is not
  // a price at all (JPY has no minor unit), so the fake quotes a whole amount there.
  const exponent = real.defaultCurrency === 'JPY' ? 0 : 2;
  const price = exponent === 0 ? 1250 : 12.5;

  beforeEach(() => {
    zoom.seen.length = 0;
    zoom.script.length = 0;
    zoom.bookings.clear();
    zoom.reset();
    zoom.price = price;
    clock = new FixedClock(T0);
    slept = [];
    carrier = build();
  });

  it('sends the key as a bearer token, JSON, with no redirects, to the documented host', async () => {
    expect((await carrier.quote(market, quote)).ok).toBe(true);
    expect(zoom.seen[0]).toMatchObject({
      method: 'POST',
      url: `${API}/quote`,
      headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
    });
    expect(ZOOM2U_API_URLS.production).toBe('https://api.zoom2u.com');
  });

  it('quotes the instant service with postcode and country only, priced in the Market currency', async () => {
    expect(await carrier.quote(market, quote)).toEqual({
      ok: true,
      value: {
        price: { amount: 1250n, currency: real.defaultCurrency },
        etaMinutes: 240,
        expiresAt: null,
      },
    });
    const body = zoom.seen[0]!.json;
    expect(Object.keys(body).sort()).toEqual(['DeliverySpeed', 'Dropoff', 'Pickup']);
    expect(body.DeliverySpeed).toBe(configured.instantSpeed);
    expect(body.Pickup).toEqual({
      ContactName: '',
      Email: '',
      Phone: '',
      Notes: '',
      Postcode: quote.pickup.postcode,
      Country: country,
    });
    expect((body.Dropoff as Record<string, unknown>).Postcode).toBe(quote.dropoff.postcode);
  });

  it('sends the locality and region of a quote stop as Suburb and State when it has them', async () => {
    await carrier.quote(market, {
      ...quote,
      pickup: { postcode: quote.pickup.postcode, locality: 'Sunnybank', region: 'QLD' },
    });
    expect(zoom.seen[0]!.json.Pickup).toMatchObject({ Suburb: 'Sunnybank', State: 'QLD' });
    expect(zoom.seen[0]!.json.Dropoff).not.toHaveProperty('Suburb');
    expect(zoom.seen[0]!.json.Dropoff).not.toHaveProperty('State');
  });

  it('gives a null ETA when Zoom2u gives no readable time, and a null expiry always', async () => {
    for (const deliveredBy of [undefined, 'soon', '2026-10-24T09:00:00Z']) {
      zoom.script.push({
        status: 200,
        body: { deliverySpeed: configured.instantSpeed, price, deliveredBy },
      });
      expect(
        await carrier.quote(market, {
          ...quote,
          parcel: { ...quote.parcel, itemCount: 1 + zoom.seen.length },
        }),
      ).toMatchObject({
        ok: true,
        value: { etaMinutes: null, expiresAt: null },
      });
    }
  });

  it('keeps a quote for five minutes, so a repeated checkout asks Zoom2u once', async () => {
    expect((await carrier.quote(market, quote)).ok).toBe(true);
    expect((await carrier.quote(market, quote)).ok).toBe(true);
    expect(zoom.seen).toHaveLength(1);
    clock.advance(Temporal.Duration.from({ milliseconds: QUOTE_CACHE_MS }));
    expect((await carrier.quote(market, quote)).ok).toBe(true);
    expect(zoom.seen).toHaveLength(2);
  });

  it('prices a scheduled quote from the stops alone at the Same day service, and refuses a mode or window the Market does not serve', async () => {
    carrier = build({ supportsWindow: true });
    expect((await carrier.quote(market, { ...quote, mode: 'scheduled' })).ok).toBe(true);
    expect(zoom.seen[0]!.json).not.toHaveProperty('ReadyDateTime');
    expect(zoom.seen[0]!.json.DeliverySpeed).toBe('Same day');
    carrier = build({ modes: ['on_demand'], supportsWindow: true });
    expect(await carrier.quote(market, { ...quote, mode: 'scheduled' })).toEqual(refused);
    carrier = build({ supportsWindow: false });
    expect(await carrier.quote(market, { ...quote, mode: 'scheduled' })).toEqual(refused);
    carrier = build({ instantSpeed: 'VIP' });
    expect((await carrier.quote(market, other)).ok).toBe(true);
    expect(zoom.seen.at(-1)!.json.DeliverySpeed).toBe('VIP');
  });

  it.each([
    ['a text price', { deliverySpeed: '3 hour', price: '12.50' }],
    ['a negative price', { deliverySpeed: '3 hour', price: -1 }],
    ['a zero price', { deliverySpeed: '3 hour', price: 0 }],
    ['a huge price', { deliverySpeed: '3 hour', price: 1e30 }],
    ['a price finer than the currency', { deliverySpeed: '3 hour', price: 12.505 }],
    ['no price', { deliverySpeed: '3 hour' }],
    ['another speed', { deliverySpeed: 'VIP', price: 12 }],
    ['an array of options', [{ deliverySpeed: '3 hour', price: 12 }]],
    ['null', null],
  ])('refuses a quote answer with %s', async (_label, body) => {
    zoom.script.push({ status: 200, body });
    expect(await carrier.quote(market, quote)).toEqual(unavailable);
  });

  it('books with the order id as PurchaseOrderNumber, names, phones and addresses', async () => {
    const answer = await carrier.book(market, request);
    expect(answer).toEqual({
      ok: true,
      value: {
        carrierReference: 'T20261024000001',
        carrierStatus: 'UNASSIGNED',
        trackingUrl: 'https://track.zoom2u.com/abc',
      },
    });
    const [call] = zoom.seen;
    expect(call).toMatchObject({ method: 'POST', url: `${API}/create` });
    expect(call!.json).toEqual({
      PurchaseOrderNumber: request.externalReference,
      DeliverySpeed: configured.instantSpeed,
      PackageDescription: 'Order',
      Pickup: {
        ContactName: 'Test Halal Butcher',
        Email: '',
        Phone: '+61730000000',
        Notes: '',
        FullAddress: '1 Shop Street',
        Suburb: 'Sunnybank',
        ...(code === 'AU' ? { State: 'QLD' } : {}),
        Postcode: request.pickup.postcode,
        Country: country,
      },
      Dropoff: {
        ContactName: 'Aisha Rahman',
        Email: '',
        Phone: '+61412345678',
        Notes: 'Leave at the door',
        FullAddress: '12 Example Street',
        Suburb: 'Sunnybank',
        ...(code === 'AU' ? { State: 'QLD' } : {}),
        Postcode: request.dropoff.postcode,
        Country: country,
      },
    });
  });

  it('never retries a booking: Zoom2u has no idempotency key, so a fault is unavailable at once', async () => {
    zoom.script.push({ status: 503 });
    expect(await carrier.book(market, request)).toEqual(unavailable);
    zoom.script.push('network');
    expect(await carrier.book(market, request)).toEqual(unavailable);
    zoom.script.push('hang');
    carrier = build({ timeoutMs: 20, maxAttempts: 3 });
    expect(await carrier.book(market, request)).toEqual(unavailable);
    expect(zoom.seen).toHaveLength(3);
    expect(slept).toEqual([]);
    expect(zoom.bookings.size).toBe(0);
  });

  it('books a scheduled trip at Same day with the buyer window start as ReadyDateTime, not a lead time', async () => {
    carrier = build({ supportsWindow: true });
    expect((await carrier.book(market, { ...request, mode: 'scheduled', window })).ok).toBe(true);
    const body = zoom.seen[0]!.json;
    expect(body.ReadyDateTime).toBe(window.start.toString({ smallestUnit: 'second' }));
    expect(body.DeliverySpeed).toBe('Same day');
    expect(JSON.stringify(body)).not.toContain(window.end.toString());
    // On demand carries no timing.
    zoom.seen.length = 0;
    expect((await carrier.book(market, request)).ok).toBe(true);
    expect(zoom.seen[0]!.json).not.toHaveProperty('ReadyDateTime');
  });

  it('refuses, without a call, a parcel beyond the limits, a mode or temperature not served, or a scheduled trip with no window', async () => {
    const { limits } = configured;
    const over = (parcel: Partial<CarrierBookingRequest['parcel']>) => ({
      ...request,
      parcel: { ...request.parcel, ...parcel },
    });
    const cases: CarrierBookingRequest[] = [
      over({ weightGrams: limits.maxItemWeightGrams + 1 }),
      over({ itemCount: limits.maxItems + 1 }),
      over({
        declaredValue: {
          amount: BigInt(limits.maxOrderValueMinor) + 1n,
          currency: real.defaultCurrency,
        },
      }),
      over({
        declaredValue: { amount: 1n, currency: real.defaultCurrency === 'USD' ? 'EUR' : 'USD' },
      }),
      over({ temperature: 'frozen' }),
      { ...request, mode: 'scheduled', window: null },
    ];
    carrier = build({ supportsWindow: true });
    for (const refusedRequest of cases) {
      expect(await carrier.book(market, refusedRequest)).toEqual(refused);
      if (refusedRequest.mode === 'scheduled') continue;
      expect(
        await carrier.quote(market, {
          pickup: quote.pickup,
          dropoff: quote.dropoff,
          parcel: refusedRequest.parcel,
          mode: 'on_demand',
        }),
      ).toEqual(refused);
    }
    carrier = build({ modes: ['scheduled'], supportsWindow: true });
    expect(await carrier.book(market, request)).toEqual(refused);
    carrier = build({ supportsWindow: false });
    expect(await carrier.book(market, { ...request, mode: 'scheduled', window })).toEqual(refused);
    carrier = build({ temperatures: ['ambient', 'chilled'] });
    expect((await carrier.book(market, over({ temperature: 'chilled' }))).ok).toBe(true);
    zoom.seen.length = 0;
    carrier = build();
    expect(zoom.seen).toEqual([]);
    // Exactly at the limits it goes through.
    const atLimits = over({
      weightGrams: limits.maxItemWeightGrams,
      itemCount: limits.maxItems,
      declaredValue: { amount: BigInt(limits.maxOrderValueMinor), currency: real.defaultCurrency },
    });
    expect((await carrier.book(market, atLimits)).ok).toBe(true);
  });

  it('gives no tracking link unless it is plain https on a Zoom2u host, and re-serialises it', async () => {
    const rejected = [
      undefined,
      'http://track.zoom2u.com/x',
      'javascript:alert(1)',
      'https://track.example.test/x',
      'https://evil-zoom2u.com/x',
      'https://zoom2u.com.evil.test/x',
      'https://user:pw@track.zoom2u.com/x',
      'https://user@zoom2u.com/x',
      'not a url',
      `https://track.zoom2u.com/${'a'.repeat(600)}`,
    ];
    zoom.script.push({
      status: 200,
      body: { reference: 'T20261024000076', 'tracking-link': 'https://TRACK.Zoom2u.com/a b' },
    });
    expect(await carrier.book(market, request)).toMatchObject({
      ok: true,
      value: { trackingUrl: 'https://track.zoom2u.com/a%20b' },
    });
    zoom.script.push({
      status: 200,
      body: { reference: 'T20261024000075', 'tracking-link': 'https://zoom2u.com/track/1' },
    });
    expect(await carrier.book(market, request)).toMatchObject({
      ok: true,
      value: { trackingUrl: 'https://zoom2u.com/track/1' },
    });
    for (const link of rejected) {
      zoom.script.push({
        status: 200,
        body: { reference: 'T20261024000077', 'tracking-link': link },
      });
      expect(await carrier.book(market, request)).toMatchObject({
        ok: true,
        value: { trackingUrl: null },
      });
    }
  });

  it.each([
    ['no reference', { price: 12 }],
    ['a reference with a slash', { reference: 'T1/../admin' }],
    ['a numeric reference', { reference: 123456789 }],
    ['an array', [{ reference: 'T20261024000001' }]],
  ])('refuses a booking answer with %s', async (_label, body) => {
    zoom.script.push({ status: 200, body });
    expect(await carrier.book(market, request)).toEqual(unavailable);
  });

  it('cancels with an empty POST, reads a status, and refuses a malformed reference without a call', async () => {
    const booked = await carrier.book(market, request);
    const reference = booked.ok ? booked.value.carrierReference : '';
    expect(await carrier.status(market, reference)).toEqual({
      ok: true,
      value: { status: 'pending', carrierStatus: 'UNASSIGNED' },
    });
    expect(zoom.seen.at(-1)).toMatchObject({ method: 'GET', url: `${API}/status/${reference}` });
    expect(await carrier.cancel(market, reference)).toEqual({
      ok: true,
      value: { carrierStatus: 'CANCELLED' },
    });
    expect(zoom.seen.at(-1)).toMatchObject({
      method: 'POST',
      url: `${API}/cancel/${reference}`,
      body: undefined,
    });
    expect(await carrier.status(market, reference)).toEqual({
      ok: true,
      value: { status: 'cancelled', carrierStatus: 'CANCELLED' },
    });
    const calls = zoom.seen.length;
    expect(await carrier.cancel(market, '../../admin')).toEqual(refused);
    expect(await carrier.status(market, 'a/b')).toEqual(refused);
    expect(zoom.seen).toHaveLength(calls);
  });

  it('refuses a cancel Zoom2u rejects (TOOLATE) and an unknown booking, without retrying', async () => {
    zoom.script.push({
      status: 400,
      body: { 'error-code': 'TOOLATE', message: 'The booking cannot be modified' },
    });
    expect(await carrier.cancel(market, 'T20261024000001')).toEqual(refused);
    expect(await carrier.cancel(market, 'T20261024000009')).toEqual(refused);
    expect(zoom.seen).toHaveLength(2);
    expect(slept).toEqual([]);
  });

  it.each([
    ['Unassigned', 'UNASSIGNED', 'pending'],
    ['Accepted', 'ACCEPTED', 'assigned'],
    ['On Route to Pickup', 'ON_ROUTE_TO_PICKUP', 'assigned'],
    ['Picked up', 'PICKED_UP', 'picked_up'],
    ['On Route to Dropoff', 'ON_ROUTE_TO_DROPOFF', 'picked_up'],
    ['Tried to deliver', 'TRIED_TO_DELIVER', 'picked_up'],
    ['Dropped Off', 'DROPPED_OFF', 'delivered'],
    ['Cancelled', 'CANCELLED', 'cancelled'],
    ['Returning', 'RETURNING', 'picked_up'],
    ['Returned', 'RETURNED', 'returned'],
    ['On Hold - With Courier', 'ON_HOLD_WITH_COURIER', 'picked_up'],
  ])(
    'maps the Zoom2u status %s to %s and the common status %s',
    async (status, expected, common) => {
      zoom.script.push({ status: 200, body: { reference: 'T20261024000001', status } });
      expect(await carrier.status(market, 'T20261024000001')).toEqual({
        ok: true,
        value: { status: common, carrierStatus: expected },
      });
    },
  );

  it('refuses a status answer about another booking, with an unknown status or no status', async () => {
    zoom.script.push({ status: 200, body: { reference: 'T20261024000002', status: 'Accepted' } });
    expect(await carrier.status(market, 'T20261024000001')).toEqual(unavailable);
    zoom.script.push({ status: 200, body: { reference: 'T20261024000001', status: 'Exploded' } });
    expect(await carrier.status(market, 'T20261024000001')).toEqual(unavailable);
    zoom.script.push({ status: 200, body: { reference: 'T20261024000001' } });
    expect(await carrier.status(market, 'T20261024000001')).toEqual(unavailable);
  });

  it('never retries a refusal (4xx)', async () => {
    zoom.script.push({ status: 400, body: { message: 'bad', modelState: {} } });
    expect(await carrier.quote(market, quote)).toEqual(refused);
    expect(zoom.seen).toHaveLength(1);
    expect(slept).toEqual([]);
  });

  it('answers unauthorized for a rejected key (401, 403) on every call, without a retry', async () => {
    zoom.script.push({ status: 401 });
    expect(await carrier.quote(market, quote)).toEqual(unauthorized);
    zoom.script.push({ status: 403 });
    expect(await carrier.cancel(market, 'T20261024000001')).toEqual(unauthorized);
    zoom.script.push({ status: 401 });
    expect(await carrier.book(market, request)).toEqual(unauthorized);
    zoom.script.push({ status: 403 });
    expect(await carrier.status(market, 'T20261024000001')).toEqual(unauthorized);
    expect(zoom.seen).toHaveLength(4);
    expect(slept).toEqual([]);
  });

  it('never counts a rejected key on the circuit: unauthorized stays unauthorized past the threshold', async () => {
    const { failureThreshold } = configured.circuitBreaker;
    for (let n = 0; n < failureThreshold + 2; n += 1) {
      zoom.script.push({ status: 401 });
      expect(await carrier.book(market, request)).toEqual(unauthorized);
    }
    expect(zoom.seen).toHaveLength(failureThreshold + 2);
  });

  it('retries a 5xx on a status read up to the configured attempts with doubling backoff', async () => {
    carrier = build({ maxAttempts: 3, backoffMs: 100 });
    for (let n = 0; n < 3; n += 1) zoom.script.push({ status: 503 });
    expect(await carrier.status(market, 'T20261024000001')).toEqual(unavailable);
    expect(zoom.seen).toHaveLength(3);
    expect(slept).toEqual([100, 200]);
    zoom.seen.length = 0;
    zoom.script.push({ status: 502 });
    expect((await carrier.quote(market, quote)).ok).toBe(true);
    expect(zoom.seen).toHaveLength(2);
  });

  it('retries a timeout and a network fault on a quote, then is unavailable', async () => {
    carrier = build({ timeoutMs: 20, maxAttempts: 2 });
    zoom.script.push('hang', 'network');
    expect(await carrier.quote(market, quote)).toEqual(unavailable);
    expect(zoom.seen).toHaveLength(2);
    zoom.script.push('hang');
    expect((await carrier.quote(market, quote)).ok).toBe(true);
  });

  it('retries a 429 on a cancel but answers a quote unavailable at once', async () => {
    zoom.script.push({ status: 429 }, { status: 429 });
    expect(await carrier.cancel(market, 'T20261024000001')).toEqual(unavailable);
    expect(zoom.seen).toHaveLength(2);
    zoom.seen.length = 0;
    zoom.script.push({ status: 429 });
    expect(await carrier.quote(market, other)).toEqual(unavailable);
    expect(zoom.seen).toHaveLength(1);
  });

  it('drops an oversized answer, and a body that is not JSON', async () => {
    zoom.script.push({
      status: 200,
      body: { deliverySpeed: '3 hour', price: 12, padding: 'x'.repeat(MAX_ANSWER_BYTES) },
    });
    expect(await carrier.quote(market, other)).toEqual(unavailable);
    zoom.script.push({ status: 200, raw: '<html>not json</html>' });
    expect(await carrier.quote(market, other)).toEqual(unavailable);
  });

  it('opens the circuit per kind of call after the threshold, then lets one trial through', async () => {
    const { failureThreshold, cooldownSeconds } = configured.circuitBreaker;
    carrier = build({ maxAttempts: 1 });
    for (let n = 0; n < failureThreshold; n += 1) zoom.script.push({ status: 500 });
    for (let n = 0; n < failureThreshold; n += 1) {
      expect((await carrier.book(market, request)).ok).toBe(false);
    }
    expect(zoom.seen).toHaveLength(failureThreshold);
    expect(await carrier.book(market, request)).toEqual(unavailable);
    expect(zoom.seen).toHaveLength(failureThreshold);
    // Quotes have their own circuit.
    expect((await carrier.quote(market, other)).ok).toBe(true);
    clock.advance(Temporal.Duration.from({ seconds: cooldownSeconds }));
    expect((await carrier.book(market, request)).ok).toBe(true);
  });

  it('is not configured, and sends nothing, with the switch off or the key missing', async () => {
    // Off as shipped.
    expect(configured.enabled).toBe(false);
    const http = new Zoom2uHttpClient(new CircuitBreaker(clock), zoom.fetch);
    const shippedOff = new Zoom2uCarrier(
      new ConfigZoom2uPolicy(realMarkets, CREDENTIALS),
      http,
      clock,
    );
    const notConfigured = { ok: false, error: { code: 'carrier.not-configured' } };
    expect(await shippedOff.book(market, request)).toEqual(notConfigured);
    expect(await shippedOff.quote(market, quote)).toEqual(notConfigured);
    expect(await shippedOff.cancel(market, 'T20261024000001')).toEqual(notConfigured);
    expect(await shippedOff.status(market, 'T20261024000001')).toEqual(notConfigured);
    expect(shippedOff.capabilities(market)).toBeNull();
    // On, but without the key.
    const short = build({}, { apiKeys: {} });
    expect(await short.book(market, request)).toEqual(notConfigured);
    expect(await short.quote(market, quote)).toEqual(notConfigured);
    expect(short.capabilities(market)).toBeNull();
    expect(zoom.seen).toEqual([]);
  });

  it('declares its fleet and capabilities, with the currency of the Market', () => {
    expect(carrier.fleet).toBe('zoom2u');
    expect(carrier.capabilities(market)).toEqual({
      fleet: 'zoom2u',
      methods: ['instant', 'same_day', 'scheduled'],
      serviceAreas: configured.serviceAreas,
      outsideCityAreasOnly: false,
      temperatures: ['ambient'],
      maxItemWeightGrams: 30_000,
      maxItems: 8,
      maxOrderValue: { amount: 50_000n, currency: real.defaultCurrency },
      prohibitedClasses: ['alcohol', 'tobacco', 'firearms', 'hazardous-materials', 'live-animals'],
      idempotentBooking: false,
      supportsWindow: false,
    });
    const caps = build({
      modes: ['on_demand'],
      serviceAreas: ['elsewhere'],
      supportsWindow: true,
      temperatures: ['ambient', 'chilled'],
    }).capabilities(market);
    // A window is declared only where scheduled trips are served.
    expect(caps).toMatchObject({
      methods: ['instant', 'same_day'],
      serviceAreas: ['elsewhere'],
      supportsWindow: false,
      temperatures: ['ambient', 'chilled'],
    });
    expect(
      build({ modes: ['scheduled'], supportsWindow: true }).capabilities(market),
    ).toMatchObject({
      methods: ['scheduled'],
      supportsWindow: true,
    });
  });

  it('leaks no key, answer body or personal data in any failure', async () => {
    const failures = [
      await (async () => {
        zoom.script.push({ status: 401, body: { echo: API_KEY } });
        return carrier.book(market, request);
      })(),
      await build({ modes: ['on_demand'] }).quote(market, { ...quote, mode: 'scheduled' }),
      await (async () => {
        zoom.script.push({ status: 500 });
        return carrier.book(market, request);
      })(),
      await (async () => {
        zoom.script.push({ status: 400, body: { message: 'Aisha Rahman 12 Example Street' } });
        return carrier.book(market, request);
      })(),
    ];
    const joined = failures.map((failure) => JSON.stringify(failure)).join('\n');
    for (const secret of [API_KEY, 'Aisha', 'Example Street', 'Bearer']) {
      expect(joined).not.toContain(secret);
    }
    for (const failure of failures) {
      expect(failure.ok).toBe(false);
      if (!failure.ok) expect(Object.keys(failure.error)).toEqual(['code']);
    }
  });
});

describe('toFleetStatus (Zoom2u)', () => {
  it.each([
    ['UNASSIGNED', 'pending'],
    ['ACCEPTED', 'assigned'],
    ['ON_ROUTE_TO_PICKUP', 'assigned'],
    ['PICKED_UP', 'picked_up'],
    ['ON_ROUTE_TO_DROPOFF', 'picked_up'],
    ['TRIED_TO_DELIVER', 'picked_up'],
    ['DROPPED_OFF', 'delivered'],
    ['CANCELLED', 'cancelled'],
    ['RETURNING', 'picked_up'],
    ['RETURNED', 'returned'],
    ['ON_HOLD_WITH_COURIER', 'picked_up'],
    ['picked_up', 'picked_up'],
    ['EXPLODED', null],
    ['', null],
    ['CANCELED', null],
  ])('maps %s to %s', (raw, expected) => {
    expect(toFleetStatus(raw)).toBe(expected);
  });
});
