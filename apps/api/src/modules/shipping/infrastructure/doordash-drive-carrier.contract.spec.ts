import { createHmac } from 'node:crypto';
import { Temporal } from '@mondapac/shared-kernel';
import { FixedClock, testMarketContext } from '@mondapac/shared-kernel/testing';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import type {
  CarrierBookingRequest,
  CarrierQuoteRequest,
} from '../application/ports/carrier-gateway';
import { CircuitBreaker } from './circuit-breaker';
import {
  ConfigDoorDashDrivePolicy,
  type DoorDashDriveConfig,
  type DoorDashDriveCredentials,
} from './config-doordash-drive-policy';
import {
  DoorDashDriveCarrier,
  QUOTE_CACHE_MS,
  QUOTE_HOLD_MS,
  toFleetStatus,
} from './doordash-drive-carrier';
import {
  DOORDASH_API_URL,
  DoorDashDriveHttpClient,
  JWT_EARLY_REFRESH_MS,
  JWT_LIFETIME_SECONDS,
  type DoorDashFetch,
} from './doordash-drive-http-client';
import { MAX_ANSWER_BYTES } from './drive-http-client';

// The DoorDash Drive adapter of the fleet port against a mocked `fetch` (no network at all), on
// both Market fixtures (AU: AUD, ZZ: JPY). The fake speaks the shape of DoorDash's public Drive
// v2 API: a per-request HS256 JWT it verifies with the test secret, then `quotes`, `deliveries`,
// `deliveries/{id}` and `deliveries/{id}/cancel`, with fees in minor units and a 409 for a
// repeated `external_delivery_id`.

const realMarkets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const T0 = Temporal.Instant.from('2026-10-24T10:00:00Z');
const DEVELOPER = 'dev-test-0001-aaaa';
const KEY_ID = 'key-test-0001-aaaa';
const SECRET_BYTES = Buffer.from('doordash-test-signing-secret-bytes-0123456789');
const SIGNING_SECRET = SECRET_BYTES.toString('base64url');
const CREDENTIALS: DoorDashDriveCredentials = {
  developerIds: { AU: DEVELOPER, ZZ: DEVELOPER },
  keyIds: { AU: KEY_ID, ZZ: KEY_ID },
  signingSecrets: { AU: SIGNING_SECRET, ZZ: SIGNING_SECRET },
};
const API = `${DOORDASH_API_URL}/drive/v2`;

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

const decode = (part: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;

/** A fake DoorDash: scripted answers first, then the real behaviour, through an injected fetch. */
class FakeDoorDash {
  readonly seen: Seen[] = [];
  readonly script: Scripted[] = [];
  readonly deliveries = new Map<string, Record<string, unknown>>();
  quoteCurrency = 'AUD';
  /** When set, the next created delivery is created but its answer never arrives (a timeout). */
  loseNextBookingAnswer = false;

  readonly fetch: DoorDashFetch = async (url, init) => {
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
    const send = (status: number, answer: unknown, raw?: string) => ({
      status,
      body: streamOf(raw ?? JSON.stringify(answer)),
    });
    if (next !== undefined) return send(next.status, next.body ?? { error: 'scripted' }, next.raw);
    if (!this.signed(init.headers.authorization)) return send(401, { code: 'unauthorized' });
    const path = url.slice(API.length);
    if (init.method === 'POST' && path === '/quotes') {
      return send(200, {
        external_delivery_id: json.external_delivery_id,
        delivery_status: 'quote',
        fee: 1250,
        currency: this.quoteCurrency,
        pickup_time_estimated: '2026-10-24T10:10:00Z',
        dropoff_time_estimated: '2026-10-24T10:35:00Z',
        dropoff_address: 'echoed address of a person',
      });
    }
    if (init.method === 'POST' && path === '/deliveries') {
      const id = String(json.external_delivery_id);
      if (this.deliveries.has(id)) return send(409, { code: 'duplicate_delivery_id' });
      const delivery = {
        external_delivery_id: id,
        delivery_status: 'created',
        tracking_url: `https://track.doordash.com/${id}`,
        // DoorDash echoes the stops: the adapter must not read them.
        dropoff_contact_given_name: json.dropoff_contact_given_name,
        dropoff_phone_number: json.dropoff_phone_number,
      };
      this.deliveries.set(id, delivery);
      if (this.loseNextBookingAnswer) {
        this.loseNextBookingAnswer = false;
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')));
        });
      }
      return send(200, delivery);
    }
    const cancel = /^\/deliveries\/([A-Za-z0-9_-]+)\/cancel$/.exec(path);
    if (init.method === 'PUT' && cancel !== null) {
      const delivery = this.deliveries.get(cancel[1]!);
      if (delivery === undefined) return send(404, { code: 'not_found' });
      delivery.delivery_status = 'cancelled';
      return send(200, delivery);
    }
    const one = /^\/deliveries\/([A-Za-z0-9_-]+)$/.exec(path);
    if (init.method === 'GET' && one !== null) {
      const delivery = this.deliveries.get(one[1]!);
      return delivery === undefined ? send(404, {}) : send(200, delivery);
    }
    return send(404, { code: 'route' });
  };

  /** Whether the bearer token is a JWT signed with the test secret. */
  private signed(authorization: string | undefined): boolean {
    const jwt = authorization?.startsWith('Bearer ') === true ? authorization.slice(7) : '';
    const [header, claims, signature] = jwt.split('.');
    if (header === undefined || claims === undefined || signature === undefined) return false;
    const expected = createHmac('sha256', SECRET_BYTES)
      .update(`${header}.${claims}`)
      .digest('base64url');
    return signature === expected;
  }
}

