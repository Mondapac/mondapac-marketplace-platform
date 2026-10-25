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
  ConfigAusPostPolicy,
  type AusPostConfig,
  type AusPostCredentials,
} from './config-auspost-policy';
import {
  AUSPOST_TRACKING_URL,
  AusPostCarrier,
  QUOTE_CACHE_MS,
  toFleetStatus,
} from './auspost-carrier';
import {
  AUSPOST_API_PREFIX,
  AUSPOST_API_URLS,
  AusPostHttpClient,
  type AusPostFetch,
} from './auspost-http-client';

// The Australia Post adapter against a mocked `fetch` (no network at all), on both Market
// fixtures (AU: AUD, ZZ: JPY). The fake speaks the shape of the Shipping and Tracking API
// (developers.auspost.com.au) as the adapter reads it: Basic auth plus `Account-Number`, then
// `prices/items`, `shipments`, `shipments/{id}` (DELETE) and `track?tracking_ids=` under
// `/shipping/v1/`, with prices as decimals in the local currency and no currency field.

const realMarkets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const T0 = Temporal.Instant.from('2026-10-24T10:00:00Z');
const API_KEY = 'auspost.key_test_0123456789';
const API_PASSWORD = 'auspost.password_test_0123456789';
const ACCOUNT = '1234567890';
const CREDENTIALS: AusPostCredentials = {
  apiKeys: { AU: API_KEY, ZZ: API_KEY },
  apiPasswords: { AU: API_PASSWORD, ZZ: API_PASSWORD },
  accountNumbers: { AU: ACCOUNT, ZZ: ACCOUNT },
};
const BASIC = `Basic ${Buffer.from(`${API_KEY}:${API_PASSWORD}`).toString('base64')}`;
const API = `${AUSPOST_API_URLS.testbed}${AUSPOST_API_PREFIX}`;
const REF = 'SHIP000001:ART000001';

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

/** A fake Australia Post: scripted answers first, then the real behaviour, via injected fetch. */
class FakeAusPost {
  readonly seen: Seen[] = [];
  readonly script: Scripted[] = [];
  readonly shipments = new Map<string, { article: string; status: string }>();
  /** The price (a decimal, like the API's) the fake quotes. */
  price: number = 12.5;
  #shipments = 0;

  reset(): void {
    this.#shipments = 0;
  }

