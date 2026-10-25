import { createHmac } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext, PendingEvent } from '@mondapac/shared-kernel';
import { FixedClock } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { CARRIER_BOOKING_REPOSITORY } from '../src/modules/shipping/application/ports/carrier-booking.repository';
import { FLEET_REGISTRY } from '../src/modules/shipping/application/ports/fleet-registry';
import { newBooking } from '../src/modules/shipping/domain/carrier-booking';
import type { FleetCapabilities } from '../src/modules/shipping/domain/fleet';
import { UBER_WEBHOOK_STATUS } from '../src/modules/shipping/presentation/uber-webhook.controller';
import { CLOCK } from '../src/platform/clock/clock.module';
import { OUTBOX_WRITER } from '../src/platform/events/outbox-writer';
import { UNIT_OF_WORK } from '../src/platform/unit-of-work/unit-of-work';
import { FakeUnitOfWork } from './support/pricing-fakes';
import { ListRegistry, MemoryBookings } from './support/shipping-fakes';
import { createTestApp } from './support/test-app';
import { TEST_MARKETS } from './support/test-config';

// Uber Direct's status webhook over HTTP: the real guards, raw-body parser, controller, gate, use
// case and signature check; bookings and the outbox in memory. The Market comes from the path, the
// signature is checked over the exact bytes of x-uber-signature, no session or Origin is needed,
// a repeat is taken once, and every refusal has its status and says nothing more than its code.

const START = Temporal.Instant.from('2026-10-25T10:00:00Z');
const SECRET = 'uber-test-webhook-secret-0123456789abc';
const DELIVERY = 'del_abcdefgh1234';
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const SELLER_ORDER = id<'SellerOrder'>(0x5a);
const codeOf = (res: request.Response) => (res.body as { code?: string }).code;
/** The default per-minute limit of each Market fixture. */
const DEFAULT_LIMIT = { AU: 300, ZZ: 200 } as const;

it('maps every refusal code of the Uber webhook to its exact status', () => {
  expect(UBER_WEBHOOK_STATUS).toEqual({
    'validation.failed': 400,
    'shipping.signature-invalid': 401,
    'shipping.fleet-off': 404,
    'shipping.carrier-delivery-not-found': 404,
    'access.unauthenticated': 401,
    'access.denied': 403,
    'access.seller-not-approved': 403,
    'access.unavailable': 503,
  });
});

