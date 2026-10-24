import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Temporal } from '@mondapac/shared-kernel';
import type { MarketId } from '@mondapac/shared-kernel';
import { FixedClock, testMarketContext } from '@mondapac/shared-kernel/testing';
import {
  TEST_MARKET_CONFIG_DIRS,
  TEST_MARKET_IDS,
  TEST_SERVICE_AREA_CONFIG_DIRS,
} from '../../../../test/support/test-config';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { loadServiceAreas } from '../../../platform/market-config/service-area-config';
import type { CarrierBookingRequest } from '../application/ports/carrier-gateway';
import { CircuitBreaker } from './circuit-breaker';
import { ConfigCarrierPolicy, type RealTimeCarrierConfig } from './config-carrier-policy';
import { DriveHttpClient } from './drive-http-client';
import {
  DRIVE_SIGNATURE_TOLERANCE_SECONDS,
  DriveWebhookSignature,
} from './drive-webhook-signature';
import { MondapacDriveCarrier } from './mondapac-drive-carrier';

// The Mondapac Drive adapter against a fake Drive server on loopback, on both Market fixtures
// (AU: Mondapac Drive on demand; ZZ: "Zed Courier", chilled and scheduled). The fake speaks
// Drive's contract (handoff 09; Drive's delivery API and docs/notifications/webhooks.md): it books
// once per merchant and `externalReference` (201, then 200 with the same delivery), cancels with
// the `cancelled` event, and checks the bearer key and `x-market-id` of every call.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const areas = loadServiceAreas(TEST_SERVICE_AREA_CONFIG_DIRS, TEST_MARKET_IDS);
const T0 = Temporal.Instant.from('2026-10-24T10:00:00Z');
const KEY = 'drive_test_key_0123456789abcdef';
const SECRET = 'drive-test-webhook-secret-0123456789abc';

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingMessage['headers'];
  readonly body: Record<string, unknown>;
}

/** What the fake answers next, in order; when empty it behaves as Drive does. */
type Scripted = { readonly status: number; readonly body?: unknown } | 'hang';

class FakeDrive {
  readonly seen: Seen[] = [];
  readonly script: Scripted[] = [];
  readonly deliveries = new Map<
    string,
    { id: string; status: string; externalReference: string }
  >();
  #server: Server | null = null;
  #counter = 0;

  get url(): string {
    const address = this.#server!.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  }

  async start(): Promise<void> {
    this.#server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.#server!.listen(0, '127.0.0.1', resolve));
  }

  async stop(): Promise<void> {
    this.#server?.closeAllConnections();
    await new Promise<void>((resolve) => this.#server!.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<
      string,
      unknown
    >;
    this.seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
    const next = this.script.shift();
    if (next === 'hang') return;
    const send = (status: number, answer: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer));
    };
    if (next !== undefined) return send(next.status, next.body ?? { error: 'scripted' });
    if (req.headers.authorization !== `Bearer ${KEY}`) return send(401, { error: 'auth' });
    const market = req.headers['x-market-id'];
    if (req.method === 'POST' && req.url === '/delivery/deliveries') {
      const key = `${String(market)}|${String(body.merchantId)}|${String(body.externalReference)}`;
      const existing = this.deliveries.get(key);
      if (existing !== undefined) return send(200, existing);
      this.#counter += 1;
      const delivery = {
        id: `01990000-0000-7000-8000-${this.#counter.toString(16).padStart(12, '0')}`,
        status: 'SCHEDULED',
        externalReference: String(body.externalReference),
        // Drive echoes the stops: the adapter must not read them.
        pickup: body.pickup,
        dropoff: body.dropoff,
      };
      this.deliveries.set(key, delivery);
      return send(201, delivery);
    }
    const cancel = /^\/delivery\/deliveries\/([0-9a-f-]{36})\/events$/.exec(req.url ?? '');
    if (req.method === 'POST' && cancel !== null && body.type === 'cancelled') {
      const delivery = [...this.deliveries.values()].find((d) => d.id === cancel[1]);
      if (delivery === undefined) return send(404, { error: 'not found' });
      if (delivery.status === 'PICKED_UP') return send(409, { error: 'too late' });
      delivery.status = 'CANCELLED';
      return send(200, delivery);
    }
    send(404, { error: 'route' });
  }
}

