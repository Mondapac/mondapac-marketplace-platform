import { money, ok, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { FixedClock } from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import type {
  DeliveryFallbackRecord,
  FleetFeeRecord,
} from '../../src/modules/shipping/application/ports/fleet-ledger.repository';
import {
  newDeliveryQuote,
  type DeliveryQuote,
} from '../../src/modules/shipping/domain/delivery-quote';
import { PrismaDeliveryQuoteRepository } from '../../src/modules/shipping/infrastructure/prisma-delivery-quote.repository';
import { PrismaFleetLedgerRepository } from '../../src/modules/shipping/infrastructure/prisma-fleet-ledger.repository';
import { UuidV7IdGenerator } from '../../src/platform/ids/uuid-v7-id-generator';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { testDatabaseUrl } from './test-database';

// The delivery quotes a buyer is charged, the fees fleets charge the platform and the fallback
// bookings (shipping.delivery_quotes, shipping.fleet_fees, shipping.delivery_fallbacks) as the
// application role, in both Market fixtures: what is found for whom, the Market guard, the
// insert-only ledgers, and what the database refuses.

const T0 = Temporal.Instant.from('2026-10-24T10:00:00Z');
const CHECK = '23514';
const DENIED = '42501';

describe.each(TEST_MARKETS)(
  'delivery quotes and the fleet ledger in market %s (database)',
  (code) => {
    const market = marketOf(code);
    const other = marketOf(otherMarketOf(code));
    const currency = code === 'AU' ? 'AUD' : 'JPY';
    const ids = new UuidV7IdGenerator(new FixedClock(T0));
    let db: Persistence;
    let quotes: PrismaDeliveryQuoteRepository;
    let ledger: PrismaFleetLedgerRepository;
    let sql: Client;

    beforeAll(async () => {
      db = createPersistence();
      quotes = new PrismaDeliveryQuoteRepository(db.service);
      ledger = new PrismaFleetLedgerRepository(db.service);
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
    const attempt = (text: string, params: unknown[]) =>
      sql.query(text, params).then(
        () => 'allowed',
        (error: { code?: string }) => error.code,
      );

    const accountId = ids.next<'Account'>();
    const sellerId = ids.next<'Seller'>();
    const scope = (
      method: 'instant' | 'same_day' | 'scheduled' = 'instant',
      postcode = '4109',
    ) => ({
      accountId,
      sellerId,
      method,
      dropoffPostcode: postcode,
    });
    const quoteAt = (
      at: Temporal.Instant,
      over: { method?: 'instant' | 'same_day' | 'scheduled'; owner?: Id<'Account'> } = {},
    ): DeliveryQuote => {
      const quote = newDeliveryQuote({
        id: ids.next<'DeliveryQuote'>(),
        scope: { ...scope(over.method), accountId: over.owner ?? accountId },
        fleet: 'mondapac_drive',
        priced: {
          quote: money(1000n, currency),
          margin: money(150n, currency),
          total: money(1150n, currency),
        },
        etaMinutes: 40,
        fleetExpiresAt: null,
        now: at,
      });
      if (quote === null) throw new Error('quote');
      return quote;
    };

    describe('delivery quotes', () => {
      it('stores a quote and reads it back by id in its Market only', async () => {
        const quote = quoteAt(T0);
        await value(market, () => quotes.insert(market, quote));
        expect(await value(market, () => quotes.findById(market, quote.id))).toEqual(quote);
        expect(await value(other, () => quotes.findById(other, quote.id))).toBeNull();
      });

      it('finds the newest quote that still holds for the buyer, seller, method and address', async () => {
        const owner = ids.next<'Account'>();
        const older = quoteAt(T0, { owner });
        const newer = quoteAt(T0.add({ minutes: 3 }), { owner });
        await value(market, () => quotes.insert(market, older));
        await value(market, () => quotes.insert(market, newer));
        const ask = { ...scope(), accountId: owner };

        expect(
          await value(market, () => quotes.findFresh(market, ask, T0.add({ minutes: 4 }))),
        ).toEqual(newer);
        // The first quote stopped holding at 10 minutes; the second holds until 13.
        expect(
          await value(market, () => quotes.findFresh(market, ask, T0.add({ minutes: 11 }))),
        ).toEqual(newer);
        expect(
          await value(market, () => quotes.findFresh(market, ask, T0.add({ minutes: 13 }))),
        ).toBeNull();
        // Another method, address, buyer or Market finds none of them.
        for (const wrong of [
          { ...ask, method: 'scheduled' as const },
          { ...ask, dropoffPostcode: '4000' },
          { ...ask, accountId: ids.next<'Account'>() },
        ]) {
          expect(await value(market, () => quotes.findFresh(market, wrong, T0))).toBeNull();
        }
        expect(await value(other, () => quotes.findFresh(other, ask, T0))).toBeNull();
      });

      it('removes only the buyer own quotes that stopped holding before the cut', async () => {
        const owner = ids.next<'Account'>();
        const bystander = ids.next<'Account'>();
        const stale = quoteAt(T0, { owner });
        const fresh = quoteAt(T0.add({ hours: 25 }), { owner });
        const theirs = quoteAt(T0, { owner: bystander });
        for (const quote of [stale, fresh, theirs]) {
          await value(market, () => quotes.insert(market, quote));
        }
        await value(market, () => quotes.deleteExpired(market, owner, T0.add({ hours: 24 })));
        expect(await value(market, () => quotes.findById(market, stale.id))).toBeNull();
        expect(await value(market, () => quotes.findById(market, fresh.id))).toEqual(fresh);
        expect(await value(market, () => quotes.findById(market, theirs.id))).toEqual(theirs);
        // Another Market's call removes nothing here.
        await value(other, () => quotes.deleteExpired(other, bystander, T0.add({ hours: 24 })));
        expect(await value(market, () => quotes.findById(market, theirs.id))).toEqual(theirs);
      });

      it('refuses what the application never writes', async () => {
        const insert = (over: {
          method?: string;
          fleet?: string;
          total?: number;
          currency?: string;
          postcode?: string;
          validUntil?: string;
        }) =>
          attempt(
            `INSERT INTO shipping.delivery_quotes (id, market_id, tenant_id, account_id, seller_id,
             method, dropoff_postcode, fleet, quote_amount, margin_amount, total_amount, currency,
             quoted_at, valid_until)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1000, 150, $9, $10, '2026-10-24T10:00:00Z', $11)`,
            [
              ids.next(),
              market.marketId,
              market.tenantId,
              accountId,
              sellerId,
              over.method ?? 'instant',
              over.postcode ?? '4109',
              over.fleet ?? 'uber_direct',
              over.total ?? 1150,
              over.currency ?? currency,
              over.validUntil ?? '2026-10-24T10:10:00Z',
            ],
          );
        expect(await insert({ method: 'pickup' })).toBe(CHECK);
        expect(await insert({ fleet: 'other-courier' })).toBe(CHECK);
        expect(await insert({ total: 1000 })).toBe(CHECK);
        expect(await insert({ currency: 'aud' })).toBe(CHECK);
        expect(await insert({ postcode: '' })).toBe(CHECK);
        expect(await insert({ validUntil: '2026-10-24T10:00:00Z' })).toBe(CHECK);
        expect(await insert({})).toBe('allowed');
        // Written once; nothing changes after, and the application may only remove its own.
        expect(await attempt(`UPDATE shipping.delivery_quotes SET total_amount = 1`, [])).toBe(
          DENIED,
        );
        expect(
          await attempt(`DELETE FROM shipping.delivery_quotes WHERE seller_id = $1`, [sellerId]),
        ).toBe('allowed');
      });
    });

    describe('the fleet-fee ledger', () => {
      const feeOf = (over: Partial<FleetFeeRecord> = {}): FleetFeeRecord => ({
        id: ids.next<'FleetFee'>(),
        fleet: 'mondapac_drive',
        sellerOrderId: ids.next<'SellerOrder'>(),
        reason: 'waiting',
        amount: money(250n, currency),
        externalRef: ids.next(),
        occurredAt: T0,
        recordedAt: T0.add({ minutes: 1 }),
        ...over,
      });

      it('records a fee once by the fleet reference, per Market', async () => {
        const fee = feeOf();
        expect(await value(market, () => ledger.recordFee(market, fee))).toBe('recorded');
        expect(
          await value(market, () =>
            ledger.recordFee(market, { ...fee, id: ids.next<'FleetFee'>() }),
          ),
        ).toBe('duplicate');
        expect(
          await value(other, () => ledger.recordFee(other, { ...fee, id: ids.next<'FleetFee'>() })),
        ).toBe('recorded');
        // The same reference of another fleet is another fee.
        expect(
          await value(market, () =>
            ledger.recordFee(market, { ...fee, id: ids.next<'FleetFee'>(), fleet: 'uber_direct' }),
          ),
        ).toBe('recorded');
      });

      it('refuses what the application never writes, and never changes or removes a fee', async () => {
        const fee = feeOf();
        await value(market, () => ledger.recordFee(market, fee));
        const insert = (over: { reason?: string; amount?: number; ref?: string; fleet?: string }) =>
          attempt(
            `INSERT INTO shipping.fleet_fees (id, market_id, tenant_id, fleet, seller_order_id, reason,
             amount, currency, external_ref, occurred_at, recorded_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), now())`,
            [
              ids.next(),
              market.marketId,
              market.tenantId,
              over.fleet ?? 'mondapac_drive',
              ids.next(),
              over.reason ?? 'cancel',
              over.amount ?? 100,
              currency,
              over.ref ?? ids.next(),
            ],
          );
        expect(await insert({ reason: 'tip' })).toBe(CHECK);
        expect(await insert({ amount: 0 })).toBe(CHECK);
        expect(await insert({ ref: '' })).toBe(CHECK);
        expect(await insert({ fleet: 'nobody' })).toBe(CHECK);
        expect(await insert({})).toBe('allowed');
        expect(await attempt(`UPDATE shipping.fleet_fees SET amount = 1`, [])).toBe(DENIED);
        expect(await attempt(`DELETE FROM shipping.fleet_fees`, [])).toBe(DENIED);
      });
    });

    describe('the fallback bookings', () => {
      const fallbackOf = (over: Partial<DeliveryFallbackRecord> = {}): DeliveryFallbackRecord => ({
        sellerOrderId: ids.next<'SellerOrder'>(),
        chargedFleet: 'mondapac_drive',
        bookedFleet: 'uber_direct',
        chargedQuote: money(1000n, currency),
        bookedPrice: money(1800n, currency),
        difference: money(800n, currency),
        capMinor: 1000,
        overCap: false,
        recordedAt: T0,
        ...over,
      });

      it('records the fallback of a seller order once', async () => {
        const row = fallbackOf();
        expect(await value(market, () => ledger.recordFallback(market, row))).toBe('recorded');
        expect(
          await value(market, () =>
            ledger.recordFallback(market, { ...row, bookedFleet: 'zoom2u' }),
          ),
        ).toBe('exists');
        expect(await value(other, () => ledger.recordFallback(other, row))).toBe('recorded');
      });

      it('keeps a booked price that could not be read as an over-cap record without amounts', async () => {
        const unknown = fallbackOf({ bookedPrice: null, difference: null, overCap: true });
        expect(await value(market, () => ledger.recordFallback(market, unknown))).toBe('recorded');
        const stored = await sql.query(
          `SELECT booked_price, difference, over_cap FROM shipping.delivery_fallbacks
         WHERE market_id = $1 AND seller_order_id = $2`,
          [market.marketId, unknown.sellerOrderId],
        );
        expect(stored.rows).toEqual([{ booked_price: null, difference: null, over_cap: true }]);
      });

      it('refuses what the application never writes, and never changes or removes a record', async () => {
        const insert = (over: {
          charged?: string;
          booked?: string;
          price?: number | null;
          difference?: number | null;
          overCap?: boolean;
        }) =>
          attempt(
            `INSERT INTO shipping.delivery_fallbacks (market_id, tenant_id, seller_order_id,
             charged_fleet, booked_fleet, charged_quote, booked_price, difference, cap_minor,
             over_cap, currency, recorded_at)
           VALUES ($1, $2, $3, $4, $5, 1000, $6, $7, 1000, $8, $9, now())`,
            [
              market.marketId,
              market.tenantId,
              ids.next(),
              over.charged ?? 'mondapac_drive',
              over.booked ?? 'uber_direct',
              over.price === undefined ? 1800 : over.price,
              over.difference === undefined ? 800 : over.difference,
              over.overCap ?? false,
              currency,
            ],
          );
        expect(await insert({ booked: 'mondapac_drive' })).toBe(CHECK);
        expect(await insert({ booked: 'nobody' })).toBe(CHECK);
        expect(await insert({ price: -1 })).toBe(CHECK);
        // An unknown booked price is always flagged for an admin.
        expect(await insert({ price: null, difference: null, overCap: false })).toBe(CHECK);
        expect(await insert({ price: null, difference: 5, overCap: true })).toBe(CHECK);
        expect(await insert({})).toBe('allowed');
        expect(await attempt(`UPDATE shipping.delivery_fallbacks SET over_cap = true`, [])).toBe(
          DENIED,
        );
        expect(await attempt(`DELETE FROM shipping.delivery_fallbacks`, [])).toBe(DENIED);
      });
    });
  },
);
