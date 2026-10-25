import { createHmac } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext, PendingEvent } from '@mondapac/shared-kernel';
import { FixedClock } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { CARRIER_BOOKING_REPOSITORY } from '../src/modules/shipping/application/ports/carrier-booking.repository';
import type { CarrierBookingRepository } from '../src/modules/shipping/application/ports/carrier-booking.repository';
import { newBooking, type CarrierBooking } from '../src/modules/shipping/domain/carrier-booking';
import { CARRIER_WEBHOOK_STATUS } from '../src/modules/shipping/presentation/carrier-webhook.controller';
import { CLOCK } from '../src/platform/clock/clock.module';
import { OUTBOX_WRITER } from '../src/platform/events/outbox-writer';
import { UNIT_OF_WORK } from '../src/platform/unit-of-work/unit-of-work';
import { FakeUnitOfWork } from './support/pricing-fakes';
import { createTestApp } from './support/test-app';
import { TEST_MARKETS } from './support/test-config';

// The Mondapac Drive webhook route over HTTP: the real guards, raw-body parser, controller, gate,
// use case and signature check; bookings and the outbox in memory. Proves the Market comes from
// the path, the signature is checked over the exact bytes with Drive's headers, no session or
// Origin is needed, a repeat is taken once, and every refusal has its status.

const START = Temporal.Instant.from('2026-10-24T10:00:00Z');
const SECRET = 'drive-test-webhook-secret-0123456789abc';
const KEY = 'drive_test_key_0123456789abcdef';
const DELIVERY = '01990000-0000-7000-8000-0000000000d1';
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const SELLER_ORDER = id<'SellerOrder'>(0x5a);
const codeOf = (res: request.Response) => (res.body as { code?: string }).code;

class MemoryBookings implements CarrierBookingRepository {
  readonly rows = new Map<string, CarrierBooking>();
  readonly events = new Set<string>();
  findBySellerOrder(m: MarketContext, sellerOrderId: Id<'SellerOrder'>) {
    return Promise.resolve(this.rows.get(`${m.marketId}|${sellerOrderId}`) ?? null);
  }
  insert(m: MarketContext, booking: CarrierBooking) {
    this.rows.set(`${m.marketId}|${booking.sellerOrderId}`, booking);
    return Promise.resolve('inserted' as const);
  }
  save(m: MarketContext, booking: CarrierBooking, expectedVersion: number) {
    const key = `${m.marketId}|${booking.sellerOrderId}`;
    if (this.rows.get(key)?.version !== expectedVersion)
      return Promise.resolve('conflict' as const);
    this.rows.set(key, booking);
    return Promise.resolve('saved' as const);
  }
  recordEvent(m: MarketContext, event: { readonly eventId: string }) {
    const key = `${m.marketId}|${event.eventId}`;
    if (this.events.has(key)) return Promise.resolve('duplicate' as const);
    this.events.add(key);
    return Promise.resolve('recorded' as const);
  }
}

it('maps every refusal code of the carrier webhook to its exact status', () => {
  expect(CARRIER_WEBHOOK_STATUS).toEqual({
    'validation.failed': 400,
    'shipping.signature-invalid': 400,
    'shipping.event-refused': 400,
    'shipping.carrier-delivery-not-found': 404,
    'shipping.webhook-unavailable': 503,
    'access.unauthenticated': 401,
    'access.denied': 403,
    'access.seller-not-approved': 403,
    'access.unavailable': 503,
  });
});