describe.each(TEST_MARKETS)('Uber Direct webhook over HTTP in market %s', (code) => {
  let app: NestExpressApplication;
  let bookings: MemoryBookings;
  let written: PendingEvent[];
  const clock = new FixedClock(START);
  const path = `/shipping/carriers/uber-direct/webhook/${code}`;
  const secrets = {
    UBER_DIRECT_WEBHOOK_SECRET: TEST_MARKETS.map((m) => `${m}=${SECRET}`).join(','),
  };

  /** `fleetOn`: a scripted Uber gateway that is on; false keeps the real one, off by Market config. */
  const start = async (env: Record<string, string> = secrets, fleetOn = true) => {
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
        fleet: 'uber_direct',
        carrierReference: DELIVERY,
        carrierStatus: 'PENDING',
        now: START,
      }),
    );
    ({ app } = await createTestApp({
      env,
      override: (builder) => {
        let chain = builder
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
          });
        if (fleetOn) {
          chain = chain.overrideProvider(FLEET_REGISTRY).useValue(
            new ListRegistry([
              {
                fleet: 'uber_direct',
                capabilities: () => ({ fleet: 'uber_direct' }) as FleetCapabilities,
              } as never,
            ]),
          );
        }
        return chain;
      },
    }));
  };
  afterEach(async () => {
    await app?.close();
  });

  const bodyOf = (status: string, n = 1, deliveryId = DELIVERY) =>
    JSON.stringify(
      {
        kind: 'event.delivery_status',
        id: `evt_${String(n).padStart(4, '0')}`,
        delivery_id: deliveryId,
        status,
        data: { id: deliveryId, status },
      },
      null,
      2,
    );
  const signed = (body: string, secret = SECRET) =>
    createHmac('sha256', secret).update(body).digest('hex');
  const post = (
    body: string,
    signature: string | null = signed(body),
    type = 'application/json',
    to = path,
  ) => {
    let req = request(app.getHttpServer())
      .post(to)
      .set('Content-Type', type)
      .set('User-Agent', 'Uber-Webhooks/1');
    if (signature !== null) req = req.set('x-uber-signature', signature);
    return req.send(body);
  };
  const progress = () => [...bookings.rows.values()][0]?.progress;

  it('applies a signed event without a session, an Origin or x-market-id, and a repeat once', async () => {
    await start();
    const body = bodyOf('pickup_complete');

    const first = await post(body);
    const again = await post(body);

    expect(first.status).toBe(200);
    expect(first.body).toEqual({ received: true });
    expect(first.headers['cache-control']).toBe('no-store');
    expect(again.status).toBe(200);
    expect(progress()).toBe('picked-up');
    expect(written.map((e) => e.type)).toEqual(['shipping.carrier-delivery-progressed.v1']);
  });

  it('delivers on a signed delivered event, keeping a proof as its instant only', async () => {
    await start();
    const body = JSON.stringify({
      kind: 'event.delivery_status',
      id: 'evt_pod',
      delivery_id: DELIVERY,
      status: 'delivered',
      data: { verification: { picture: { image_url: 'https://pod.example/p.jpg' } } },
    });

    expect((await post(body)).status).toBe(200);

    const row = [...bookings.rows.values()][0]!;
    expect(row.progress).toBe('delivered');
    expect(row.podRecordedAt?.toString()).toBe(START.toString());
    expect(JSON.stringify(row)).not.toContain('pod.example');
  });

  it('answers 401 with only the code for a changed body, a wrong secret, a malformed or missing signature', async () => {
    await start();
    const body = bodyOf('delivered');

    const changed = await post(body, signed(JSON.stringify(JSON.parse(body))));
    const wrongSecret = await post(body, signed(body, 'another-secret-0123456789abcdef'));
    const malformed = await post(body, 'sha256=' + signed(body));
    const missing = await post(body, null);

    for (const res of [changed, wrongSecret, malformed, missing]) {
      expect([res.status, res.body]).toEqual([
        401,
        { statusCode: 401, code: 'shipping.signature-invalid' },
      ]);
    }
    expect(progress()).toBe('booked');
    expect(bookings.events.size).toBe(0);
  });

  it('answers 404 for an unknown delivery (Uber retries) and for a Market whose secret the path names wrongly', async () => {
    await start();
    const unknown = bodyOf('pickup', 2, 'del_unknownxxxxx');
    const other = TEST_MARKETS.find((m) => m !== code)!;
    const body = bodyOf('pickup', 3);

    const missing = await post(unknown);
    const crossed = await post(body, signed(body), 'application/json', path.replace(code, other));

    expect([missing.status, codeOf(missing)]).toEqual([404, 'shipping.carrier-delivery-not-found']);
    // The other Market holds no such delivery: the body names no Market and is not believed.
    expect([crossed.status, codeOf(crossed)]).toEqual([404, 'shipping.carrier-delivery-not-found']);
    expect(progress()).toBe('booked');
  });

  it('answers 400 for a signed body that is not an event, and 415 for a body that is not JSON', async () => {
    await start();
    const notEvent = '{"hello":"world"}';
    const body = bodyOf('pickup');

    const invalid = await post(notEvent);
    const text = await post(body, signed(body), 'text/plain');

    expect([invalid.status, codeOf(invalid)]).toEqual([400, 'validation.failed']);
    expect([text.status, codeOf(text)]).toEqual([415, 'request.body-unsupported']);
  });

  it('refuses an oversized body before it is read as an event', async () => {
    await start();
    const body = JSON.stringify({ kind: 'event.delivery_status', pad: 'x'.repeat(70 * 1024) });

    const res = await post(body);

    expect(res.status).toBe(413);
    expect(progress()).toBe('booked');
  });

  it('answers 404, as when the fleet is off, without a signing secret', async () => {
    await start({});
    const res = await post(bodyOf('pickup'));

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ statusCode: 404, code: 'shipping.fleet-off' });
  });

  it('answers 404 when Uber Direct is off for the Market (the default), whatever is sent', async () => {
    await start(secrets, false);
    const body = bodyOf('pickup');

    for (const res of [await post(body), await post(body, 'garbage'), await post(body, null)]) {
      expect([res.status, res.body]).toEqual([
        404,
        { statusCode: 404, code: 'shipping.fleet-off' },
      ]);
    }
    expect(progress()).toBe('booked');
  });

  it('is throttled by the default per-origin limit, then answers 429 with our code', async () => {
    await start(secrets, false);
    const body = bodyOf('pickup');
    const limit = DEFAULT_LIMIT[code];
    for (let sent = 0; sent < limit; sent += 1) {
      const res = await post(body, 'garbage');
      if (res.status !== 404) throw new Error(`request ${sent} answered ${res.status}`);
    }

    const refused = await post(body);

    expect(refused.status).toBe(429);
    expect(codeOf(refused)).toBe('request.throttled');
  });
});
