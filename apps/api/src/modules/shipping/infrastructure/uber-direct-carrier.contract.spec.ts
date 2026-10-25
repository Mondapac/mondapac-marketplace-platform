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
  ConfigUberDirectPolicy,
  type UberDirectConfig,
  type UberDirectCredentials,
} from './config-uber-direct-policy';
import { QUOTE_CACHE_MS, toFleetStatus, UberDirectCarrier } from './uber-direct-carrier';
import {
  TOKEN_EARLY_REFRESH_MS,
  UBER_API_URL,
  UBER_AUTH_URL,
  UberDirectHttpClient,
  type UberFetch,
} from './uber-direct-http-client';

// The Uber Direct adapter of the fleet port against a mocked `fetch` (no network at all), on both Market fixtures
// (AU: AUD, ZZ: JPY). The fake speaks the shape of Uber's public Direct API: an OAuth2
// client-credentials token, then `delivery_quotes`, `deliveries`, `deliveries/{id}` and
// `deliveries/{id}/cancel` under `/v1/customers/{customer_id}/`, with fees in minor units.

const realMarkets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const T0 = Temporal.Instant.from('2026-10-24T10:00:00Z');
const CUSTOMER = 'cust-test-0001';
const CLIENT_ID = 'client-test-0001';
const CLIENT_SECRET = 'uber_secret_test_0123456789abcdef';
const CREDENTIALS: UberDirectCredentials = {
  customerIds: { AU: CUSTOMER, ZZ: CUSTOMER },
  clientIds: { AU: CLIENT_ID, ZZ: CLIENT_ID },
  clientSecrets: { AU: CLIENT_SECRET, ZZ: CLIENT_SECRET },
};
const API = `${UBER_API_URL}/${CUSTOMER}`;

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

/** A fake Uber: scripted answers first, then the real behaviour, all through an injected fetch. */
class FakeUber {
  readonly seen: Seen[] = [];
  readonly script: Scripted[] = [];
  readonly deliveries = new Map<string, Record<string, unknown>>();
  tokenLifeSeconds = 2_592_000;
  quoteCurrency = 'AUD';
  quoteExpires = '2026-10-24T10:15:00Z';
  /** When set, the API answers 401 whatever the token. */
  rejectEveryToken = false;
  /** When set, the next created delivery is created but its answer never arrives (a timeout). */
  loseNextBookingAnswer = false;
  #tokens = 0;
  #deliveries = 0;

  reset(): void {
    this.#deliveries = 0;
  }
  /** The token the fake accepts; a new grant replaces it. */
  valid = '';

  readonly fetch: UberFetch = async (url, init) => {
    const json =
      init.body?.startsWith('{') === true ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    this.seen.push({
      method: init.method,
      url,
      headers: init.headers,
      body: init.body,
      json: json,
    });
    expect(init.redirect).toBe('error');
    const next = this.script.shift();
    if (next === 'network') throw new Error('socket hang up');
    if (next === 'hang') {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }
    const send = (status: number, answer: unknown, raw?: string) => ({
      status,
      body: streamOf(raw ?? JSON.stringify(answer)),
    });
    if (next !== undefined) return send(next.status, next.body ?? { error: 'scripted' }, next.raw);
    if (url === UBER_AUTH_URL) {
      const form = new URLSearchParams(init.body);
      if (
        form.get('grant_type') !== 'client_credentials' ||
        form.get('scope') !== 'eats.deliveries' ||
        form.get('client_id') !== CLIENT_ID ||
        form.get('client_secret') !== CLIENT_SECRET
      ) {
        return send(400, { error: 'invalid_client' });
      }
      this.#tokens += 1;
      this.valid = `token-${this.#tokens}-abcdefgh`;
      return send(200, {
        access_token: this.valid,
        token_type: 'Bearer',
        expires_in: this.tokenLifeSeconds,
        scope: 'eats.deliveries',
      });
    }
    if (this.rejectEveryToken || init.headers.authorization !== `Bearer ${this.valid}`) {
      return send(401, { code: 'unauth' });
    }
    const path = url.slice(API.length);
    if (init.method === 'POST' && path === '/delivery_quotes') {
      return send(200, {
        kind: 'delivery_quote',
        id: 'dqt_0123456789',
        fee: 1250,
        currency: this.quoteCurrency.toLowerCase(),
        currency_type: this.quoteCurrency,
        expires: this.quoteExpires,
        duration: 25,
        pickup_address: 'echoed address of a person',
      });
    }
    if (init.method === 'POST' && path === '/deliveries') {
      // Deliberately no dedupe by external_id: Uber's behaviour there is unverified, so every
      // POST creates a delivery.
      const reference = String(json.external_id);
      this.#deliveries += 1;
      const delivery = {
        id: `del_${String(this.#deliveries).padStart(10, '0')}`,
        status: 'pending',
        external_id: reference,
        tracking_url: `https://track.uber.com/${reference}`,
        // Uber echoes the stops: the adapter must not read them.
        pickup_name: json.pickup_name,
        dropoff_name: json.dropoff_name,
        dropoff_phone_number: json.dropoff_phone_number,
      };
      this.deliveries.set(`${reference}#${this.#deliveries}`, delivery);
      if (this.loseNextBookingAnswer) {
        this.loseNextBookingAnswer = false;
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')));
        });
      }
      return send(200, delivery);
    }
    const cancel = /^\/deliveries\/(del_[0-9]+)\/cancel$/.exec(path);
    if (init.method === 'POST' && cancel !== null) {
      const delivery = [...this.deliveries.values()].find((d) => d.id === cancel[1]);
      if (delivery === undefined) return send(404, { code: 'not_found' });
      delivery.status = 'canceled';
      return send(200, delivery);
    }
    const one = /^\/deliveries\/(del_[0-9]+)$/.exec(path);
    if (init.method === 'GET' && one !== null) {
      const delivery = [...this.deliveries.values()].find((d) => d.id === one[1]);
      return delivery === undefined ? send(404, {}) : send(200, delivery);
    }
    return send(404, { code: 'route' });
  };

  /** The calls to the API (the token calls left out). */
  get api(): Seen[] {
    return this.seen.filter((call) => call.url !== UBER_AUTH_URL);
  }
  get tokenCalls(): Seen[] {
    return this.seen.filter((call) => call.url === UBER_AUTH_URL);
  }
}