describe.each(TEST_MARKETS)('Mondapac Drive webhook over HTTP in market %s', (code) => {
  let app: NestExpressApplication;
  let bookings: MemoryBookings;
  let written: PendingEvent[];
  const clock = new FixedClock(START);
  const path = `/shipping/carriers/mondapac-drive/webhook/${code}`;
  const secrets = {
    MONDAPAC_DRIVE_API_KEY: TEST_MARKETS.map((m) => `${m}=${KEY}`).join(','),
    MONDAPAC_DRIVE_WEBHOOK_SECRET: TEST_MARKETS.map((m) => `${m}=${SECRET}`).join(','),
  };

  const start = async (env: Record<string, string> = secrets) => {
    bookings = new MemoryBookings();
    written = [];
    const market = { marketId: code } as MarketContext;
    await bookings.insert(
      market,
      newBooking({
        id: id<'CarrierBooking'>(0xb1),
        sellerOrderId: SELLER_ORDER,
        orderId: id<'Order'>(0x0a),
        sellerId: id<'Seller'>(0x51),
        carrierReference: DELIVERY,
        carrierStatus: 'SCHEDULED',
        now: START,
      }),
    );
    ({ app } = await createTestApp({
      env,
      override: (builder) =>
        builder
          .overrideProvider(CLOCK)
          .useValue(clock)
          .overrideProvider(UNIT_OF_WORK)
          .useValue(new FakeUnitOfWork())
          .overrideProvider(CARRIER_BOOKING_REPOSITORY)
          .useValue(bookings)
          .overrideProvider(OUTBOX_WRITER)
          .useValue({
            append: (_c: unknown, events: readonly PendingEvent[]) => {
              written.push(...events);
              return Promise.resolve();
            },
          }),
    }));
  };
  afterEach(async () => {
    await app?.close();
  });

  // Indented JSON: re-serialising a parsed body would change these bytes and break the signature.
  const bodyOf = (status: string, n = 1, deliveryId = DELIVERY) =>
    JSON.stringify(
      {
        id: `01990000-0000-7000-8000-${(0xe000 + n).toString(16).padStart(12, '0')}`,
        type: 'delivery.status-changed',
        occurredAt: START.toString(),
        marketId: code,
        data: { deliveryId, externalReference: SELLER_ORDER, status, previousStatus: 'AT_PICKUP' },
      },
      null,
      2,
    );
  const signed = (body: string, secret = SECRET) => {
    const timestamp = String(Math.floor(START.epochMilliseconds / 1000));
    const digest = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
    return { timestamp, signature: `v1=${digest}` };
  };
  const post = (
    body: string,
    headers: { timestamp?: string; signature?: string } = signed(body),
    type = 'application/json',
    to = path,
  ) => {
    let req = request(app.getHttpServer())
      .post(to)
      .set('Content-Type', type)
      .set('User-Agent', 'MondapacDrive-Webhooks/1');
    if (headers.timestamp !== undefined) req = req.set('Drive-Timestamp', headers.timestamp);
    if (headers.signature !== undefined) req = req.set('Drive-Signature', headers.signature);
    return req.send(body);
  };
  const progress = () => [...bookings.rows.values()][0]?.progress;

  it('applies a signed event without a session, an Origin or x-market-id, and a repeat once', async () => {
    await start();
    const body = bodyOf('PICKED_UP');

    const first = await post(body);
    const again = await post(body);

    expect(first.status).toBe(200);
    expect(first.body).toEqual({ received: true });
    expect(first.headers['cache-control']).toBe('no-store');
    expect(again.status).toBe(200);
    expect(progress()).toBe('picked-up');
    expect(written.map((e) => e.type)).toEqual(['shipping.carrier-delivery-progressed.v1']);
  });

  it('refuses a body whose bytes differ from what was signed, or no signature', async () => {
    await start();
    const body = bodyOf('DELIVERED');

    const changed = await post(body, signed(JSON.stringify(JSON.parse(body))));
    const wrongSecret = await post(body, signed(body, 'another-secret-0123456789abcdef'));
    const unsigned = await post(body, {});

    for (const res of [changed, wrongSecret, unsigned]) {
      expect([res.status, res.body]).toEqual([
        400,
        { statusCode: 400, code: 'shipping.signature-invalid' },
      ]);
    }
    expect(progress()).toBe('booked');
  });

  it('answers 404 for an unknown delivery and 400 for another Market path', async () => {
    await start();
    const foreignDelivery = bodyOf('PICKED_UP', 2, '01990000-0000-7000-8000-0000000000d9');
    const other = TEST_MARKETS.find((m) => m !== code)!;
    const body = bodyOf('PICKED_UP', 3);

    const refused = await post(foreignDelivery);
    const crossed = await post(body, signed(body), 'application/json', path.replace(code, other));

    expect([refused.status, codeOf(refused)]).toEqual([400, 'shipping.event-refused']);
    // The other Market has no booking of this seller order and its event names this Market.
    expect([crossed.status, codeOf(crossed)]).toEqual([400, 'shipping.event-refused']);
    bookings.rows.clear();
    const missing = await post(bodyOf('PICKED_UP', 4));
    expect([missing.status, codeOf(missing)]).toEqual([404, 'shipping.carrier-delivery-not-found']);
  });

  it('refuses a body that is not JSON', async () => {
    await start();
    const body = bodyOf('PICKED_UP');

    const res = await post(body, signed(body), 'text/plain');

    expect(res.status).toBe(415);
    expect(codeOf(res)).toBe('request.body-unsupported');
  });

  it('answers 503 without a webhook secret, so Drive retries', async () => {
    await start({});
    const body = bodyOf('PICKED_UP');

    const res = await post(body);

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ statusCode: 503, code: 'shipping.webhook-unavailable' });
  });
});
