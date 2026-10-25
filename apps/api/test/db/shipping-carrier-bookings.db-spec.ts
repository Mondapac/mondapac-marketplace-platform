import { ok, Temporal } from '@mondapac/shared-kernel';
import type { MarketContext } from '@mondapac/shared-kernel';
import { FixedClock } from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import { advanceBooking, newBooking } from '../../src/modules/shipping/domain/carrier-booking';
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
    const event = { eventId: ids.next(), carrier: 'mondapac-drive', receivedAt: T0 };
    expect(await value(market, () => repository.recordEvent(market, event))).toBe('recorded');
    expect(await value(market, () => repository.recordEvent(market, event))).toBe('duplicate');
    expect(await value(other, () => repository.recordEvent(other, event))).toBe('recorded');
  });

  it('refuses what the application never writes', async () => {
    const attempt = (text: string, params: unknown[]) =>
      sql.query(text, params).then(
        () => 'allowed',
        (error: { code?: string }) => error.code,
      );
    const insert = (overrides: { carrier?: string; reference?: string; progress?: string }) =>
      attempt(
        `INSERT INTO shipping.carrier_bookings (id, market_id, tenant_id, seller_order_id, order_id,
           seller_id, carrier, carrier_reference, progress, carrier_status, version, created_at,
           updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'SCHEDULED', 1, now(), now())`,
        [
          ids.next(),
          market.marketId,
          market.tenantId,
          ids.next(),
          ids.next(),
          ids.next(),
          overrides.carrier ?? 'mondapac-drive',
          overrides.reference ?? ids.next(),
          overrides.progress ?? 'booked',
        ],
      );

    expect(await insert({ carrier: 'other-courier' })).toBe(CHECK);
    expect(await insert({ reference: 'DRV-1' })).toBe(CHECK);
    expect(await insert({ progress: 'lost' })).toBe(CHECK);
    expect(await insert({})).toBe('allowed');
    expect(await attempt(`UPDATE shipping.carrier_bookings SET seller_id = $1`, [ids.next()])).toBe(
      DENIED,
    );
    expect(await attempt(`DELETE FROM shipping.carrier_bookings`, [])).toBe(DENIED);
    expect(await attempt(`DELETE FROM shipping.carrier_events`, [])).toBe(DENIED);
  });
});