  readonly fetch: AusPostFetch = async (url, init) => {
    const json =
      init.body?.startsWith('{') === true ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    this.seen.push({ method: init.method, url, headers: init.headers, body: init.body, json });
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
    if (init.headers.authorization !== BASIC || init.headers['account-number'] !== ACCOUNT) {
      return send(401, { message: 'no' });
    }
    const path = url.slice(API.length);
    if (init.method === 'POST' && path === '/prices/items') {
      return send(200, {
        items: [
          {
            prices: [
              { product_id: 'OTHER', calculated_price: 1 },
              { product_id: '7E55', calculated_price: this.price, delivery_estimate_days: 3 },
            ],
          },
        ],
      });
    }
    if (init.method === 'POST' && path === '/shipments') {
      // No idempotency key: every create is a new shipment.
      this.#shipments += 1;
      const n = String(this.#shipments).padStart(6, '0');
      this.shipments.set(`SHIP${n}`, { article: `ART${n}`, status: 'Created' });
      return send(201, {
        shipments: [
          {
            shipment_id: `SHIP${n}`,
            items: [{ tracking_details: { article_id: `ART${n}`, consignment_id: `CON${n}` } }],
          },
        ],
      });
    }
    const one = /^\/shipments\/(SHIP[0-9]+)$/.exec(path);
    if (init.method === 'DELETE' && one !== null) {
      const shipment = this.shipments.get(one[1]!);
      if (shipment === undefined) return send(404, { message: 'not found' });
      shipment.status = 'Cancelled';
      return send(204);
    }
    const track = /^\/track\?tracking_ids=(ART[0-9]+)$/.exec(path);
    if (init.method === 'GET' && track !== null) {
      const found = [...this.shipments.values()].find((s) => s.article === track[1]);
      return found === undefined
        ? send(404, {})
        : send(200, {
            tracking_results: [
              { tracking_id: found.article, status: found.status, trackable_items: [] },
            ],
          });
    }
    return send(404, { message: 'route' });
  };
}

/** The Market registry with Australia Post switched on (and any override) for every Market. */
const registryWith = (override: Partial<AusPostConfig> = {}): MarketRegistry =>
  ({
    get: (id: string) => {
      const real = realMarkets.get(id as never);
      return {
        ...real,
        shipping: {
          ...real.shipping,
          auspost: { ...real.shipping!.auspost!, enabled: true, ...override },
        },
      };
    },
  }) as unknown as MarketRegistry;

describe.each([['AU'], ['ZZ']] as const)('AusPostCarrier in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const real = realMarkets.get(market.marketId);
  const configured = real.shipping!.auspost!;
  const post = new FakeAusPost();
  let clock: FixedClock;
  let slept: number[];

  const build = (override: Partial<AusPostConfig> = {}, credentials = CREDENTIALS) => {
    const http = new AusPostHttpClient(new CircuitBreaker(clock), post.fetch, (ms) => {
      slept.push(ms);
      return Promise.resolve();
    });
    return new AusPostCarrier(
      new ConfigAusPostPolicy(registryWith(override), credentials),
      http,
      clock,
    );
  };
  let carrier: AusPostCarrier;

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
      addressLines: ['12 Example Street', 'Unit 4'],
      postcode: code === 'AU' ? '6725' : '1000002',
      locality: 'Remoteville',
      region: code === 'AU' ? 'WA' : null,
      location: null,
      notes: 'Leave at the door',
    },
    parcel: {
      weightGrams: 5000,
      volumeLitres: 8,
      temperature: 'ambient',
      itemCount: 2,
      declaredValue: { amount: 12_000n, currency: real.defaultCurrency },
    },
    method: 'scheduled',
    mode: 'scheduled',
    window: null,
  };
  const quote: CarrierQuoteRequest = {
    pickup: { postcode: request.pickup.postcode, locality: null, region: null },
    dropoff: { postcode: request.dropoff.postcode, locality: null, region: null },
    parcel: request.parcel,
    method: 'scheduled',
    mode: 'scheduled',
  };
  const other: CarrierQuoteRequest = {
    ...quote,
    dropoff: { postcode: code === 'AU' ? '6000' : '1000003', locality: null, region: null },
  };
  const window = { start: T0.add({ hours: 48 }), end: T0.add({ hours: 72 }) };
  const unauthorized = { ok: false, error: { code: 'carrier.unauthorized' } };
  const unavailable = { ok: false, error: { code: 'carrier.unavailable' } };
  const notSent = { ok: false, error: { code: 'carrier.not-sent' } };
  const refused = { ok: false, error: { code: 'carrier.refused' } };
  // Prices are decimals in the Market's currency: 12.50 AUD is 1250 minor units, 12.5 JPY is not
  // a price at all (JPY has no minor unit), so the fake quotes a whole amount there.
  const exponent = real.defaultCurrency === 'JPY' ? 0 : 2;
  const price = exponent === 0 ? 1250 : 12.5;
  const priced = (value: unknown, extra: Record<string, unknown> = {}) => ({
    items: [{ prices: [{ product_id: configured.productId, calculated_price: value, ...extra }] }],
  });

  beforeEach(() => {
    post.seen.length = 0;
    post.script.length = 0;
    post.shipments.clear();
    post.reset();
    post.price = price;
    clock = new FixedClock(T0);
    slept = [];
    carrier = build();
  });

  it('sends Basic auth, the account number, JSON, no redirects, to the documented testbed host', async () => {
    expect((await carrier.quote(market, quote)).ok).toBe(true);
    expect(post.seen[0]).toMatchObject({
      method: 'POST',
      url: `${API}/prices/items`,
      headers: {
        authorization: BASIC,
        'account-number': ACCOUNT,
        'content-type': 'application/json',
      },
    });
    expect(AUSPOST_API_URLS.production).toBe('https://digitalapi.auspost.com.au');
    carrier = build({ environment: 'production' });
    expect((await carrier.quote(market, other)).ok).toBe(false);
    expect(post.seen.at(-1)!.url).toBe(
      `${AUSPOST_API_URLS.production}${AUSPOST_API_PREFIX}/prices/items`,
    );
  });

  it('quotes the Market product with postcodes only, priced in the Market currency', async () => {
    expect(await carrier.quote(market, quote)).toEqual({
      ok: true,
      value: {
        price: { amount: 1250n, currency: real.defaultCurrency },
        etaMinutes: 3 * 24 * 60,
        expiresAt: null,
      },
    });
    expect(post.seen[0]!.json).toEqual({
      from: { postcode: quote.pickup.postcode },
      to: { postcode: quote.dropoff.postcode },
      items: [{ product_id: configured.productId, length: 20, height: 20, width: 20, weight: 5 }],
    });
  });

  it('sends the locality and region of a quote stop as suburb and state only when it has them', async () => {
    await carrier.quote(market, {
      ...quote,
      pickup: { postcode: quote.pickup.postcode, locality: 'Sunnybank', region: 'QLD' },
      dropoff: { postcode: quote.dropoff.postcode, locality: 'Remoteville', region: null },
    });
    expect(post.seen[0]!.json.from).toEqual({
      suburb: 'Sunnybank',
      state: 'QLD',
      postcode: quote.pickup.postcode,
    });
    expect(post.seen[0]!.json.to).toEqual({
      suburb: 'Remoteville',
      postcode: quote.dropoff.postcode,
    });
  });

  it('gives an ETA from the delivery estimate in days when there is one, else null, and a null expiry always', async () => {
    for (const days of [undefined, 'soon', -1, 2.5, 400, null]) {
      post.script.push({
        status: 200,
        body: priced(price, days === undefined ? {} : { delivery_estimate_days: days }),
      });
      expect(
        await carrier.quote(market, {
          ...quote,
          parcel: { ...quote.parcel, itemCount: 1 + post.seen.length },
        }),
      ).toMatchObject({ ok: true, value: { etaMinutes: null, expiresAt: null } });
    }
    post.script.push({ status: 200, body: priced(price, { delivery_estimate_days: 0 }) });
    expect(await carrier.quote(market, other)).toMatchObject({
      ok: true,
      value: { etaMinutes: 0 },
    });
  });

  it('keeps a quote for five minutes, so a repeated checkout asks Australia Post once', async () => {
    expect((await carrier.quote(market, quote)).ok).toBe(true);
    expect((await carrier.quote(market, quote)).ok).toBe(true);
    expect(post.seen).toHaveLength(1);
    clock.advance(Temporal.Duration.from({ milliseconds: QUOTE_CACHE_MS }));
    expect((await carrier.quote(market, quote)).ok).toBe(true);
    expect(post.seen).toHaveLength(2);
  });

  it.each([
    ['a text price', priced('twelve')],
    ['a negative price', priced(-1)],
    ['a zero price', priced(0)],
    ['a huge price', priced(1e30)],
    ['a price finer than the currency', priced(12.505)],
    ['no price', { items: [{ prices: [{ product_id: '7E55' }] }] }],
    [
      'only another product',
      { items: [{ prices: [{ product_id: 'OTHER', calculated_price: 5 }] }] },
    ],
    ['no items', { items: [] }],
    ['an array', [priced(12)]],
    ['null', null],
  ])('refuses a quote answer with %s', async (_label, body) => {
    post.script.push({ status: 200, body });
    expect(await carrier.quote(market, quote)).toEqual(unavailable);
  });

  it('accepts a price given as a decimal string', async () => {
    post.script.push({ status: 200, body: priced(exponent === 0 ? '1250' : '12.50') });
    expect(await carrier.quote(market, quote)).toMatchObject({
      ok: true,
      value: { price: { amount: 1250n } },
    });
  });

  it('books with the order id as the reference, names, phones and addresses, and builds the tracking link from the article id', async () => {
    expect(await carrier.book(market, request)).toEqual({
      ok: true,
      value: {
        carrierReference: 'SHIP000001:ART000001',
        carrierStatus: 'CREATED',
        trackingUrl: 'https://auspost.com.au/mypost/track/#/details/ART000001',
      },
    });
    const [call] = post.seen;
    expect(call).toMatchObject({ method: 'POST', url: `${API}/shipments` });
    expect(call!.json).toEqual({
      shipments: [
        {
          shipment_reference: request.externalReference,
          sender_references: [request.externalReference],
          from: {
            name: 'Test Halal Butcher',
            lines: ['1 Shop Street'],
            suburb: 'Sunnybank',
            ...(code === 'AU' ? { state: 'QLD' } : {}),
            postcode: request.pickup.postcode,
            phone: '+61730000000',
          },
          to: {
            name: 'Aisha Rahman',
            lines: ['12 Example Street', 'Unit 4'],
            suburb: 'Remoteville',
            ...(code === 'AU' ? { state: 'WA' } : {}),
            postcode: request.dropoff.postcode,
            phone: '+61412345678',
            delivery_instructions: 'Leave at the door',
          },
          items: [
            {
              product_id: configured.productId,
              length: 20,
              height: 20,
              width: 20,
              weight: 5,
              item_reference: request.externalReference,
            },
          ],
        },
      ],
    });
    // The state is never inferred: a market without a region sends none.
    if (code !== 'AU') {
      expect(JSON.stringify(call!.json)).not.toContain('"state"');
    }
  });

  it('accepts a scheduled booking with no window, and ignores a window when one is given', async () => {
    expect((await carrier.book(market, request)).ok).toBe(true);
    const withoutWindow = post.seen[0]!.body;
    post.seen.length = 0;
    expect((await carrier.book(market, { ...request, window })).ok).toBe(true);
    expect(post.seen[0]!.body).toBe(withoutWindow);
    expect(post.seen[0]!.body).not.toContain(window.start.toString());
    expect(post.seen[0]!.body).not.toContain(window.end.toString());
  });

  it('never retries a booking: no idempotency key is documented, so a fault is unavailable at once', async () => {
    post.script.push({ status: 503 });
    expect(await carrier.book(market, request)).toEqual(unavailable);
    post.script.push('network');
    expect(await carrier.book(market, request)).toEqual(unavailable);
    post.script.push('hang');
    carrier = build({ timeoutMs: 20, maxAttempts: 3 });
    expect(await carrier.book(market, request)).toEqual(unavailable);
    expect(post.seen).toHaveLength(3);
    expect(slept).toEqual([]);
    expect(post.shipments.size).toBe(0);
  });

  it('refuses, without a call, an on-demand trip, a parcel that is not ambient, or one beyond the limits', async () => {
    const { limits } = configured;
    const over = (parcel: Partial<CarrierBookingRequest['parcel']>) => ({
      ...request,
      parcel: { ...request.parcel, ...parcel },
    });
    const cases: CarrierBookingRequest[] = [
      { ...request, method: 'instant', mode: 'on_demand' },
      { ...request, method: 'same_day', mode: 'on_demand' },
      over({ temperature: 'chilled' }),
      over({ temperature: 'frozen' }),
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
    ];
    for (const refusedRequest of cases) {
      expect(await carrier.book(market, refusedRequest)).toEqual(refused);
      expect(
        await carrier.quote(market, {
          pickup: quote.pickup,
          dropoff: quote.dropoff,
          parcel: refusedRequest.parcel,
          method: refusedRequest.method,
          mode: refusedRequest.mode,
        }),
      ).toEqual(refused);
    }
    // Chilled stays refused even when a (mis)configuration would list it.
    carrier = build({ modes: ['scheduled'], prohibitedClasses: [] });
    expect(await carrier.book(market, over({ temperature: 'chilled' }))).toEqual(refused);
    expect(post.seen).toEqual([]);
    // Exactly at the limits it goes through.
    const atLimits = over({
      weightGrams: limits.maxItemWeightGrams,
      itemCount: limits.maxItems,
      declaredValue: { amount: BigInt(limits.maxOrderValueMinor), currency: real.defaultCurrency },
    });
    expect((await carrier.book(market, atLimits)).ok).toBe(true);
  });

  it('builds the tracking link from a checked article id on an Australia Post host, never from the answer', async () => {
    expect(AUSPOST_TRACKING_URL('ART000001')).toBe(
      'https://auspost.com.au/mypost/track/#/details/ART000001',
    );
    expect(new URL(AUSPOST_TRACKING_URL('ART000001')).hostname).toBe('auspost.com.au');
    // A link in the answer is not used.
    post.script.push({
      status: 200,
      body: {
        shipments: [
          {
            shipment_id: 'SHIP000050',
            tracking_url: 'https://evil.example.test/x',
            items: [{ tracking_details: { article_id: 'ART000050' } }],
          },
        ],
      },
    });
    expect(await carrier.book(market, request)).toMatchObject({
      ok: true,
      value: { trackingUrl: 'https://auspost.com.au/mypost/track/#/details/ART000050' },
    });
    // An article id that is not plain alphanumerics gives no link and no track reference.
    for (const article of ['AB/../x', 'a b c d', 'https://evil.test/', 'ab', 12345678, null]) {
      post.script.push({
        status: 200,
        body: {
          shipments: [
            { shipment_id: 'SHIP000051', items: [{ tracking_details: { article_id: article } }] },
          ],
        },
      });
      expect(await carrier.book(market, request)).toEqual({
        ok: true,
        value: { carrierReference: 'SHIP000051', carrierStatus: 'CREATED', trackingUrl: null },
      });
    }
  });

  it.each([
    ['no shipment id', { shipments: [{ items: [] }] }],
    ['a shipment id with a slash', { shipments: [{ shipment_id: 'S1/../admin' }] }],
    ['a numeric shipment id', { shipments: [{ shipment_id: 123456789 }] }],
    ['no shipments', { shipments: [] }],
    ['an array', [{ shipment_id: 'SHIP000001' }]],
  ])('refuses a booking answer with %s', async (_label, body) => {
    post.script.push({ status: 200, body });
    expect(await carrier.book(market, request)).toEqual(unavailable);
  });

  it('cancels with a DELETE, reads a status by article id, and refuses a malformed reference without a call', async () => {
    const booked = await carrier.book(market, request);
    const reference = booked.ok ? booked.value.carrierReference : '';
    expect(await carrier.status(market, reference)).toEqual({
      ok: true,
      value: { status: 'pending', carrierStatus: 'CREATED' },
    });
    expect(post.seen.at(-1)).toMatchObject({
      method: 'GET',
      url: `${API}/track?tracking_ids=ART000001`,
    });
    expect(await carrier.cancel(market, reference)).toEqual({
      ok: true,
      value: { carrierStatus: 'CANCELLED' },
    });
    expect(post.seen.at(-1)).toMatchObject({
      method: 'DELETE',
      url: `${API}/shipments/SHIP000001`,
      body: undefined,
    });
    expect(await carrier.status(market, reference)).toEqual({
      ok: true,
      value: { status: 'cancelled', carrierStatus: 'CANCELLED' },
    });
    const calls = post.seen.length;
    expect(await carrier.cancel(market, '../../admin')).toEqual(refused);
    expect(await carrier.status(market, 'a/b')).toEqual(refused);
    // A reference without an article id cannot be tracked.
    expect(await carrier.status(market, 'SHIP000001')).toEqual(refused);
    expect(post.seen).toHaveLength(calls);
  });

  it('refuses a cancel Australia Post rejects and an unknown shipment, without retrying', async () => {
    post.script.push({ status: 400, body: { errors: [{ code: 'ALREADY_LODGED' }] } });
    expect(await carrier.cancel(market, 'SHIP000001')).toEqual(refused);
    expect(await carrier.cancel(market, 'SHIP000009')).toEqual(refused);
    expect(post.seen).toHaveLength(2);
    expect(slept).toEqual([]);
  });

  it.each([
    ['Created', 'CREATED', 'pending'],
    ['Initiated', 'INITIATED', 'pending'],
    ['Sealed', 'SEALED', 'pending'],
    ['In transit', 'IN_TRANSIT', 'picked_up'],
    ['Awaiting collection', 'AWAITING_COLLECTION', 'picked_up'],
    ['Possible delay', 'POSSIBLE_DELAY', 'picked_up'],
    ['Unable to deliver', 'UNABLE_TO_DELIVER', 'picked_up'],
    ['Delivered', 'DELIVERED', 'delivered'],
    ['Cancelled', 'CANCELLED', 'cancelled'],
    ['DELIVERED', 'DELIVERED', 'delivered'],
  ])(
    'maps the Australia Post status %s to %s and the common status %s',
    async (status, expected, common) => {
      post.script.push({
        status: 200,
        body: { tracking_results: [{ tracking_id: 'ART000001', status }] },
      });
      expect(await carrier.status(market, REF)).toEqual({
        ok: true,
        value: { status: common, carrierStatus: expected },
      });
    },
  );

  it('refuses a status answer about another article, with an unknown status or no status', async () => {
    post.script.push({
      status: 200,
      body: { tracking_results: [{ tracking_id: 'ART000002', status: 'Delivered' }] },
    });
    expect(await carrier.status(market, REF)).toEqual(unavailable);
    post.script.push({
      status: 200,
      body: { tracking_results: [{ tracking_id: 'ART000001', status: 'Exploded' }] },
    });
    expect(await carrier.status(market, REF)).toEqual(unavailable);
    post.script.push({ status: 200, body: { tracking_results: [{ tracking_id: 'ART000001' }] } });
    expect(await carrier.status(market, REF)).toEqual(unavailable);
    post.script.push({ status: 200, body: { tracking_results: [] } });
    expect(await carrier.status(market, REF)).toEqual(unavailable);
  });

  it('never retries a refusal (4xx)', async () => {
    post.script.push({ status: 400, body: { errors: [] } });
    expect(await carrier.quote(market, quote)).toEqual(refused);
    expect(post.seen).toHaveLength(1);
    expect(slept).toEqual([]);
  });

  it('answers unauthorized for rejected credentials (401, 403) on every call, without a retry', async () => {
    post.script.push({ status: 401 });
    expect(await carrier.quote(market, quote)).toEqual(unauthorized);
    post.script.push({ status: 403 });
    expect(await carrier.cancel(market, 'SHIP000001')).toEqual(unauthorized);
    post.script.push({ status: 401 });
    expect(await carrier.book(market, request)).toEqual(unauthorized);
    post.script.push({ status: 403 });
    expect(await carrier.status(market, REF)).toEqual(unauthorized);
    expect(post.seen).toHaveLength(4);
    expect(slept).toEqual([]);
  });

  it('answers unauthorized when the credentials are wrong at the host itself', async () => {
    const wrong = build(
      {},
      { ...CREDENTIALS, apiPasswords: { AU: 'wrong_password', ZZ: 'wrong_password' } },
    );
    expect(await wrong.quote(market, quote)).toEqual(unauthorized);
  });

  it('never counts rejected credentials on the circuit: unauthorized stays unauthorized past the threshold', async () => {
    const { failureThreshold } = configured.circuitBreaker;
    for (let n = 0; n < failureThreshold + 2; n += 1) {
      post.script.push({ status: 401 });
      expect(await carrier.book(market, request)).toEqual(unauthorized);
    }
    expect(post.seen).toHaveLength(failureThreshold + 2);
  });

  it('retries a 5xx on a status read up to the configured attempts with doubling backoff', async () => {
    carrier = build({ maxAttempts: 3, backoffMs: 100 });
    for (let n = 0; n < 3; n += 1) post.script.push({ status: 503 });
    expect(await carrier.status(market, REF)).toEqual(unavailable);
    expect(post.seen).toHaveLength(3);
    expect(slept).toEqual([100, 200]);
    post.seen.length = 0;
    post.script.push({ status: 502 });
    expect((await carrier.quote(market, quote)).ok).toBe(true);
    expect(post.seen).toHaveLength(2);
  });

  it('retries a timeout and a network fault on a quote, then is unavailable', async () => {
    carrier = build({ timeoutMs: 20, maxAttempts: 2 });
    post.script.push('hang', 'network');
    expect(await carrier.quote(market, quote)).toEqual(unavailable);
    expect(post.seen).toHaveLength(2);
    post.script.push('hang');
    expect((await carrier.quote(market, quote)).ok).toBe(true);
  });

  it('retries a 429 on a cancel but answers a quote unavailable at once', async () => {
    post.script.push({ status: 429 }, { status: 429 });
    expect(await carrier.cancel(market, 'SHIP000001')).toEqual(unavailable);
    expect(post.seen).toHaveLength(2);
    post.seen.length = 0;
    post.script.push({ status: 429 });
    expect(await carrier.quote(market, other)).toEqual(unavailable);
    expect(post.seen).toHaveLength(1);
  });

  it('drops an oversized answer, and a body that is not JSON', async () => {
    post.script.push({
      status: 200,
      body: { ...priced(price), padding: 'x'.repeat(MAX_ANSWER_BYTES) },
    });
    expect(await carrier.quote(market, other)).toEqual(unavailable);
    post.script.push({ status: 200, raw: '<html>not json</html>' });
    expect(await carrier.quote(market, other)).toEqual(unavailable);
  });

  it('opens the circuit per kind of call after the threshold, then lets one trial through', async () => {
    const { failureThreshold, cooldownSeconds } = configured.circuitBreaker;
    carrier = build({ maxAttempts: 1 });
    for (let n = 0; n < failureThreshold; n += 1) post.script.push({ status: 500 });
    for (let n = 0; n < failureThreshold; n += 1) {
      expect((await carrier.book(market, request)).ok).toBe(false);
    }
    expect(post.seen).toHaveLength(failureThreshold);
    expect(await carrier.book(market, request)).toEqual(notSent);
    expect(post.seen).toHaveLength(failureThreshold);
    // Quotes have their own circuit.
    expect((await carrier.quote(market, other)).ok).toBe(true);
    clock.advance(Temporal.Duration.from({ seconds: cooldownSeconds }));
    expect((await carrier.book(market, request)).ok).toBe(true);
  });

  it('is not configured, and sends nothing, with the switch off or any credential missing', async () => {
    // Off as shipped.
    expect(configured.enabled).toBe(false);
    const http = new AusPostHttpClient(new CircuitBreaker(clock), post.fetch);
    const shippedOff = new AusPostCarrier(
      new ConfigAusPostPolicy(realMarkets, CREDENTIALS),
      http,
      clock,
    );
    const notConfigured = { ok: false, error: { code: 'carrier.not-configured' } };
    expect(await shippedOff.book(market, request)).toEqual(notConfigured);
    expect(await shippedOff.quote(market, quote)).toEqual(notConfigured);
    expect(await shippedOff.cancel(market, 'SHIP000001')).toEqual(notConfigured);
    expect(await shippedOff.status(market, REF)).toEqual(notConfigured);
    expect(shippedOff.capabilities(market)).toBeNull();
    // On, but without one of the three credentials.
    for (const missing of ['apiKeys', 'apiPasswords', 'accountNumbers'] as const) {
      const short = build({}, { ...CREDENTIALS, [missing]: {} });
      expect(await short.book(market, request)).toEqual(notConfigured);
      expect(await short.quote(market, quote)).toEqual(notConfigured);
      expect(short.capabilities(market)).toBeNull();
    }
    expect(post.seen).toEqual([]);
  });

  it('declares its fleet and capabilities: scheduled only, ambient, no window, outside the city areas', () => {
    expect(carrier.fleet).toBe('auspost');
    expect(carrier.capabilities(market)).toEqual({
      fleet: 'auspost',
      methods: ['scheduled'],
      serviceAreas: configured.serviceAreas,
      outsideCityAreasOnly: true,
      temperatures: ['ambient'],
      maxItemWeightGrams: 22_000,
      maxItems: 8,
      maxOrderValue: { amount: 50_000n, currency: real.defaultCurrency },
      prohibitedClasses: [
        'alcohol',
        'tobacco',
        'firearms',
        'hazardous-materials',
        'live-animals',
        'perishable',
        'chilled',
        'frozen',
      ],
      idempotentBooking: false,
      supportsWindow: false,
    });
    const caps = build({ serviceAreas: ['elsewhere'], outsideCityAreasOnly: false }).capabilities(
      market,
    );
    expect(caps).toMatchObject({
      methods: ['scheduled'],
      serviceAreas: ['elsewhere'],
      outsideCityAreasOnly: false,
      supportsWindow: false,
    });
    // No instant or same-day method is ever declared.
    expect(caps!.methods).not.toContain('instant');
    expect(caps!.methods).not.toContain('same_day');
  });

  it('keeps capabilities and what it accepts in agreement', async () => {
    const caps = carrier.capabilities(market)!;
    const instant = await carrier.quote(market, { ...quote, method: 'instant', mode: 'on_demand' });
    expect(caps.methods.includes('instant') || caps.methods.includes('same_day')).toBe(false);
    expect(instant).toEqual(refused);
    // A scheduled order with no window (what the capabilities admit) is accepted ...
    expect(caps.supportsWindow).toBe(false);
    expect((await carrier.book(market, { ...request, window: null })).ok).toBe(true);
    // ... and one without scheduled in the Market's modes declares and takes nothing.
    const none = build({ modes: [] });
    expect(none.capabilities(market)!.methods).toEqual([]);
    expect(await none.book(market, request)).toEqual(refused);
  });

  it('leaks no credential, answer body or personal data in any failure', async () => {
    const failures = [
      await (async () => {
        post.script.push({ status: 401, body: { echo: API_KEY } });
        return carrier.book(market, request);
      })(),
      await carrier.quote(market, { ...quote, method: 'instant', mode: 'on_demand' }),
      await (async () => {
        post.script.push({ status: 500 });
        return carrier.book(market, request);
      })(),
      await (async () => {
        post.script.push({ status: 400, body: { message: 'Aisha Rahman 12 Example Street' } });
        return carrier.book(market, request);
      })(),
    ];
    const joined = failures.map((failure) => JSON.stringify(failure)).join('\n');
    for (const secret of [API_KEY, API_PASSWORD, ACCOUNT, 'Aisha', 'Example Street', 'Basic']) {
      expect(joined).not.toContain(secret);
    }
    for (const failure of failures) {
      expect(failure.ok).toBe(false);
      if (!failure.ok) expect(Object.keys(failure.error)).toEqual(['code']);
    }
  });
});