/** The fixture's settings with the fake's URL (and any override) in place of the configured. */
class LocalDrivePolicy extends ConfigCarrierPolicy {
  constructor(
    private readonly baseUrl: () => string,
    private readonly override: Partial<RealTimeCarrierConfig> = {},
    secrets: {
      readonly apiKeys: Readonly<Record<string, string>>;
      readonly webhookSecrets: Readonly<Record<string, string>>;
    } = { apiKeys: { AU: KEY, ZZ: KEY }, webhookSecrets: { AU: SECRET, ZZ: SECRET } },
  ) {
    super(markets, areas, secrets);
  }
  override config(marketId: MarketId): RealTimeCarrierConfig | null {
    const settings = super.config(marketId);
    return settings === null ? null : { ...settings, baseUrl: this.baseUrl(), ...this.override };
  }
}

describe.each([['AU'], ['ZZ']] as const)('MondapacDriveCarrier in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const configured = markets.get(market.marketId).shipping!.realTimeCarrier!;
  const drive = new FakeDrive();
  let clock: FixedClock;
  let slept: number[];
  let carrier: MondapacDriveCarrier;

  const build = (override: Partial<RealTimeCarrierConfig> = {}) => {
    const policy = new LocalDrivePolicy(() => drive.url, override);
    const http = new DriveHttpClient(new CircuitBreaker(clock), undefined, (ms) => {
      slept.push(ms);
      return Promise.resolve();
    });
    return new MondapacDriveCarrier(policy, { AU: KEY, ZZ: KEY }, http);
  };

  const request: CarrierBookingRequest = {
    externalReference: '01990000-0000-7000-8000-0000000000a1',
    pickup: {
      contactName: 'Test Halal Butcher',
      contactPhone: '+61 7 3000 0000',
      addressLines: ['1 Shop Street', 'Sunnybank'],
      postcode: code === 'AU' ? '4109' : '1000001',
      notes: null,
    },
    dropoff: {
      contactName: 'Aisha Rahman',
      contactPhone: '0412345678',
      addressLines: ['12 Example Street', 'Sunnybank', 'QLD'],
      postcode: code === 'AU' ? '4109' : '1000002',
      notes: 'Leave at the door',
    },
    parcel: configured.parcel,
    mode: configured.mode,
  };

  beforeAll(() => drive.start());
  afterAll(() => drive.stop());
  beforeEach(() => {
    drive.seen.length = 0;
    drive.script.length = 0;
    drive.deliveries.clear();
    clock = new FixedClock(T0);
    slept = [];
    carrier = build();
  });

  it('books with the Market merchant, key and settings, without coordinates', async () => {
    const answer = await carrier.book(market, request);
    expect(answer).toEqual({
      ok: true,
      value: {
        carrierReference: expect.stringMatching(/^01990000-/) as unknown,
        carrierStatus: 'SCHEDULED',
      },
    });
    expect(drive.seen).toHaveLength(1);
    const [call] = drive.seen;
    expect(call!.headers).toMatchObject({
      authorization: `Bearer ${KEY}`,
      'x-market-id': code,
      'content-type': 'application/json',
    });
    expect(call!.body).toEqual({
      merchantId: configured.merchantId,
      externalReference: request.externalReference,
      pickup: {
        address: '1 Shop Street, Sunnybank',
        postcode: request.pickup.postcode,
        contactName: 'Test Halal Butcher',
        contactPhone: '+61 7 3000 0000',
      },
      dropoff: {
        address: '12 Example Street, Sunnybank, QLD',
        postcode: request.dropoff.postcode,
        contactName: 'Aisha Rahman',
        contactPhone: '0412345678',
        notes: 'Leave at the door',
      },
      parcel: configured.parcel,
      mode: configured.mode,
    });
  });

  it('books once per reference: a repeat answers the first delivery', async () => {
    const first = await carrier.book(market, request);
    const again = await carrier.book(market, request);
    expect(again).toEqual(first);
    expect(drive.deliveries.size).toBe(1);
  });

  it('never retries a refusal (4xx)', async () => {
    drive.script.push({ status: 422 });
    expect(await carrier.book(market, request)).toEqual({
      ok: false,
      error: { code: 'carrier.refused' },
    });
    expect(drive.seen).toHaveLength(1);
    expect(slept).toEqual([]);
  });

  it('retries a 5xx up to the configured attempts, with doubling backoff', async () => {
    for (let n = 0; n < configured.maxAttempts; n += 1) drive.script.push({ status: 503 });
    expect(await carrier.book(market, request)).toEqual({
      ok: false,
      error: { code: 'carrier.unavailable' },
    });
    expect(drive.seen).toHaveLength(configured.maxAttempts);
    expect(slept).toEqual(
      Array.from({ length: configured.maxAttempts - 1 }, (_v, n) => configured.backoffMs * 2 ** n),
    );

    drive.seen.length = 0;
    drive.script.push({ status: 502 });
    expect((await carrier.book(market, request)).ok).toBe(true);
    expect(drive.seen).toHaveLength(2);
  });

  it('gives up an attempt after the timeout', async () => {
    carrier = build({ timeoutMs: 100, maxAttempts: 1 });
    drive.script.push('hang');
    expect(await carrier.book(market, request)).toEqual({
      ok: false,
      error: { code: 'carrier.unavailable' },
    });
  });

  it('opens the circuit after the threshold, then lets one trial through after the cooldown', async () => {
    const { failureThreshold, cooldownSeconds } = configured.circuitBreaker;
    carrier = build({ maxAttempts: 1 });
    for (let n = 0; n < failureThreshold; n += 1) drive.script.push({ status: 500 });
    for (let n = 0; n < failureThreshold; n += 1) {
      expect((await carrier.book(market, request)).ok).toBe(false);
    }
    expect(drive.seen).toHaveLength(failureThreshold);
    // Open: fails fast, Drive sees nothing.
    expect(await carrier.book(market, request)).toEqual({
      ok: false,
      error: { code: 'carrier.unavailable' },
    });
    expect(drive.seen).toHaveLength(failureThreshold);
    clock.advance(Temporal.Duration.from({ seconds: cooldownSeconds }));
    expect((await carrier.book(market, request)).ok).toBe(true);
    expect((await carrier.book(market, request)).ok).toBe(true);
    expect(drive.seen).toHaveLength(failureThreshold + 2);
  });

  it('refuses an answer about another reference or without a delivery id', async () => {
    drive.script.push({
      status: 201,
      body: {
        id: '01990000-0000-7000-8000-0000000000ff',
        status: 'SCHEDULED',
        externalReference: '01990000-0000-7000-8000-0000000000a2',
      },
    });
    expect((await carrier.book(market, request)).ok).toBe(false);
    drive.script.push({ status: 201, body: { status: 'SCHEDULED' } });
    expect(await carrier.book(market, request)).toEqual({
      ok: false,
      error: { code: 'carrier.unavailable' },
    });
  });

  it('cancels with the cancelled event, and refuses a malformed reference without a call', async () => {
    const booked = await carrier.book(market, request);
    const reference = booked.ok ? booked.value.carrierReference : '';
    expect(await carrier.cancel(market, reference)).toEqual({
      ok: true,
      value: { carrierStatus: 'CANCELLED' },
    });
    expect(drive.seen[1]).toMatchObject({
      url: `/delivery/deliveries/${reference}/events`,
      body: { type: 'cancelled' },
    });
    const calls = drive.seen.length;
    expect(await carrier.cancel(market, '../../admin')).toEqual({
      ok: false,
      error: { code: 'carrier.refused' },
    });
    expect(drive.seen).toHaveLength(calls);
  });

  it('sends nothing when the Market has no key or no webhook secret', async () => {
    const off = new MondapacDriveCarrier(
      new LocalDrivePolicy(() => drive.url, {}, { apiKeys: { [code]: KEY }, webhookSecrets: {} }),
      { [code]: KEY },
      new DriveHttpClient(new CircuitBreaker(clock)),
    );
    expect(await off.book(market, request)).toEqual({
      ok: false,
      error: { code: 'carrier.not-configured' },
    });
    expect(drive.seen).toEqual([]);
  });
});

