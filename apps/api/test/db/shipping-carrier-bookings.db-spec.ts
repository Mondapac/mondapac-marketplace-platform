import { ok, Temporal } from '@mondapac/shared-kernel';
import type { MarketContext } from '@mondapac/shared-kernel';
import { FixedClock } from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import {
  advanceBooking,
  newBooking,
  type CarrierBooking,
} from '../../src/modules/shipping/domain/carrier-booking';
import type { FleetCode } from '../../src/modules/shipping/domain/fleet';
import { PrismaCarrierBookingRepository } from '../../src/modules/shipping/infrastructure/prisma-carrier-booking.repository';
import { UuidV7IdGenerator } from '../../src/platform/ids/uuid-v7-id-generator';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { testDatabaseUrl } from './test-database';

// The carrier bookings and the carrier webhook events (shipping.carrier_bookings,
// shipping.carrier_events) as the application role, in both Market fixtures: one booking per
// seller order, the versioned save, one event per id, the Market guard, and what the database
// refuses.

const T0 = Temporal.Instant.from('2026-10-24T10:00:00Z');
const CHECK = '23514';
const DENIED = '42501';

describe.each(TEST_MARKETS)('carrier booking repository in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  const ids = new UuidV7IdGenerator(new FixedClock(T0));
  let db: Persistence;
  let repository: PrismaCarrierBookingRepository;
  let sql: Client;

  beforeAll(async () => {
    db = createPersistence();
    repository = new PrismaCarrierBookingRepository(db.service);
    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
  });
  afterAll(async () => {
    await db.close();
    await sql.end();
  });

  const value = async <T>(target: MarketContext, work: () => Promise<T>): Promise<T> => {
    const result = await db.unitOfWork.run(target, async () => ok(await work()));
    if (!result.ok) throw new Error('unit failed');
    return result.value;
  };
  // Each Market fixture polls its own fleet, so the rows the other fixture's run left behind (a
  // booking in the "other" Market) never reach this run's ordering assertions.
  const polledFleet: FleetCode = (['auspost', 'zoom2u', 'uber_direct'] as const)[
    TEST_MARKETS.indexOf(code)
  ]!;
  const fresh = () =>
    newBooking({
      id: ids.next<'CarrierBooking'>(),
      sellerOrderId: ids.next<'SellerOrder'>(),
      orderId: ids.next<'Order'>(),
      sellerId: ids.next<'Seller'>(),
      fleet: 'mondapac_drive',
      carrierReference: ids.next(),
      carrierStatus: 'SCHEDULED',
      now: T0,
    });

  it('stores one booking per seller order and reads it back in its Market only', async () => {
    const booking = fresh();
    expect(await value(market, () => repository.insert(market, booking))).toBe('inserted');
    expect(
      await value(market, () => repository.insert(market, { ...booking, id: ids.next() })),
    ).toBe('exists');

    const read = await value(market, () =>
      repository.findBySellerOrder(market, booking.sellerOrderId),
    );
    expect(read).toEqual(booking);
    expect(
      await value(other, () => repository.findBySellerOrder(other, booking.sellerOrderId)),
    ).toBeNull();
  });

  it('saves a change only at the expected version', async () => {
    const booking = fresh();
    await value(market, () => repository.insert(market, booking));
    const picked = advanceBooking(
      booking,
      { progress: 'picked-up', carrierStatus: 'PICKED_UP' },
      T0.add({ minutes: 5 }),
    )!;
    expect(await value(market, () => repository.save(market, picked, 1))).toBe('saved');
    expect(await value(market, () => repository.save(market, picked, 1))).toBe('conflict');
    expect(await value(other, () => repository.save(other, picked, 2))).toBe('conflict');
    const read = await value(market, () =>
      repository.findBySellerOrder(market, booking.sellerOrderId),
    );
    expect(read).toMatchObject({ progress: 'picked-up', carrierStatus: 'PICKED_UP', version: 2 });
  });

  it('takes a webhook event once per id and Market', async () => {
    const event = { eventId: ids.next(), carrier: 'mondapac_drive', receivedAt: T0 };
    expect(await value(market, () => repository.recordEvent(market, event))).toBe('recorded');
    expect(await value(market, () => repository.recordEvent(market, event))).toBe('duplicate');
    expect(await value(other, () => repository.recordEvent(other, event))).toBe('recorded');
  });

  it('keeps the fleet a booking was sent to while the answer is unknown, and clears it', async () => {
    const sellerOrderId = ids.next<'SellerOrder'>();
    expect(await value(market, () => repository.findAttempt(market, sellerOrderId))).toBeNull();

    await value(market, () => repository.markAttempt(market, sellerOrderId, 'uber_direct', T0));
    expect(await value(market, () => repository.findAttempt(market, sellerOrderId))).toBe(
      'uber_direct',
    );
    // A second mark replaces the first; another Market sees nothing.
    await value(market, () => repository.markAttempt(market, sellerOrderId, 'zoom2u', T0));
    expect(await value(market, () => repository.findAttempt(market, sellerOrderId))).toBe('zoom2u');
    expect(await value(other, () => repository.findAttempt(other, sellerOrderId))).toBeNull();

    await value(other, () => repository.clearAttempt(other, sellerOrderId));
    expect(await value(market, () => repository.findAttempt(market, sellerOrderId))).toBe('zoom2u');
    await value(market, () => repository.clearAttempt(market, sellerOrderId));
    expect(await value(market, () => repository.findAttempt(market, sellerOrderId))).toBeNull();
  });

  it('lists the open bookings of one fleet in its Market: never asked first, then oldest asked', async () => {
    const make = (overrides: Partial<CarrierBooking>, createdAfterMinutes = 0): CarrierBooking => ({
      ...fresh(),
      fleet: polledFleet,
      createdAt: T0.add({ minutes: createdAfterMinutes }),
      updatedAt: T0.add({ minutes: createdAfterMinutes }),
      ...overrides,
    });
    const neverOlder = make({}, 0);
    const neverNewer = make({}, 1);
    const pickedUp = make({ progress: 'picked-up', polledAt: T0.add({ minutes: 20 }) }, 2);
    const askedEarly = make({ polledAt: T0.add({ minutes: 30 }) }, 3);
    const askedLate = make({ polledAt: T0.add({ minutes: 40 }) }, 4);
    const finals = (['delivered', 'cancelled', 'exception'] as const).map((progress) =>
      make({ progress }, 5),
    );
    const foreign = make({}, 0);
    const otherFleet = { ...make({}, 0), fleet: 'mondapac_drive' as const };
    for (const booking of [askedLate, neverNewer, pickedUp, askedEarly, neverOlder, ...finals]) {
      await value(market, () => repository.insert(market, booking));
    }
    await value(market, () => repository.insert(market, otherFleet));
    await value(other, () => repository.insert(other, foreign));

    const listed = await value(market, () => repository.listOpen(market, polledFleet, 50));
    expect(listed.map((b) => b.id)).toEqual(
      [neverOlder, neverNewer, pickedUp, askedEarly, askedLate].map((b) => b.id),
    );
    expect(listed.every((b) => b.fleet === polledFleet)).toBe(true);

    const limited = await value(market, () => repository.listOpen(market, polledFleet, 3));
    expect(limited.map((b) => b.id)).toEqual([neverOlder, neverNewer, pickedUp].map((b) => b.id));
    // The other Market's booking is its own to list.
    const foreignList = await value(other, () => repository.listOpen(other, polledFleet, 50));
    expect(foreignList.map((b) => b.id)).toEqual([foreign.id]);
  });

  it('marks a booking polled without touching its version or updated_at, in its Market only', async () => {
    const booking = fresh();
    await value(market, () => repository.insert(market, booking));
    const at = T0.add({ hours: 1 });

    await value(other, () => repository.markPolled(other, booking.id, at));
    const untouched = await value(market, () =>
      repository.findBySellerOrder(market, booking.sellerOrderId),
    );
    expect(untouched?.polledAt).toBeNull();

    await value(market, () => repository.markPolled(market, booking.id, at));
    const read = await value(market, () =>
      repository.findBySellerOrder(market, booking.sellerOrderId),
    );
    expect(read?.polledAt?.epochMilliseconds).toBe(at.epochMilliseconds);
    expect(read?.version).toBe(booking.version);
    expect(read?.updatedAt.epochMilliseconds).toBe(booking.updatedAt.epochMilliseconds);
  });

  it('saves the instant a proof of delivery was reported, never more', async () => {
    const booking = fresh();
    await value(market, () => repository.insert(market, booking));
    const at = T0.add({ minutes: 30 });
    const delivered = advanceBooking(
      booking,
      { progress: 'delivered', carrierStatus: 'DELIVERED', proofOfDelivery: true },
      at,
    )!;
    expect(await value(market, () => repository.save(market, delivered, 1))).toBe('saved');
    const read = await value(market, () =>
      repository.findBySellerOrder(market, booking.sellerOrderId),
    );
    expect(read?.podRecordedAt?.epochMilliseconds).toBe(at.epochMilliseconds);
    expect(read?.progress).toBe('delivered');
  });

  it('finds a booking by the fleet and its reference in its Market only', async () => {
    const booking = fresh();
    await value(market, () => repository.insert(market, booking));
    const find = (target: MarketContext, fleet: FleetCode) =>
      value(target, () =>
        repository.findByCarrierReference(target, fleet, booking.carrierReference),
      );

    expect(await find(market, 'mondapac_drive')).toEqual(booking);
    expect(await find(other, 'mondapac_drive')).toBeNull();
    expect(await find(market, 'uber_direct')).toBeNull();
  });

  it('refuses a tracking link that is not a plain https URL of at most 500 characters', async () => {
    const insertWith = (trackingUrl: string | null) =>
      sql
        .query(
          `INSERT INTO shipping.carrier_bookings (id, market_id, tenant_id, seller_order_id,
             order_id, seller_id, fleet, carrier_reference, progress, carrier_status, version,
             tracking_url, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'mondapac_drive', $7, 'booked', 'SCHEDULED', 1, $8,
             now(), now())`,
          [
            ids.next(),
            market.marketId,
            market.tenantId,
            ids.next(),
            ids.next(),
            ids.next(),
            ids.next(),
            trackingUrl,
          ],
        )
        .then(
          () => 'allowed',
          (error: { code?: string }) => error.code,
        );

    expect(await insertWith('http://track.example.com/d/1')).toBe(CHECK);
    expect(await insertWith('https://track.example.com/d /1')).toBe(CHECK);
    expect(await insertWith('https://track.example.com/d/1\n')).toBe(CHECK);
    expect(
      await insertWith(`https://t.example/${'a'.repeat(500 - 'https://t.example/'.length + 1)}`),
    ).toBe(CHECK);
    expect(
      await insertWith(`https://t.example/${'a'.repeat(500 - 'https://t.example/'.length)}`),
    ).toBe('allowed');
    expect(await insertWith('https://track.example.com/d/1')).toBe('allowed');
    expect(await insertWith(null)).toBe('allowed');
  });

  it('refuses what the application never writes', async () => {
    const attempt = (text: string, params: unknown[]) =>
      sql.query(text, params).then(
        () => 'allowed',
        (error: { code?: string }) => error.code,
      );
    const insert = (overrides: { fleet?: string; reference?: string; progress?: string }) =>
      attempt(
        `INSERT INTO shipping.carrier_bookings (id, market_id, tenant_id, seller_order_id, order_id,
           seller_id, fleet, carrier_reference, progress, carrier_status, version, created_at,
           updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'SCHEDULED', 1, now(), now())`,
        [
          ids.next(),
          market.marketId,
          market.tenantId,
          ids.next(),
          ids.next(),
          ids.next(),
          overrides.fleet ?? 'mondapac_drive',
          overrides.reference ?? ids.next(),
          overrides.progress ?? 'booked',
        ],
      );

    expect(await insert({ fleet: 'other-courier' })).toBe(CHECK);
    expect(await insert({ reference: 'has a space' })).toBe(CHECK);
    expect(await insert({ progress: 'lost' })).toBe(CHECK);
    expect(await insert({})).toBe('allowed');
    expect(await attempt(`UPDATE shipping.carrier_bookings SET seller_id = $1`, [ids.next()])).toBe(
      DENIED,
    );
    expect(await attempt(`DELETE FROM shipping.carrier_bookings`, [])).toBe(DENIED);
    expect(await attempt(`DELETE FROM shipping.carrier_events`, [])).toBe(DENIED);
  });
});