describe('toFleetStatus (Australia Post)', () => {
  it.each([
    ['CREATED', 'pending'],
    ['INITIATED', 'pending'],
    ['SEALED', 'pending'],
    ['IN_TRANSIT', 'picked_up'],
    ['AWAITING_COLLECTION', 'picked_up'],
    ['POSSIBLE_DELAY', 'picked_up'],
    ['UNABLE_TO_DELIVER', 'picked_up'],
    ['DELIVERED', 'delivered'],
    ['CANCELLED', 'cancelled'],
    ['in_transit', 'picked_up'],
    ['EXPLODED', null],
    ['', null],
    ['CANCELED', null],
    ['RETURNED', null],
  ])('maps %s to %s', (raw, expected) => {
    expect(toFleetStatus(raw)).toBe(expected);
  });

  it('never maps anything to failed or returned on its own, and only DELIVERED to delivered', () => {
    const words = [
      'CREATED',
      'INITIATED',
      'SEALED',
      'IN_TRANSIT',
      'AWAITING_COLLECTION',
      'POSSIBLE_DELAY',
      'UNABLE_TO_DELIVER',
      'DELIVERED',
      'CANCELLED',
    ];
    const mapped = words.map((word) => [word, toFleetStatus(word)] as const);
    expect(mapped.filter(([, status]) => status === 'failed' || status === 'returned')).toEqual([]);
    expect(mapped.filter(([, status]) => status === 'delivered').map(([word]) => word)).toEqual([
      'DELIVERED',
    ]);
  });
});