describe.each([['AU'], ['ZZ']] as const)('DriveWebhookSignature in market %s', (code) => {
  const clock = new FixedClock(T0);
  const signature = new DriveWebhookSignature({ [code]: SECRET }, clock);
  const now = Math.floor(T0.epochMilliseconds / 1000);
  const body = new TextEncoder().encode(`{"id":"x","marketId":"${code}"}`);
  const sign = (timestamp: number, payload: Uint8Array = body, secret = SECRET) =>
    createHmac('sha256', secret).update(`${timestamp}.`).update(payload).digest('hex');
  const verify = (timestamp: unknown, header: unknown, payload = body, market = code) =>
    signature.verify(market, payload, { timestamp, signature: header });

  it('passes a v1 HMAC of `<timestamp>.<raw body>` within the window', () => {
    expect(signature.configuredFor(code)).toBe(true);
    expect(verify(String(now), `v1=${sign(now)}`)).toBe(true);
    const edge = now - DRIVE_SIGNATURE_TOLERANCE_SECONDS;
    expect(verify(String(edge), `v1=${sign(edge)}`)).toBe(true);
    // During a secret rotation Drive sends one v1 per secret.
    expect(verify(String(now), `v1=${sign(now, body, 'old-secret')}, v1=${sign(now)}`)).toBe(true);
  });

  it.each([
    ['outside the replay window', () => [String(now - 301), `v1=${sign(now - 301)}`]],
    ['in the future', () => [String(now + 301), `v1=${sign(now + 301)}`]],
    ['under another secret', () => [String(now), `v1=${sign(now, body, 'other-secret')}`]],
    ['for another timestamp', () => [String(now), `v1=${sign(now - 1)}`]],
    ['without a v1', () => [String(now), `v0=${sign(now)}`]],
    ['with upper-case hex', () => [String(now), `v1=${sign(now).toUpperCase()}`]],
    ['with a malformed entry', () => [String(now), `v1=${sign(now)}=x`]],
    ['with a non-numeric timestamp', () => [`${now}.5`, `v1=${sign(now)}`]],
    [
      'with too many entries',
      () => [
        String(now),
        Array(5)
          .fill(`v1=${sign(now)}`)
          .join(','),
      ],
    ],
    ['with no headers', () => [undefined, undefined]],
  ])('refuses a signature %s', (_label, headers) => {
    const [timestamp, header] = headers();
    expect(verify(timestamp, header)).toBe(false);
  });

  it('refuses a changed body and a Market without a secret', () => {
    const changed = new TextEncoder().encode(`{"id":"y","marketId":"${code}"}`);
    expect(verify(String(now), `v1=${sign(now)}`, changed)).toBe(false);
    const other = code === 'AU' ? 'ZZ' : 'AU';
    expect(signature.configuredFor(other)).toBe(false);
    expect(verify(String(now), `v1=${sign(now)}`, body, other)).toBe(false);
  });
});