/** The Market registry with DoorDash Drive switched on (and any override) for every Market. */
const registryWith = (override: Partial<DoorDashDriveConfig> = {}): MarketRegistry =>
  ({
    get: (id: string) => {
      const real = realMarkets.get(id as never);
      return {
        ...real,
        shipping: {
          ...real.shipping,
          doordashDrive: { ...real.shipping!.doordashDrive!, enabled: true, ...override },
        },
      };
    },
  }) as unknown as MarketRegistry;

describe.each([['AU'], ['ZZ']] as const)('DoorDashDriveCarrier in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const real = realMarkets.get(market.marketId);
  const country = real.customers!.address.countryCode;
  const configured = real.shipping!.doordashDrive!;
  const dd = new FakeDoorDash();
  let clock: FixedClock;
  let slept: number[];

  const build = (override: Partial<DoorDashDriveConfig> = {}, credentials = CREDENTIALS) => {
    const http = new DoorDashDriveHttpClient(new CircuitBreaker(clock), clock, dd.fetch, (ms) => {
      slept.push(ms);
      return Promise.resolve();
    });
    return new DoorDashDriveCarrier(
      new ConfigDoorDashDrivePolicy(registryWith(override), credentials),
      http,
      clock,
    );
  };
  let carrier: DoorDashDriveCarrier;

  const ID = '01990000-0000-7000-8000-0000000000a1';
  const request: CarrierBookingRequest = {
    externalReference: ID,
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
    method: 'instant',
    mode: 'on_demand',
    window: null,
  };
  const quote: CarrierQuoteRequest = {
    pickup: { postcode: request.pickup.postcode, locality: null, region: null },
    dropoff: { postcode: request.dropoff.postcode, locality: null, region: null },
    parcel: request.parcel,
    method: 'instant',
    mode: 'on_demand',
  };
  const elsewhere = (postcode: string): CarrierQuoteRequest => ({
    ...quote,
    dropoff: { postcode, locality: null, region: null },
  });
  const window = { start: T0.add({ hours: 2 }), end: T0.add({ hours: 3 }) };
  const unavailable = { ok: false, error: { code: 'carrier.unavailable' } };
  const notSent = { ok: false, error: { code: 'carrier.not-sent' } };
  const refused = { ok: false, error: { code: 'carrier.refused' } };
  const unauthorized = { ok: false, error: { code: 'carrier.unauthorized' } };

  beforeEach(() => {
    dd.seen.length = 0;
    dd.script.length = 0;
    dd.deliveries.clear();
    dd.quoteCurrency = real.defaultCurrency;
    dd.loseNextBookingAnswer = false;
    clock = new FixedClock(T0);
    slept = [];
    carrier = build();
  });

  it('signs every call with an HS256 JWT: header, claims, signature and a lifetime within 1800 s', async () => {
    expect((await carrier.quote(market, quote)).ok).toBe(true);
    const authorization = dd.seen[0]!.headers.authorization!;
    expect(authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    const [header, claims, signature] = authorization.slice(7).split('.') as [
      string,
      string,
      string,
    ];
    expect(decode(header)).toEqual({ alg: 'HS256', typ: 'JWT', 'dd-ver': 'DD-JWT-V1' });
    const iat = T0.epochMilliseconds / 1000;
    expect(decode(claims)).toEqual({
      aud: 'doordash',
      iss: DEVELOPER,
      kid: KEY_ID,
      iat,
      exp: iat + JWT_LIFETIME_SECONDS,
    });
    expect(JWT_LIFETIME_SECONDS).toBeLessThanOrEqual(1800);
    // Verifiable with the base64url-decoded secret (and not with the undecoded text).
    const sign = (key: Buffer) =>
      createHmac('sha256', key).update(`${header}.${claims}`).digest('base64url');
    expect(signature).toBe(sign(SECRET_BYTES));
    expect(signature).not.toBe(sign(Buffer.from(SIGNING_SECRET)));
    expect(dd.seen[0]!.url.startsWith(`${DOORDASH_API_URL}/drive/v2/`)).toBe(true);
  });

  it('keeps the JWT until a minute before it expires, then signs a new one from the clock', async () => {
    const bearers = () => dd.seen.map((call) => call.headers.authorization);
    expect((await carrier.status(market, ID)).ok).toBe(false);
    clock.advance(
      Temporal.Duration.from({
        milliseconds: JWT_LIFETIME_SECONDS * 1000 - JWT_EARLY_REFRESH_MS - 1,
      }),
    );
    await carrier.status(market, ID);
    expect(new Set(bearers()).size).toBe(1);
    clock.advance(Temporal.Duration.from({ milliseconds: 1 }));
    await carrier.status(market, ID);
    expect(new Set(bearers()).size).toBe(2);
    const claims = decode(bearers().at(-1)!.slice(7).split('.')[1]!);
    expect(claims.iat).toBe(clock.now().epochMilliseconds / 1000);
  });

  it('quotes with the Market country and the postcode only, and reads the fee, ETA and a five-minute hold', async () => {
    const result = await carrier.quote(market, quote);
    expect(result).toEqual({
      ok: true,
      value: {
        price: { amount: 1250n, currency: real.defaultCurrency },
        etaMinutes: 35,
        expiresAt: T0.add({ milliseconds: QUOTE_HOLD_MS }),
      },
    });
    expect(QUOTE_HOLD_MS).toBeLessThanOrEqual(300_000);
    const call = dd.seen[0]!;
    expect(call).toMatchObject({ method: 'POST', url: `${API}/quotes` });
    expect(call.json.external_delivery_id).toMatch(/^quote-[0-9a-f-]{36}$/);
    expect(call.json.pickup_address).toBe(`${quote.pickup.postcode}, ${country}`);
    expect(call.json.order_value).toBe(12_000);
    expect(call.json.currency).toBe(real.defaultCurrency);
    expect(call.body).not.toContain('Aisha');
    expect(call.body).not.toContain('Example Street');
  });

  it('sends the locality and region of a quote stop when it has them', async () => {
    await carrier.quote(market, {
      ...quote,
      pickup: { postcode: '4109', locality: 'Sunnybank', region: 'QLD' },
    });
    expect(dd.seen[0]!.json.pickup_address).toBe(`Sunnybank QLD 4109, ${country}`);
  });

  it('keeps a quote for four minutes, so a repeated checkout asks DoorDash once, and never past its hold', async () => {
    expect((await carrier.quote(market, quote)).ok).toBe(true);
    expect((await carrier.quote(market, quote)).ok).toBe(true);
    expect(dd.seen).toHaveLength(1);
    clock.advance(Temporal.Duration.from({ milliseconds: QUOTE_CACHE_MS }));
    expect((await carrier.quote(market, quote)).ok).toBe(true);
    expect(dd.seen).toHaveLength(2);
    expect(QUOTE_CACHE_MS).toBeLessThan(QUOTE_HOLD_MS);
  });

  it("refuses a quote in a currency other than the Market's, a zero fee, and a quote with no fee", async () => {
    dd.quoteCurrency = real.defaultCurrency === 'USD' ? 'EUR' : 'USD';
    expect(await carrier.quote(market, quote)).toEqual(unavailable);
    dd.quoteCurrency = real.defaultCurrency;
    dd.script.push({ status: 200, body: { fee: 0, currency: real.defaultCurrency } });
    expect(await carrier.quote(market, elsewhere('9999'))).toEqual(unavailable);
    dd.script.push({ status: 200, body: { currency: real.defaultCurrency } });
    expect(await carrier.quote(market, elsewhere('9998'))).toEqual(unavailable);
  });

  it('books with external_delivery_id, one-line addresses, phones, value and currency, and reads back the id, status and link', async () => {
    const result = await carrier.book(market, request);
    expect(result).toEqual({
      ok: true,
      value: {
        carrierReference: ID,
        carrierStatus: 'CREATED',
        trackingUrl: `https://track.doordash.com/${ID}`,
      },
    });
    const call = dd.seen[0]!;
    expect(call).toMatchObject({ method: 'POST', url: `${API}/deliveries` });
    expect(call.headers['content-type']).toBe('application/json');
    expect(call.json).toEqual({
      external_delivery_id: ID,
      pickup_address: `1 Shop Street, Sunnybank${code === 'AU' ? ' QLD' : ''} ${request.pickup.postcode}, ${country}`,
      pickup_business_name: 'Test Halal Butcher',
      pickup_phone_number: '+61730000000',
      dropoff_address: `12 Example Street, Sunnybank${code === 'AU' ? ' QLD' : ''} ${request.dropoff.postcode}, ${country}`,
      dropoff_contact_given_name: 'Aisha Rahman',
      dropoff_phone_number: '+61412345678',
      dropoff_instructions: 'Leave at the door',
      order_value: 12_000,
      currency: real.defaultCurrency,
      items: [{ name: 'Order', quantity: 2 }],
    });
  });

  it('books a scheduled trip for the start of the buyer window, and needs the window', async () => {
    const scheduled = { ...request, method: 'scheduled', mode: 'scheduled' } as const;
    expect(await carrier.book(market, { ...scheduled, window })).toMatchObject({ ok: true });
    expect(dd.seen[0]!.json.dropoff_time).toBe(window.start.toString());
    dd.seen.length = 0;
    expect(await carrier.book(market, { ...scheduled, window: null })).toEqual(refused);
    expect(dd.seen).toEqual([]);
    // Same day is on demand: no time is sent.
    dd.deliveries.clear();
    await carrier.book(market, { ...request, method: 'same_day' });
    expect(dd.seen[0]!.json).not.toHaveProperty('dropoff_time');
  });

  it('is idempotent: a 409 on create means already booked, and the delivery is read back with a GET', async () => {
    expect((await carrier.book(market, request)).ok).toBe(true);
    dd.seen.length = 0;
    expect(await carrier.book(market, request)).toEqual({
      ok: true,
      value: {
        carrierReference: ID,
        carrierStatus: 'CREATED',
        trackingUrl: `https://track.doordash.com/${ID}`,
      },
    });
    expect(dd.seen.map((call) => `${call.method} ${call.url.slice(API.length)}`)).toEqual([
      'POST /deliveries',
      `GET /deliveries/${ID}`,
    ]);
    expect(dd.deliveries.size).toBe(1);
    expect(carrier.capabilities(market)?.idempotentBooking).toBe(true);
  });

  it('retries a booking whose answer was lost, and finds the first delivery instead of a second', async () => {
    carrier = build({ timeoutMs: 20, maxAttempts: 2, backoffMs: 50 });
    dd.loseNextBookingAnswer = true;
    const result = await carrier.book(market, request);
    expect(result).toMatchObject({ ok: true, value: { carrierReference: ID } });
    expect(dd.deliveries.size).toBe(1);
    // One create (lost), one backoff, one create answered 409, one GET.
    expect(slept).toEqual([50]);
    expect(dd.seen.map((call) => call.method)).toEqual(['POST', 'POST', 'GET']);
  });

  it('refuses a duplicate that DoorDash holds as cancelled, so the router tries another fleet', async () => {
    expect((await carrier.book(market, request)).ok).toBe(true);
    expect((await carrier.cancel(market, ID)).ok).toBe(true);
    expect(await carrier.book(market, request)).toEqual(refused);
  });

  it('gives no tracking link unless it is plain https on a DoorDash host', async () => {
    const links: [string, string | null][] = [
      ['https://track.doordash.com/x', 'https://track.doordash.com/x'],
      ['https://doordash.com/t', 'https://doordash.com/t'],
      ['http://track.doordash.com/x', null],
      ['https://evildoordash.com/x', null],
      ['https://doordash.com.evil.test/x', null],
      ['https://user:pw@track.doordash.com/x', null],
      ['javascript:alert(1)', null],
    ];
    for (const [link, expected] of links) {
      dd.script.push({
        status: 200,
        body: { external_delivery_id: ID, delivery_status: 'created', tracking_url: link },
      });
      const booked = await carrier.book(market, request);
      expect(booked.ok && booked.value.trackingUrl).toBe(expected);
    }
  });

  it('refuses, without a call, a parcel beyond the limits, a mode or temperature not served, or a bad reference', async () => {
    const heavy = { ...request.parcel, weightGrams: configured.limits.maxItemWeightGrams + 1 };
    const pricey = {
      ...request.parcel,
      declaredValue: {
        amount: BigInt(configured.limits.maxOrderValueMinor) + 1n,
        currency: real.defaultCurrency,
      },
    };
    const otherCurrency = {
      ...request.parcel,
      declaredValue: { amount: 1n, currency: real.defaultCurrency === 'USD' ? 'EUR' : 'USD' },
    };
    const frozen = { ...request.parcel, temperature: 'frozen' as const };
    for (const parcel of [heavy, pricey, otherCurrency, frozen]) {
      expect(await carrier.book(market, { ...request, parcel })).toEqual(refused);
      expect(await carrier.quote(market, { ...quote, parcel })).toEqual(refused);
    }
    const onDemandOnly = build({ modes: ['on_demand'] });
    expect(
      await onDemandOnly.book(market, {
        ...request,
        method: 'scheduled',
        mode: 'scheduled',
        window,
      }),
    ).toEqual(refused);
    expect(await carrier.book(market, { ...request, externalReference: '../x' })).toEqual(refused);
    expect(await carrier.cancel(market, '../../admin')).toEqual(refused);
    expect(await carrier.status(market, 'a/b')).toEqual(refused);
    expect(dd.seen).toEqual([]);
  });

  it('refuses an answer about another delivery, without an id, or in an unknown or quote state', async () => {
    for (const body of [
      { external_delivery_id: 'someone-else-1', delivery_status: 'created' },
      { delivery_status: 'created' },
      { external_delivery_id: ID, delivery_status: 'exploded' },
      { external_delivery_id: ID, delivery_status: 'quote' },
      null,
    ]) {
      dd.script.push({ status: 200, body });
      expect(await carrier.book(market, request)).toEqual(unavailable);
    }
  });

  it('cancels with PUT, reads a status with GET', async () => {
    expect((await carrier.book(market, request)).ok).toBe(true);
    expect(await carrier.status(market, ID)).toEqual({
      ok: true,
      value: { status: 'pending', carrierStatus: 'CREATED' },
    });
    expect(dd.seen.at(-1)).toMatchObject({ method: 'GET', url: `${API}/deliveries/${ID}` });
    expect(await carrier.cancel(market, ID)).toEqual({
      ok: true,
      value: { carrierStatus: 'CANCELLED' },
    });
    expect(dd.seen.at(-1)).toMatchObject({ method: 'PUT', url: `${API}/deliveries/${ID}/cancel` });
    expect(await carrier.status(market, ID)).toEqual({
      ok: true,
      value: { status: 'cancelled', carrierStatus: 'CANCELLED' },
    });
  });

  it.each([
    ['created', 'CREATED', 'pending'],
    ['confirmed', 'CONFIRMED', 'assigned'],
    ['enroute_to_pickup', 'ENROUTE_TO_PICKUP', 'assigned'],
    ['arrived_at_pickup', 'ARRIVED_AT_PICKUP', 'assigned'],
    ['picked_up', 'PICKED_UP', 'picked_up'],
    ['enroute_to_dropoff', 'ENROUTE_TO_DROPOFF', 'picked_up'],
    ['arrived_at_dropoff', 'ARRIVED_AT_DROPOFF', 'picked_up'],
    ['delivered', 'DELIVERED', 'delivered'],
    ['enroute_to_return', 'ENROUTE_TO_RETURN', 'picked_up'],
    ['returned', 'RETURNED', 'returned'],
    ['cancelled', 'CANCELLED', 'cancelled'],
  ])(
    'maps the DoorDash status %s to %s and the common status %s',
    async (status, expected, common) => {
      dd.script.push({ status: 200, body: { external_delivery_id: ID, delivery_status: status } });
      expect(await carrier.status(market, ID)).toEqual({
        ok: true,
        value: { status: common, carrierStatus: expected },
      });
    },
  );

  it('answers unavailable for a status word it does not know, and for a quote', async () => {
    for (const delivery_status of ['exploded', 'quote']) {
      dd.script.push({ status: 200, body: { external_delivery_id: ID, delivery_status } });
      expect(await carrier.status(market, ID)).toEqual(unavailable);
    }
  });

  it('maps 401 and 403 to unauthorized once, with no retry and no effect on the circuit', async () => {
    carrier = build({ maxAttempts: 3 });
    const { failureThreshold } = configured.circuitBreaker;
    for (let n = 0; n < failureThreshold + 2; n += 1) {
      dd.script.push({ status: n % 2 === 0 ? 401 : 403, body: { echo: SIGNING_SECRET } });
      expect(await carrier.book(market, request)).toEqual(unauthorized);
    }
    expect(dd.seen).toHaveLength(failureThreshold + 2);
    expect(slept).toEqual([]);
    dd.script.push({ status: 403 });
    expect(await carrier.status(market, ID)).toEqual(unauthorized);
    dd.script.push({ status: 401 });
    expect(await carrier.cancel(market, ID)).toEqual(unauthorized);
    // A wrong secret is a 401 from the fake itself.
    const wrong = build(
      {},
      {
        ...CREDENTIALS,
        signingSecrets: { AU: 'AAAAAAAAAAAAAAAAAAAAAAAA', ZZ: 'AAAAAAAAAAAAAAAAAAAAAAAA' },
      },
    );
    expect(await wrong.status(market, ID)).toEqual(unauthorized);
  });

  it.each([400, 404, 422])('maps a %s to a refusal and never retries it', async (status) => {
    dd.script.push({ status, body: { code: 'address_undeliverable' } });
    expect(await carrier.book(market, request)).toEqual(refused);
    expect(dd.seen).toHaveLength(1);
    expect(slept).toEqual([]);
  });

  it('retries a 5xx up to the configured attempts with doubling backoff, then is unavailable', async () => {
    carrier = build({ maxAttempts: 3, backoffMs: 100 });
    for (let n = 0; n < 3; n += 1) dd.script.push({ status: 503 });
    expect(await carrier.quote(market, quote)).toEqual(unavailable);
    expect(dd.seen).toHaveLength(3);
    expect(slept).toEqual([100, 200]);
    dd.seen.length = 0;
    dd.script.push({ status: 502 });
    expect((await carrier.quote(market, elsewhere('9999'))).ok).toBe(true);
    expect(dd.seen).toHaveLength(2);
  });

  it('retries a timeout and a network fault, then is unavailable', async () => {
    carrier = build({ timeoutMs: 20, maxAttempts: 2 });
    dd.script.push('hang', 'network');
    expect(await carrier.quote(market, quote)).toEqual(unavailable);
    expect(dd.seen).toHaveLength(2);
    dd.script.push('hang');
    expect((await carrier.quote(market, quote)).ok).toBe(true);
  });

  it('retries a 429 on a status read but answers a quote unavailable at once', async () => {
    dd.script.push({ status: 429 });
    expect(await carrier.quote(market, quote)).toEqual(unavailable);
    expect(dd.seen).toHaveLength(1);
    dd.seen.length = 0;
    dd.script.push({ status: 429 });
    expect(await carrier.status(market, ID)).toEqual(refused);
    expect(dd.seen).toHaveLength(2);
  });

  it('drops an oversized answer, and a body that is not JSON', async () => {
    dd.script.push({ status: 200, raw: `{"x":"${'a'.repeat(MAX_ANSWER_BYTES)}"}` });
    expect(await carrier.book(market, request)).toEqual(unavailable);
    dd.script.push({ status: 200, raw: '<html>not json</html>' });
    expect(await carrier.book(market, request)).toEqual(unavailable);
  });

  it('opens the circuit per kind of call after the threshold, then lets one trial through', async () => {
    const { failureThreshold, cooldownSeconds } = configured.circuitBreaker;
    carrier = build({ maxAttempts: 1 });
    for (let n = 0; n < failureThreshold; n += 1) dd.script.push({ status: 500 });
    for (let n = 0; n < failureThreshold; n += 1) {
      expect((await carrier.book(market, request)).ok).toBe(false);
    }
    expect(dd.seen).toHaveLength(failureThreshold);
    expect(await carrier.book(market, request)).toEqual(notSent);
    expect(dd.seen).toHaveLength(failureThreshold);
    // Quotes have their own circuit.
    expect((await carrier.quote(market, quote)).ok).toBe(true);
    clock.advance(Temporal.Duration.from({ seconds: cooldownSeconds }));
    expect((await carrier.book(market, request)).ok).toBe(true);
  });

  it('is not configured, and sends nothing, with the switch off or a credential missing', async () => {
    // Off as shipped.
    expect(configured.enabled).toBe(false);
    const http = new DoorDashDriveHttpClient(new CircuitBreaker(clock), clock, dd.fetch);
    const shippedOff = new DoorDashDriveCarrier(
      new ConfigDoorDashDrivePolicy(realMarkets, CREDENTIALS),
      http,
      clock,
    );
    const notConfigured = { ok: false, error: { code: 'carrier.not-configured' } };
    expect(await shippedOff.book(market, request)).toEqual(notConfigured);
    expect(await shippedOff.quote(market, quote)).toEqual(notConfigured);
    expect(await shippedOff.cancel(market, ID)).toEqual(notConfigured);
    expect(await shippedOff.status(market, ID)).toEqual(notConfigured);
    expect(shippedOff.capabilities(market)).toBeNull();
    // On, but one credential short.
    for (const missing of ['developerIds', 'keyIds', 'signingSecrets'] as const) {
      const short = build({}, { ...CREDENTIALS, [missing]: {} });
      expect(await short.book(market, request)).toEqual(notConfigured);
      expect(short.capabilities(market)).toBeNull();
    }
    expect(dd.seen).toEqual([]);
  });

  it('declares its fleet and capabilities, with the currency of the Market', () => {
    expect(carrier.fleet).toBe('doordash_drive');
    expect(carrier.capabilities(market)).toEqual({
      fleet: 'doordash_drive',
      methods: ['instant', 'same_day', 'scheduled'],
      serviceAreas: configured.serviceAreas,
      outsideCityAreasOnly: false,
      temperatures: configured.temperatures,
      maxItemWeightGrams: 20_000,
      maxItems: 8,
      maxOrderValue: { amount: 50_000n, currency: real.defaultCurrency },
      prohibitedClasses: ['alcohol', 'tobacco', 'firearms', 'hazardous-materials', 'live-animals'],
      idempotentBooking: true,
      supportsWindow: true,
    });
    expect(build({ modes: ['on_demand'] }).capabilities(market)?.methods).toEqual([
      'instant',
      'same_day',
    ]);
    expect(build({ modes: ['scheduled'] }).capabilities(market)?.methods).toEqual(['scheduled']);
  });

  it('leaks no secret, JWT or personal data in any failure', async () => {
    const failures = [
      await (async () => {
        dd.script.push({ status: 401, body: { echo: SIGNING_SECRET } });
        return carrier.book(market, request);
      })(),
      await build({ modes: ['on_demand'] }).quote(market, {
        ...quote,
        method: 'scheduled',
        mode: 'scheduled',
      }),
      await (async () => {
        dd.script.push({ status: 500 }, { status: 500 });
        return carrier.book(market, request);
      })(),
      await (async () => {
        dd.script.push({ status: 400, body: { message: 'Aisha Rahman 12 Example Street' } });
        return carrier.book(market, request);
      })(),
    ];
    for (const failure of failures) {
      expect(failure.ok).toBe(false);
      if (!failure.ok) expect(Object.keys(failure.error)).toEqual(['code']);
    }
    const joined = failures.map((failure) => JSON.stringify(failure)).join('\n');
    for (const secret of [SIGNING_SECRET, KEY_ID, DEVELOPER, 'Aisha', 'Example Street', 'Bearer']) {
      expect(joined).not.toContain(secret);
    }
  });
});

describe('toFleetStatus (DoorDash Drive)', () => {
  it('maps every status word, in any case, and returns null for a word it does not know', () => {
    expect(toFleetStatus('created')).toBe('pending');
    expect(toFleetStatus('ENROUTE_TO_DROPOFF')).toBe('picked_up');
    expect(toFleetStatus('RETURNED')).toBe('returned');
    expect(toFleetStatus('exploded')).toBeNull();
    expect(toFleetStatus('QUOTE')).toBeNull();
  });
});