/** The Market registry with Uber Direct switched on (and any override) for every Market. */
const registryWith = (override: Partial<UberDirectConfig> = {}): MarketRegistry =>
  ({
    get: (id: string) => {
      const real = realMarkets.get(id as never);
      return {
        ...real,
        shipping: {
          ...real.shipping,
          uberDirect: { ...real.shipping!.uberDirect!, enabled: true, ...override },
        },
      };
    },
  }) as unknown as MarketRegistry;

describe.each([['AU'], ['ZZ']] as const)('UberDirectCarrier in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const real = realMarkets.get(market.marketId);
  const country = real.customers!.address.countryCode;
  const configured = real.shipping!.uberDirect!;
  const uber = new FakeUber();
  let clock: FixedClock;
  let slept: number[];

  const build = (override: Partial<UberDirectConfig> = {}, credentials = CREDENTIALS) => {
    const http = new UberDirectHttpClient(new CircuitBreaker(clock), clock, uber.fetch, (ms) => {
      slept.push(ms);
      return Promise.resolve();
    });
    return new UberDirectCarrier(
      new ConfigUberDirectPolicy(registryWith(override), credentials),
      http,
      clock,
    );
  };
  let carrier: UberDirectCarrier;

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
  const elsewhere = (postcode: string): CarrierQuoteRequest => ({
    ...quote,
    dropoff: { postcode, locality: null, region: null },
  });
  const window = {
    start: T0.add({ hours: 2 }),
    end: T0.add({ hours: 3 }),
  };
  /** Gets a token (a status call for a delivery that does not exist) so the next script entry is an API answer. */
  const warm = async () => {
    expect(await carrier.status(market, 'del_0000000000')).toEqual({
      ok: false,
      error: { code: 'carrier.refused' },
    });
    uber.seen.length = 0;
  };
  const unavailable = { ok: false, error: { code: 'carrier.unavailable' } };
  const refused = { ok: false, error: { code: 'carrier.refused' } };
  const unauthorized = { ok: false, error: { code: 'carrier.unauthorized' } };

  beforeEach(() => {
    uber.seen.length = 0;
    uber.script.length = 0;
    uber.deliveries.clear();
    uber.reset();
    uber.tokenLifeSeconds = 2_592_000;
    uber.quoteCurrency = real.defaultCurrency;
    uber.rejectEveryToken = false;
    uber.loseNextBookingAnswer = false;
    clock = new FixedClock(T0);
    slept = [];
    carrier = build();
  });

  it('fetches one client-credentials token, keeps it, and renews it shortly before it expires', async () => {
    uber.tokenLifeSeconds = 3600;
    expect((await carrier.quote(market, quote)).ok).toBe(true);
    expect(uber.tokenCalls).toHaveLength(1);
    expect(uber.tokenCalls[0]).toMatchObject({
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    // Another call (a booking) reuses it.
    expect((await carrier.book(market, request)).ok).toBe(true);
    expect(uber.tokenCalls).toHaveLength(1);
    expect(uber.api[1]!.headers.authorization).toBe(`Bearer ${uber.valid}`);
    // Just before the early-refresh point it is still used, at it a new one is fetched.
    clock.advance(Temporal.Duration.from({ milliseconds: 3_600_000 - TOKEN_EARLY_REFRESH_MS - 1 }));
    expect((await carrier.cancel(market, 'del_0000000001')).ok).toBe(true);
    expect(uber.tokenCalls).toHaveLength(1);
    clock.advance(Temporal.Duration.from({ milliseconds: 1 }));
    expect((await carrier.cancel(market, 'del_0000000001')).ok).toBe(true);
    expect(uber.tokenCalls).toHaveLength(2);
  });

  it('refreshes the token once on a 401 and repeats the call; a second 401 is unauthorized', async () => {
    await warm();
    const first = uber.valid;
    // Uber revokes the token: the next call is answered 401, then goes through with a new token.
    uber.valid = 'revoked-token-xyz';
    const other = elsewhere(code === 'AU' ? '4000' : '1000003');
    expect((await carrier.quote(market, other)).ok).toBe(true);
    expect(uber.tokenCalls).toHaveLength(1);
    expect(uber.valid).not.toBe(first);
    expect(uber.api.map((call) => call.headers.authorization)).toEqual([
      `Bearer ${first}`,
      `Bearer ${uber.valid}`,
    ]);
    // A 401 even with a new token is not retried again: one refresh, one repeat, then refused.
    uber.seen.length = 0;
    uber.rejectEveryToken = true;
    expect(await carrier.book(market, request)).toEqual(unauthorized);
    expect(uber.api).toHaveLength(2);
    expect(uber.tokenCalls).toHaveLength(1);
  });

  it('maps a 403 on a call to unauthorized, once, with no retry', async () => {
    await warm();
    uber.script.push({ status: 403, body: { code: 'forbidden' } });
    expect(await carrier.book(market, request)).toEqual(unauthorized);
    expect(uber.api).toHaveLength(1);
    expect(slept).toEqual([]);
    expect(uber.deliveries.size).toBe(0);
  });

  it('asks for the token with the Market credentials only and calls the customer path', async () => {
    await carrier.book(market, request);
    const form = new URLSearchParams(uber.tokenCalls[0]!.body);
    expect(Object.fromEntries(form)).toEqual({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'client_credentials',
      scope: 'eats.deliveries',
    });
    expect(uber.api[0]!.url).toBe(`${API}/deliveries`);
  });

  it('answers unauthorized when the token endpoint says 401 or 403, unavailable for other token faults', async () => {
    uber.script.push({ status: 401, body: { error: 'invalid_client' } });
    expect(await carrier.book(market, request)).toEqual(unauthorized);
    expect(uber.api).toHaveLength(0);
    expect(uber.tokenCalls).toHaveLength(1);
    uber.script.push({ status: 403, body: { error: 'forbidden' } });
    expect(await carrier.quote(market, quote)).toEqual(unauthorized);
    expect(uber.api).toHaveLength(0);
    uber.script.push({ status: 200, body: { access_token: 'short', expires_in: 3600 } });
    expect(await carrier.book(market, request)).toEqual(unavailable);
    uber.script.push({ status: 503 }, { status: 503 });
    expect(await carrier.book(market, request)).toEqual(unavailable);
    expect(uber.api).toHaveLength(0);
  });

  it('keeps answering unauthorized for bad credentials past the circuit threshold', async () => {
    const { failureThreshold } = configured.circuitBreaker;
    for (let n = 0; n < failureThreshold + 3; n += 1) {
      uber.script.push({ status: n % 2 === 0 ? 401 : 403, body: { error: 'invalid_client' } });
      expect(await carrier.book(market, request)).toEqual(unauthorized);
    }
    // No API call was made, every attempt reached the token endpoint (the circuit never opened),
    // and once the credentials are good the call goes through.
    expect(uber.api).toHaveLength(0);
    expect(uber.tokenCalls).toHaveLength(failureThreshold + 3);
    expect((await carrier.book(market, request)).ok).toBe(true);
  });

  it('refuses a token grant whose type is not Bearer, and accepts any case of it', async () => {
    uber.script.push({
      status: 200,
      body: { access_token: 'token-abcdefgh', token_type: 'MAC', expires_in: 2_592_000 },
    });
    expect(await carrier.quote(market, quote)).toEqual(unavailable);
    uber.script.push({
      status: 200,
      body: { access_token: 'token-abcdefgh', expires_in: 2_592_000 },
    });
    expect(await carrier.quote(market, quote)).toEqual(unavailable);
    uber.script.push({
      status: 200,
      body: { access_token: 'token-abcdefgh', token_type: 'bearer', expires_in: 2_592_000 },
    });
    // Accepted (the fake then renews the token, as it does not know this one).
    expect((await carrier.quote(market, quote)).ok).toBe(true);
  });

  it('quotes with the Market country and the postcode only, and reads the price, ETA and expiry', async () => {
    expect(await carrier.quote(market, quote)).toEqual({
      ok: true,
      value: {
        price: { amount: 1250n, currency: real.defaultCurrency },
        etaMinutes: 25,
        expiresAt: Temporal.Instant.from('2026-10-24T10:15:00Z'),
      },
    });
    expect(uber.api[0]).toMatchObject({ method: 'POST', url: `${API}/delivery_quotes` });
    const body = uber.api[0]!.json;
    expect(Object.keys(body).sort()).toEqual([
      'dropoff_address',
      'manifest_total_value',
      'pickup_address',
    ]);
    expect(body.manifest_total_value).toBe(12_000);
    expect(JSON.parse(body.pickup_address as string)).toEqual({
      street_address: [],
      zip_code: quote.pickup.postcode,
      country,
    });
    expect(JSON.parse(body.dropoff_address as string)).toEqual({
      street_address: [],
      zip_code: quote.dropoff.postcode,
      country,
    });
  });

  it('sends the locality and region of a quote stop as city and state when it has them', async () => {
    const located: CarrierQuoteRequest = {
      ...quote,
      pickup: { ...quote.pickup, locality: 'Sunnybank', region: code === 'AU' ? 'QLD' : null },
    };
    expect((await carrier.quote(market, located)).ok).toBe(true);
    expect(JSON.parse(uber.api[0]!.json.pickup_address as string)).toEqual({
      street_address: [],
      city: 'Sunnybank',
      ...(code === 'AU' ? { state: 'QLD' } : {}),
      zip_code: quote.pickup.postcode,
      country,
    });
  });

  it('gives a null ETA and expiry when Uber gives none or gives garbage, and derives the ETA from dropoff_eta', async () => {
    await warm();
    uber.script.push({
      status: 200,
      body: { fee: 900, currency_type: real.defaultCurrency, expires: 'not-a-date', duration: -3 },
    });
    expect(await carrier.quote(market, quote)).toMatchObject({
      ok: true,
      value: { etaMinutes: null, expiresAt: null },
    });
    uber.script.push({
      status: 200,
      body: {
        fee: 900,
        currency_type: real.defaultCurrency,
        dropoff_eta: T0.add({ minutes: 40 }).toString(),
      },
    });
    expect(
      await carrier.quote(market, elsewhere(code === 'AU' ? '4000' : '1000003')),
    ).toMatchObject({ ok: true, value: { etaMinutes: 40, expiresAt: null } });
  });

  it('keeps a quote for five minutes, so a repeated checkout asks Uber once', async () => {
    expect((await carrier.quote(market, quote)).ok).toBe(true);
    expect((await carrier.quote(market, quote)).ok).toBe(true);
    expect(uber.api).toHaveLength(1);
    clock.advance(Temporal.Duration.from({ milliseconds: QUOTE_CACHE_MS }));
    expect((await carrier.quote(market, quote)).ok).toBe(true);
    expect(uber.api).toHaveLength(2);
  });

  it('never serves a kept quote past its own expiry', async () => {
    uber.quoteExpires = T0.add({ minutes: 2 }).toString();
    expect((await carrier.quote(market, quote)).ok).toBe(true);
    clock.advance(Temporal.Duration.from({ minutes: 1 }));
    expect((await carrier.quote(market, quote)).ok).toBe(true);
    expect(uber.api).toHaveLength(1);
    clock.advance(Temporal.Duration.from({ minutes: 1 }));
    expect((await carrier.quote(market, quote)).ok).toBe(true);
    expect(uber.api).toHaveLength(2);
  });

  it('prices a scheduled quote from the stops alone (no window, no lead time) and refuses a mode the Market does not serve', async () => {
    expect((await carrier.quote(market, { ...quote, mode: 'scheduled' })).ok).toBe(true);
    const body = uber.api[0]!.json;
    expect(Object.keys(body).filter((key) => key.includes('_dt'))).toEqual([]);
    carrier = build({ modes: ['on_demand'] });
    expect(await carrier.quote(market, { ...quote, mode: 'scheduled' })).toEqual(refused);
  });

  it.each([
    ['a decimal fee', { fee: 12.5, currency_type: 'AUD' }],
    ['a text fee', { fee: '1250', currency_type: 'AUD' }],
    ['a negative fee', { fee: -1, currency_type: 'AUD' }],
    ['a zero fee', { fee: 0, currency_type: 'AUD' }],
    ['a huge fee', { fee: 1e30, currency_type: 'AUD' }],
    ['no fee', { currency_type: 'AUD' }],
    ['no currency', { fee: 1250 }],
    ['a long currency', { fee: 1250, currency_type: 'AUDX' }],
    ['a numeric currency', { fee: 1250, currency: 36 }],
    ['an array', [{ fee: 1250, currency_type: 'AUD' }]],
  ])('refuses a quote answer with %s', async (_label, body) => {
    await warm();
    uber.script.push({ status: 200, body });
    expect(await carrier.quote(market, quote)).toEqual(unavailable);
  });

  it('reads a lower-case `currency` when `currency_type` is absent', async () => {
    await warm();
    uber.script.push({
      status: 200,
      body: { fee: 900, currency: real.defaultCurrency.toLowerCase() },
    });
    expect(await carrier.quote(market, quote)).toEqual({
      ok: true,
      value: {
        price: { amount: 900n, currency: real.defaultCurrency },
        etaMinutes: null,
        expiresAt: null,
      },
    });
  });

  it("refuses a quote in a currency other than the Market's, and a zero fee", async () => {
    await warm();
    const foreign = real.defaultCurrency === 'USD' ? 'EUR' : 'USD';
    uber.script.push({ status: 200, body: { fee: 900, currency_type: foreign } });
    expect(await carrier.quote(market, quote)).toEqual(unavailable);
    uber.script.push({ status: 200, body: { fee: 0, currency_type: real.defaultCurrency } });
    expect(await carrier.quote(market, quote)).toEqual(unavailable);
  });

  it('books with external_id, the manifest, names, phones, structured addresses and coordinates', async () => {
    const answer = await carrier.book(market, request);
    expect(answer).toEqual({
      ok: true,
      value: {
        carrierReference: 'del_0000000001',
        carrierStatus: 'PENDING',
        trackingUrl: `https://track.uber.com/${request.externalReference}`,
      },
    });
    const [call] = uber.api;
    expect(call).toMatchObject({ method: 'POST', url: `${API}/deliveries` });
    const place = (postcode: string) => ({
      city: 'Sunnybank',
      ...(code === 'AU' ? { state: 'QLD' } : {}),
      zip_code: postcode,
      country,
    });
    expect(call!.json).toEqual({
      external_id: request.externalReference,
      pickup_name: 'Test Halal Butcher',
      pickup_address: JSON.stringify({
        street_address: ['1 Shop Street'],
        ...place(request.pickup.postcode),
      }),
      pickup_phone_number: '+61730000000',
      dropoff_name: 'Aisha Rahman',
      dropoff_address: JSON.stringify({
        street_address: ['12 Example Street'],
        ...place(request.dropoff.postcode),
      }),
      dropoff_latitude: -27.58,
      dropoff_longitude: 153.06,
      dropoff_phone_number: '+61412345678',
      dropoff_notes: 'Leave at the door',
      manifest_items: [{ name: 'Order', quantity: 2, weight: 5000 }],
      manifest_total_value: 12_000,
    });
  });

  it('gives no tracking link unless it is plain https on an Uber host, and re-serialises it', async () => {
    await warm();
    const rejected = [
      undefined,
      'http://track.uber.com/x',
      'javascript:alert(1)',
      'https://track.example.test/x',
      'https://evil-uber.com/x',
      'https://uber.com.evil.test/x',
      'https://user:pw@track.uber.com/x',
      'https://user@uber.com/x',
      'not a url',
      `https://track.uber.com/${'a'.repeat(600)}`,
    ];
    uber.script.push({
      status: 200,
      body: {
        id: 'del_0000000076',
        status: 'pending',
        external_id: request.externalReference,
        tracking_url: 'https://TRACK.Uber.com/a b',
      },
    });
    expect(await carrier.book(market, request)).toMatchObject({
      ok: true,
      value: { trackingUrl: 'https://track.uber.com/a%20b' },
    });
    uber.script.push({
      status: 200,
      body: {
        id: 'del_0000000075',
        status: 'pending',
        external_id: request.externalReference,
        tracking_url: 'https://uber.com/track/1',
      },
    });
    expect(await carrier.book(market, request)).toMatchObject({
      ok: true,
      value: { trackingUrl: 'https://uber.com/track/1' },
    });
    for (const tracking_url of rejected) {
      uber.script.push({
        status: 200,
        body: {
          id: 'del_0000000077',
          status: 'pending',
          external_id: request.externalReference,
          tracking_url,
        },
      });
      expect(await carrier.book(market, request)).toMatchObject({
        ok: true,
        value: { trackingUrl: null },
      });
    }
  });

  it('books a scheduled trip for the buyer window as the drop-off window, not a lead time', async () => {
    expect((await carrier.book(market, { ...request, mode: 'scheduled', window })).ok).toBe(true);
    const body = uber.api[0]!.json;
    expect(body.dropoff_ready_dt).toBe(window.start.toString());
    expect(body.dropoff_deadline_dt).toBe(window.end.toString());
    expect(body.pickup_ready_dt).toBeUndefined();
    // On demand carries no timing at all, even when a window is passed along.
    uber.seen.length = 0;
    expect((await carrier.book(market, { ...request, externalReference: 'two', window })).ok).toBe(
      true,
    );
    expect(Object.keys(uber.api[0]!.json).filter((key) => key.includes('_dt'))).toEqual([]);
  });

  it('sends exactly one booking request, even on a timeout, a 5xx or a 429', async () => {
    carrier = build({ timeoutMs: 20, maxAttempts: 3, backoffMs: 100 });
    await warm();
    for (const fault of ['hang', 'network', { status: 503 }, { status: 429 }] as const) {
      uber.seen.length = 0;
      uber.script.push(fault);
      expect(await carrier.book(market, request)).toEqual(unavailable);
      expect(uber.api).toHaveLength(1);
    }
    expect(slept).toEqual([]);
    expect(uber.script).toEqual([]);
  });

  it('answers unavailable for a lost answer, with exactly one delivery created', async () => {
    carrier = build({ timeoutMs: 20, maxAttempts: 3 });
    await warm();
    uber.loseNextBookingAnswer = true;
    expect(await carrier.book(market, request)).toEqual(unavailable);
    expect(uber.api).toHaveLength(1);
    expect(uber.deliveries.size).toBe(1);
  });

  it('does not rely on Uber to dedupe: a repeated booking is a second delivery', async () => {
    expect((await carrier.book(market, request)).ok).toBe(true);
    expect((await carrier.book(market, request)).ok).toBe(true);
    expect(uber.deliveries.size).toBe(2);
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
    for (const refusedRequest of cases) {
      expect(await carrier.book(market, refusedRequest)).toEqual(refused);
      // A quote has no window, so the trip without one is the only case it does not refuse.
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
    carrier = build({ modes: ['scheduled'] });
    expect(await carrier.book(market, request)).toEqual(refused);
    expect(uber.seen).toEqual([]);
    // Exactly at the limits it goes through.
    carrier = build();
    const atLimits = over({
      weightGrams: limits.maxItemWeightGrams,
      itemCount: limits.maxItems,
      declaredValue: { amount: BigInt(limits.maxOrderValueMinor), currency: real.defaultCurrency },
    });
    expect((await carrier.book(market, atLimits)).ok).toBe(true);
  });

  it('refuses an answer about another reference, without an id, or with an unknown status', async () => {
    await warm();
    uber.script.push({
      status: 200,
      body: { id: 'del_0000000099', status: 'pending', external_id: 'another-reference' },
    });
    expect(await carrier.book(market, request)).toEqual(unavailable);
    uber.script.push({ status: 200, body: { status: 'pending', external_id: 'x' } });
    expect(await carrier.book(market, request)).toEqual(unavailable);
    uber.script.push({
      status: 200,
      body: { id: 'del_0000000098', status: 'exploded', external_id: request.externalReference },
    });
    expect(await carrier.book(market, request)).toEqual(unavailable);
  });

  it('cancels, reads a status, and refuses a malformed reference without a call', async () => {
    const booked = await carrier.book(market, request);
    const reference = booked.ok ? booked.value.carrierReference : '';
    expect(await carrier.status(market, reference)).toEqual({
      ok: true,
      value: { status: 'pending', carrierStatus: 'PENDING' },
    });
    expect(await carrier.cancel(market, reference)).toEqual({
      ok: true,
      value: { carrierStatus: 'CANCELED' },
    });
    expect(uber.api.at(-1)).toMatchObject({
      method: 'POST',
      url: `${API}/deliveries/${reference}/cancel`,
    });
    const calls = uber.seen.length;
    expect(await carrier.cancel(market, '../../admin')).toEqual(refused);
    expect(await carrier.status(market, 'a/b')).toEqual(refused);
    expect(uber.seen).toHaveLength(calls);
  });

  it.each([
    ['pending', 'PENDING', 'pending'],
    ['pickup', 'PICKUP', 'assigned'],
    ['pickup_complete', 'PICKUP_COMPLETE', 'picked_up'],
    ['dropoff', 'DROPOFF', 'picked_up'],
    ['delivered', 'DELIVERED', 'delivered'],
    ['canceled', 'CANCELED', 'cancelled'],
    ['returned', 'RETURNED', 'returned'],
  ])('maps the Uber status %s to %s and the common status %s', async (status, expected, common) => {
    await warm();
    uber.script.push({ status: 200, body: { id: 'del_0000000001', status } });
    expect(await carrier.status(market, 'del_0000000001')).toEqual({
      ok: true,
      value: { status: common, carrierStatus: expected },
    });
  });

  it('answers unavailable for a status word it does not know', async () => {
    await warm();
    uber.script.push({ status: 200, body: { id: 'del_0000000001', status: 'exploded' } });
    expect(await carrier.status(market, 'del_0000000001')).toEqual(unavailable);
  });

  it('answers unauthorized on a status read and a cancel when Uber rejects the credentials', async () => {
    await warm();
    uber.script.push({ status: 403 });
    expect(await carrier.status(market, 'del_0000000001')).toEqual(unauthorized);
    uber.script.push({ status: 403 });
    expect(await carrier.cancel(market, 'del_0000000001')).toEqual(unauthorized);
  });

  it('never retries a refusal (4xx)', async () => {
    await warm();
    uber.script.push({ status: 422, body: { code: 'address_undeliverable' } });
    expect(await carrier.book(market, request)).toEqual(refused);
    expect(uber.api).toHaveLength(1);
    expect(slept).toEqual([]);
  });

  it('retries a 5xx up to the configured attempts with doubling backoff, then is unavailable', async () => {
    carrier = build({ maxAttempts: 3, backoffMs: 100 });
    await warm();
    for (let n = 0; n < 3; n += 1) uber.script.push({ status: 503 });
    expect(await carrier.quote(market, quote)).toEqual(unavailable);
    expect(uber.api).toHaveLength(3);
    expect(slept).toEqual([100, 200]);
    uber.seen.length = 0;
    uber.script.push({ status: 502 });
    expect((await carrier.quote(market, quote)).ok).toBe(true);
    expect(uber.api).toHaveLength(2);
    // A status read is idempotent by id and retries too.
    uber.seen.length = 0;
    uber.script.push({ status: 502 });
    expect(await carrier.status(market, 'del_0000000001')).toEqual(refused);
    expect(uber.api).toHaveLength(2);
  });

  it('retries a timeout and a network fault, then is unavailable', async () => {
    carrier = build({ timeoutMs: 20, maxAttempts: 2 });
    await warm();
    uber.script.push('hang', 'network');
    expect(await carrier.quote(market, quote)).toEqual(unavailable);
    expect(uber.api).toHaveLength(2);
    uber.script.push('hang');
    expect((await carrier.quote(market, quote)).ok).toBe(true);
  });

  it('retries a 429 on a status read but answers a quote unavailable at once', async () => {
    await warm();
    uber.script.push({ status: 429 }, { status: 429 });
    expect(await carrier.status(market, 'del_0000000001')).toEqual(unavailable);
    expect(uber.api).toHaveLength(2);
    uber.seen.length = 0;
    uber.script.push({ status: 429 });
    const other = elsewhere(code === 'AU' ? '4000' : '1000003');
    expect(await carrier.quote(market, other)).toEqual(unavailable);
    expect(uber.api).toHaveLength(1);
  });

  it('drops an oversized answer, and a body that is not JSON', async () => {
    await warm();
    uber.script.push({
      status: 200,
      body: { fee: 1250, currency_type: 'AUD', padding: 'x'.repeat(MAX_ANSWER_BYTES) },
    });
    const other = elsewhere(code === 'AU' ? '4000' : '1000003');
    expect(await carrier.quote(market, other)).toEqual(unavailable);
    uber.script.push({ status: 200, raw: '<html>not json</html>' });
    expect(await carrier.quote(market, other)).toEqual(unavailable);
  });

  it('opens the circuit per kind of call after the threshold, then lets one trial through', async () => {
    const { failureThreshold, cooldownSeconds } = configured.circuitBreaker;
    carrier = build({ maxAttempts: 1 });
    await warm();
    for (let n = 0; n < failureThreshold; n += 1) uber.script.push({ status: 500 });
    for (let n = 0; n < failureThreshold; n += 1) {
      expect((await carrier.book(market, request)).ok).toBe(false);
    }
    expect(uber.api).toHaveLength(failureThreshold);
    expect(await carrier.book(market, request)).toEqual(unavailable);
    expect(uber.api).toHaveLength(failureThreshold);
    // Quotes have their own circuit.
    const other = elsewhere(code === 'AU' ? '4000' : '1000003');
    expect((await carrier.quote(market, other)).ok).toBe(true);
    clock.advance(Temporal.Duration.from({ seconds: cooldownSeconds }));
    expect((await carrier.book(market, request)).ok).toBe(true);
  });

  it('is not configured, and sends nothing, with the switch off or a credential missing', async () => {
    const config = realMarkets.get(market.marketId).shipping!.uberDirect!;
    // Off as shipped.
    expect(config.enabled).toBe(false);
    const http = new UberDirectHttpClient(new CircuitBreaker(clock), clock, uber.fetch);
    const shippedOff = new UberDirectCarrier(
      new ConfigUberDirectPolicy(realMarkets, CREDENTIALS),
      http,
      clock,
    );
    const notConfigured = { ok: false, error: { code: 'carrier.not-configured' } };
    expect(await shippedOff.book(market, request)).toEqual(notConfigured);
    expect(await shippedOff.quote(market, quote)).toEqual(notConfigured);
    expect(await shippedOff.cancel(market, 'del_0000000001')).toEqual(notConfigured);
    expect(await shippedOff.status(market, 'del_0000000001')).toEqual(notConfigured);
    expect(shippedOff.capabilities(market)).toBeNull();
    // On, but one credential short.
    for (const missing of ['customerIds', 'clientIds', 'clientSecrets'] as const) {
      const short = build({}, { ...CREDENTIALS, [missing]: {} });
      expect(await short.book(market, request)).toEqual(notConfigured);
      expect(short.capabilities(market)).toBeNull();
    }
    expect(uber.seen).toEqual([]);
  });

  it('declares its fleet and capabilities, with the currency of the Market', () => {
    expect(carrier.fleet).toBe('uber_direct');
    expect(carrier.capabilities(market)).toEqual({
      fleet: 'uber_direct',
      methods: ['instant', 'same_day', 'scheduled'],
      serviceAreas: configured.serviceAreas,
      outsideCityAreasOnly: false,
      temperatures: configured.temperatures,
      maxItemWeightGrams: 20_000,
      maxItems: 8,
      maxOrderValue: { amount: 50_000n, currency: real.defaultCurrency },
      prohibitedClasses: ['alcohol', 'tobacco', 'firearms', 'hazardous-materials', 'live-animals'],
      idempotentBooking: false,
      supportsWindow: true,
    });
    const caps = build({
      modes: ['on_demand'],
      serviceAreas: ['elsewhere'],
      temperatures: ['ambient', 'chilled'],
    }).capabilities(market);
    expect(caps).toMatchObject({
      methods: ['instant', 'same_day'],
      serviceAreas: ['elsewhere'],
      temperatures: ['ambient', 'chilled'],
    });
    expect(build({ modes: ['scheduled'] }).capabilities(market)?.methods).toEqual(['scheduled']);
  });

  it('leaks no secret, token or personal data in any failure', async () => {
    const seenText: string[] = [];
    const failures = [
      await (async () => {
        uber.script.push({ status: 401, body: { echo: CLIENT_SECRET } });
        return carrier.book(market, request);
      })(),
      await build({ modes: ['on_demand'] }).quote(market, { ...quote, mode: 'scheduled' }),
      await (async () => {
        uber.script.push({ status: 500 }, { status: 500 });
        return carrier.book(market, request);
      })(),
      await (async () => {
        uber.script.push({ status: 400, body: { message: 'Aisha Rahman 12 Example Street' } });
        return carrier.book(market, request);
      })(),
    ];
    for (const failure of failures) {
      expect(failure.ok).toBe(false);
      seenText.push(JSON.stringify(failure));
    }
    const joined = seenText.join('\n');
    for (const secret of [
      CLIENT_SECRET,
      CLIENT_ID,
      CUSTOMER,
      'Aisha',
      'Example Street',
      'token-',
    ]) {
      expect(joined).not.toContain(secret);
    }
    for (const failure of failures) {
      if (!failure.ok) expect(Object.keys(failure.error)).toEqual(['code']);
    }
  });
});

describe('toFleetStatus (Uber Direct)', () => {
  it.each([
    ['PENDING', 'pending'],
    ['PICKUP', 'assigned'],
    ['PICKUP_COMPLETE', 'picked_up'],
    ['DROPOFF', 'picked_up'],
    ['DELIVERED', 'delivered'],
    ['CANCELED', 'cancelled'],
    ['RETURNED', 'returned'],
    ['pickup_complete', 'picked_up'],
    ['canceled', 'cancelled'],
    ['EXPLODED', null],
    ['', null],
    ['CANCELLED', null],
  ])('maps %s to %s', (raw, expected) => {
    expect(toFleetStatus(raw)).toBe(expected);
  });
});