describe('CircuitBreaker', () => {
  it('opens after the threshold, half-opens after the cooldown, and closes on success', () => {
    const clock = new FixedClock(T0);
    const breaker = new CircuitBreaker(clock);
    const settings = { failureThreshold: 2, cooldownMs: 10_000 };
    breaker.failed('ZZ|x', settings);
    expect(breaker.state('ZZ|x')).toBe('closed');
    breaker.failed('ZZ|x', settings);
    expect(breaker.state('ZZ|x')).toBe('open');
    expect(breaker.allow('ZZ|x')).toBe(false);
    // Another key is not affected.
    expect(breaker.allow('AU|x')).toBe(true);
    clock.advance(Temporal.Duration.from({ seconds: 10 }));
    expect(breaker.state('ZZ|x')).toBe('half-open');
    expect(breaker.allow('ZZ|x')).toBe(true);
    // Only one trial at a time.
    expect(breaker.allow('ZZ|x')).toBe(false);
    // A failed trial opens it again at once.
    breaker.failed('ZZ|x', settings);
    expect(breaker.state('ZZ|x')).toBe('open');
    clock.advance(Temporal.Duration.from({ seconds: 10 }));
    expect(breaker.allow('ZZ|x')).toBe(true);
    breaker.succeeded('ZZ|x');
    expect(breaker.state('ZZ|x')).toBe('closed');
  });
});
