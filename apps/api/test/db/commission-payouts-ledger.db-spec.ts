import { money, ok, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { FixedClock } from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import type { LedgerEntry } from '../../src/modules/commission-payouts/domain/ledger';
import { PrismaLedgerRepository } from '../../src/modules/commission-payouts/infrastructure/prisma-ledger.repository';
import { PrismaSellerRateRepository } from '../../src/modules/commission-payouts/infrastructure/prisma-seller-rate.repository';
import { UuidV7IdGenerator } from '../../src/platform/ids/uuid-v7-id-generator';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { ownerTestDatabaseUrl, testDatabaseUrl } from './test-database';

// The commission-payouts stores as the application role, in both Market fixtures: a seller's own
// rate (insert, update, remove), and the seller ledger (append once, page, sum), which no role may
// change or delete, the owner included.

const T0 = Temporal.Instant.from('2026-10-14T10:00:00Z');
const CHECK = '23514';
const NO_PRIVILEGE = '42501';
const RESTRICT = '23001';

describe.each(TEST_MARKETS)('commission-payouts stores in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  const currency = code === 'AU' ? 'AUD' : 'JPY';
  const ids = new UuidV7IdGenerator(new FixedClock(T0));
  let db: Persistence;
  let rates: PrismaSellerRateRepository;
  let ledger: PrismaLedgerRepository;
  let sql: Client;
  let owner: Client;

  beforeAll(async () => {
    db = createPersistence();
    rates = new PrismaSellerRateRepository(db.service);
    ledger = new PrismaLedgerRepository(db.service);
    sql = new Client({ connectionString: testDatabaseUrl() });
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await sql.connect();
    await owner.connect();
  });
  afterAll(async () => {
    await db.close();
    await sql.end();
    await owner.end();
  });

  const value = async <T>(target: MarketContext, work: () => Promise<T>): Promise<T> => {
    const result = await db.unitOfWork.run(target, async () => ok(await work()));
    if (!result.ok) throw new Error('unit failed');
    return result.value;
  };
  const code_ = (promise: Promise<unknown>) =>
    promise.then(
      () => 'allowed',
      (error: { code?: string }) => error.code,
    );

  /** The rows of one paid seller order: two lines and a delivery fee. */
  const factOf = (sellerId: Id<'Seller'>, recordedAt = T0) => {
    const orderId = ids.next<'Order'>();
    const sellerOrderId = ids.next<'SellerOrder'>();
    const line1 = ids.next<'OrderLine'>();
    const line2 = ids.next<'OrderLine'>();
    const row = (
      kind: LedgerEntry['kind'],
      orderLineId: Id<'OrderLine'> | null,
      amount: bigint,
      rate: { rateBps: number; baseAmount: bigint } | null = null,
    ): LedgerEntry => ({
      id: ids.next<'LedgerEntry'>(),
      sellerId,
      orderId,
      sellerOrderId,
      orderLineId,
      kind,
      amount: money(amount, currency),
      rateBps: rate?.rateBps ?? null,
      baseAmount: rate?.baseAmount ?? null,
      occurredAt: T0,
      recordedAt,
    });
    return [
      row('sale', line1, 1100n),
      row('commission', line1, 150n, { rateBps: 1500, baseAmount: 1000n }),
      row('sale', line2, 335n),
      row('commission', line2, 46n, { rateBps: 1500, baseAmount: 305n }),
      row('shipping', null, 500n),
    ];
  };

  it("inserts a seller's rate, updates it, removes it, and never reads across Markets", async () => {
    const sellerId = ids.next<'Seller'>();
    const by = ids.next<'Account'>();
    const save = (rateBps: number, at: Temporal.Instant) =>
      value(market, () => rates.save(market, { sellerId, rateBps, updatedAt: at, updatedBy: by }));

    expect(await value(market, () => rates.find(market, sellerId))).toBeNull();
    await save(1000, T0);
    await save(2500, T0.add({ hours: 1 }));
    const read = await value(market, () => rates.find(market, sellerId));
    expect(read?.rateBps).toBe(2500);
    expect(read?.updatedAt.toString()).toBe(T0.add({ hours: 1 }).toString());
    expect(await value(market, () => rates.findMany(market, [sellerId, ids.next()]))).toHaveLength(
      1,
    );
    expect(await value(other, () => rates.find(other, sellerId))).toBeNull();
    expect(await value(other, () => rates.remove(other, sellerId))).toBe(false);

    expect(await value(market, () => rates.remove(market, sellerId))).toBe(true);
    expect(await value(market, () => rates.find(market, sellerId))).toBeNull();
    expect(
      await code_(
        sql.query(
          `INSERT INTO commission_payouts.seller_commission_rates (market_id, seller_id, tenant_id, rate_bps, updated_at, updated_by)
           VALUES ($1, $2, $3, 3001, now(), $4)`,
          [market.marketId, ids.next(), market.tenantId, ids.next()],
        ),
      ),
    ).toBe(CHECK);
  });

  it('appends a fact once, pages newest first and sums by kind, per seller and Market', async () => {
    const sellerId = ids.next<'Seller'>();
    const first = factOf(sellerId);
    const second = factOf(sellerId, T0.add({ minutes: 1 }));

    expect(await value(market, () => ledger.append(market, first))).toBe(5);
    // A replay of the same facts with new ids writes nothing: the key is (seller order, kind, line).
    const replay = first.map((row) => ({ ...row, id: ids.next<'LedgerEntry'>() }));
    expect(await value(market, () => ledger.append(market, replay))).toBe(0);
    expect(await value(market, () => ledger.append(market, second))).toBe(5);
    expect(await value(market, () => ledger.hasSellerOrder(market, first[0]!.sellerOrderId))).toBe(
      true,
    );

    const page = await value(market, () =>
      ledger.list(market, sellerId, { limit: 6, after: null }),
    );
    expect(page).toHaveLength(6);
    expect(page.slice(0, 5).every((row) => row.sellerOrderId === second[0]!.sellerOrderId)).toBe(
      true,
    );
    const last = page[5]!;
    const rest = await value(market, () =>
      ledger.list(market, sellerId, {
        limit: 10,
        after: { recordedAt: last.recordedAt, id: last.id },
      }),
    );
    expect(rest).toHaveLength(4);
    expect(new Set([...page, ...rest].map((row) => row.id)).size).toBe(10);
    expect(
      page.find(
        (row) => row.kind === 'commission' && row.rateBps === 1500 && row.amount.amount === 46n,
      ),
    ).toMatchObject({
      rateBps: 1500,
      amount: money(46n, currency),
      baseAmount: 305n,
    });

    const sums = await value(market, () => ledger.sums(market, sellerId));
    expect(Object.fromEntries(sums.map((s) => [s.kind, s.amount]))).toEqual({
      sale: 2870n,
      commission: 392n,
      shipping: 1000n,
    });
    expect(
      await value(other, () => ledger.list(other, sellerId, { limit: 10, after: null })),
    ).toEqual([]);
    expect(await value(other, () => ledger.sums(other, sellerId))).toEqual([]);
  });

  it('refuses any change or delete of a ledger row, by the application and by the owner', async () => {
    const rows = factOf(ids.next<'Seller'>());
    await value(market, () => ledger.append(market, rows));
    const target = rows[0]!.id;

    expect(
      await code_(
        sql.query(`UPDATE commission_payouts.ledger_entries SET amount = 1 WHERE id = $1`, [
          target,
        ]),
      ),
    ).toBe(NO_PRIVILEGE);
    expect(
      await code_(
        sql.query(`DELETE FROM commission_payouts.ledger_entries WHERE id = $1`, [target]),
      ),
    ).toBe(NO_PRIVILEGE);
    expect(
      await code_(
        owner.query(`UPDATE commission_payouts.ledger_entries SET amount = 1 WHERE id = $1`, [
          target,
        ]),
      ),
    ).toBe(RESTRICT);
    expect(
      await code_(
        owner.query(`DELETE FROM commission_payouts.ledger_entries WHERE id = $1`, [target]),
      ),
    ).toBe(RESTRICT);
    expect(await code_(owner.query(`TRUNCATE commission_payouts.ledger_entries`))).toBe(RESTRICT);
  });

  it('refuses rows that do not fit their kind', async () => {
    const insert = (
      kind: string,
      line: boolean,
      amount: number,
      rate: number | null,
      base: number | null,
    ) =>
      code_(
        sql.query(
          `INSERT INTO commission_payouts.ledger_entries (id, market_id, tenant_id, seller_id, order_id, seller_order_id, order_line_id, kind, amount, currency, rate_bps, base_amount, occurred_at, recorded_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now(), now())`,
          [
            ids.next(),
            market.marketId,
            market.tenantId,
            ids.next(),
            ids.next(),
            ids.next(),
            line ? ids.next() : null,
            kind,
            amount,
            currency,
            rate,
            base,
          ],
        ),
      );

    expect(await insert('sale', true, 0, null, null)).toBe(CHECK);
    expect(await insert('sale', true, -5, null, null)).toBe(CHECK);
    expect(await insert('shipping', true, 500, null, null)).toBe(CHECK);
    expect(await insert('sale', false, 500, null, null)).toBe(CHECK);
    expect(await insert('sale', true, 500, 1500, 400)).toBe(CHECK);
    expect(await insert('commission', true, 50, null, null)).toBe(CHECK);
    expect(await insert('commission', true, 50, 3001, 1000)).toBe(CHECK);
    expect(await insert('commission', true, 500, 1500, 400)).toBe(CHECK);
    expect(await insert('refund', true, 50, null, null)).toBe(CHECK);
    expect(await insert('commission', true, 0, 0, 1000)).toBe('allowed');
    expect(await insert('sale', true, 1, null, null)).toBe('allowed');
  });
});
