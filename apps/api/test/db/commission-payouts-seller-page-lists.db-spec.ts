import { randomUUID } from 'node:crypto';
import { money, ok, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PayoutHoldRecord } from '../../src/modules/commission-payouts/application/ports/payout-hold.repository';
import type { LedgerEntry } from '../../src/modules/commission-payouts/domain/ledger';
import {
  HOLD_SORT_KEYS,
  LEDGER_SORT_KEYS,
  type HoldListFilter,
  type HoldSort,
  type LedgerListFilter,
} from '../../src/modules/commission-payouts/domain/seller-page-lists';
import { PrismaLedgerRepository } from '../../src/modules/commission-payouts/infrastructure/prisma-ledger.repository';
import { PrismaPayoutHoldRepository } from '../../src/modules/commission-payouts/infrastructure/prisma-payout-hold.repository';
import { PrismaSellerPageListReader } from '../../src/modules/commission-payouts/infrastructure/prisma-seller-page-list.reader';
import { MemorySellerPageLists } from '../support/commission-payouts-seller-page-fakes';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';

// The seller page's two lists (super lists 27 and 28) on PostgreSQL, as the application role,
// for both Market fixtures: the filters, the sorts with their tie, the Previous/Next cursor over
// one instant and across two, the counts, the reads by id, and that another seller's or another
// Market's rows never show. Every seller is this file's own, so the counts are exact.

const T0 = Temporal.Instant.from('2026-11-03T00:00:00Z');
const CURRENCY = { AU: 'AUD', ZZ: 'JPY' } as const;

describe.each(TEST_MARKETS)('the seller page lists in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  let db: Persistence;
  let reader: PrismaSellerPageListReader;
  let ledger: PrismaLedgerRepository;
  let holds: PrismaPayoutHoldRepository;

  beforeAll(() => {
    db = createPersistence();
    reader = new PrismaSellerPageListReader(db.service);
    ledger = new PrismaLedgerRepository(db.service);
    holds = new PrismaPayoutHoldRepository(db.service);
  });
  afterAll(async () => {
    await db.close();
  });

  const write = async <T>(target: MarketContext, work: () => Promise<T>): Promise<T> => {
    const result = await db.unitOfWork.run(target, async () => ok(await work()));
    if (!result.ok) throw new Error('unit failed');
    return result.value;
  };
  const read = async <T>(target: MarketContext, work: () => Promise<T>): Promise<T> => {
    const result = await db.unitOfWork.run(target, async () => ok(await work()), {
      readOnly: true,
    });
    if (!result.ok) throw new Error('unit failed');
    return result.value;
  };
  const seller = () => randomUUID() as Id<'Seller'>;

  async function entryOf(
    sellerId: Id<'Seller'>,
    fields: {
      readonly kind?: 'sale' | 'shipping';
      readonly amount?: bigint;
      readonly at?: Temporal.Instant;
      readonly occurred?: Temporal.Instant;
      readonly target?: MarketContext;
    } = {},
  ): Promise<LedgerEntry> {
    const target = fields.target ?? market;
    const at = fields.at ?? T0;
    const kind = fields.kind ?? 'sale';
    const entry: LedgerEntry = {
      id: randomUUID() as Id<'LedgerEntry'>,
      sellerId,
      orderId: randomUUID() as Id<'Order'>,
      sellerOrderId: randomUUID() as Id<'SellerOrder'>,
      orderLineId: kind === 'shipping' ? null : (randomUUID() as Id<'OrderLine'>),
      kind,
      amount: money(fields.amount ?? 1000n, CURRENCY[target.marketId as 'AU' | 'ZZ']),
      rateBps: null,
      baseAmount: null,
      sourceId: null,
      occurredAt: fields.occurred ?? at,
      recordedAt: at,
    };
    expect(await write(target, () => ledger.append(target, [entry]))).toBe(1);
    return entry;
  }

  const ledgerFilter = (sellerId: Id<'Seller'>, fields: Partial<LedgerListFilter> = {}) => ({
    sellerId,
    kinds: null,
    reference: null,
    from: null,
    to: null,
    minAmount: null,
    maxAmount: null,
    ...fields,
  });

  it('filters, sorts and counts one seller ledger, Market-scoped', async () => {
    const s = seller();
    const sale = await entryOf(s, { amount: 500n, at: T0 });
    const ship = await entryOf(s, { kind: 'shipping', amount: 900n, at: T0.add({ hours: 1 }) });
    await entryOf(seller(), { at: T0 });
    const elsewhere = await entryOf(s, { target: other });
    const ids = async (fields: Partial<LedgerListFilter>, key = 'recorded' as const) =>
      (
        await read(market, () =>
          reader.ledgerPage(market, ledgerFilter(s, fields), { key, direction: 'desc' }, 0, 10),
        )
      ).map((e) => e.id);
    expect(await ids({})).toEqual([ship.id, sale.id]);
    expect(await ids({ kinds: ['shipping'] })).toEqual([ship.id]);
    expect(await ids({ reference: sale.orderId })).toEqual([sale.id]);
    expect(await ids({ reference: ship.sellerOrderId })).toEqual([ship.id]);
    expect(await ids({ from: T0.add({ minutes: 1 }) })).toEqual([ship.id]);
    expect(await ids({ to: T0.add({ minutes: 1 }) })).toEqual([sale.id]);
    expect(await ids({ minAmount: 600n, maxAmount: 900n })).toEqual([ship.id]);
    expect(await read(market, () => reader.ledgerCount(market, ledgerFilter(s)))).toBe(2);
    const amountAsc = await read(market, () =>
      reader.ledgerPage(market, ledgerFilter(s), { key: 'amount', direction: 'asc' }, 0, 10),
    );
    expect(amountAsc.map((e) => e.id)).toEqual([sale.id, ship.id]);
    expect(amountAsc[0]).toMatchObject({ amount: { amount: 500n }, kind: 'sale' });
    expect(
      await read(market, () =>
        reader.ledgerIds(market, ledgerFilter(s), { key: 'occurred', direction: 'asc' }, 1),
      ),
    ).toEqual([sale.id]);
    expect(
      (await read(market, () => reader.ledgerByIds(market, s, [sale.id, elsewhere.id]))).map(
        (e) => e.id,
      ),
    ).toEqual([sale.id]);
    expect(await read(other, () => reader.ledgerByIds(other, s, [sale.id]))).toEqual([]);
  });

  it('walks the ledger cursor over one instant and across two, ties by id', async () => {
    const s = seller();
    const older = await entryOf(s, { at: T0.add({ hours: 4 }) });
    const tied = [
      await entryOf(s, { at: T0.add({ hours: 5 }) }),
      await entryOf(s, { at: T0.add({ hours: 5 }) }),
    ].sort((x, y) => (x.id < y.id ? 1 : -1));
    const newest = { key: 'recorded', direction: 'desc' } as const;
    const first = await read(market, () =>
      reader.ledgerPage(market, ledgerFilter(s), newest, 0, 1),
    );
    expect(first.map((e) => e.id)).toEqual([tied[0]!.id]);
    const rest = await read(market, () =>
      reader.ledgerPage(market, ledgerFilter(s), newest, 0, 5, {
        recordedAt: first[0]!.recordedAt,
        entryId: first[0]!.id,
      }),
    );
    expect(rest.map((e) => e.id)).toEqual([tied[1]!.id, older.id]);
    const asc = await read(market, () =>
      reader.ledgerPage(market, ledgerFilter(s), { key: 'amount', direction: 'asc' }, 0, 5),
    );
    expect(asc.map((e) => e.id)).toEqual([older, ...tied].map((e) => e.id).sort());
  });

  const holdOf = (sellerId: Id<'Seller'>, fields: Partial<PayoutHoldRecord> = {}) => {
    const holdId = randomUUID() as Id<'PayoutHold'>;
    const record: PayoutHoldRecord = {
      id: holdId,
      sellerId,
      sellerOrderId: null,
      reason: 'admin-review',
      origin: 'admin',
      sourceRef: holdId,
      placedBy: randomUUID() as Id<'Account'>,
      placedAt: T0,
      releasedAt: null,
      releasedBy: null,
      releaseReason: null,
      ...fields,
    };
    return write(market, () => holds.insertIfAbsent(market, record)).then(() => record);
  };
  const holdFilter = (sellerId: Id<'Seller'>, fields: Partial<HoldListFilter> = {}) => ({
    sellerId,
    status: null,
    reason: null,
    origin: null,
    scope: null,
    sellerOrderId: null,
    from: null,
    to: null,
    ...fields,
  });

  it('lists one seller holds active first, filters them and counts them per status', async () => {
    const s = seller();
    const order = randomUUID() as Id<'SellerOrder'>;
    const oldActive = await holdOf(s, { placedAt: T0 });
    const done = await holdOf(s, { placedAt: T0.add({ hours: 2 }) });
    await write(market, () =>
      holds.release(market, done.id, {
        releasedAt: T0.add({ hours: 3 }),
        releasedBy: randomUUID() as Id<'Account'>,
        reason: 'resolved',
      }),
    );
    const onOrder = await holdOf(s, {
      placedAt: T0.add({ hours: 1 }),
      sellerOrderId: order,
      origin: 'system',
      reason: 'refund-pending',
      placedBy: null,
    });
    await holdOf(seller());
    const ids = async (
      fields: Partial<HoldListFilter>,
      key: HoldSort['key'] = 'active-first',
      direction = 'desc' as 'asc' | 'desc',
    ) =>
      (
        await read(market, () =>
          reader.holdPage(market, holdFilter(s, fields), { key, direction }, 0, 10),
        )
      ).map((h) => h.id);
    expect(await ids({})).toEqual([onOrder.id, oldActive.id, done.id]);
    expect(await ids({}, 'active-first', 'asc')).toEqual([done.id, oldActive.id, onOrder.id]);
    expect(await ids({ status: 'released' })).toEqual([done.id]);
    expect(await ids({ status: 'active' })).toEqual([onOrder.id, oldActive.id]);
    expect(await ids({ scope: 'order' })).toEqual([onOrder.id]);
    expect(await ids({ scope: 'seller' })).toEqual([oldActive.id, done.id]);
    expect(await ids({ sellerOrderId: order })).toEqual([onOrder.id]);
    expect(await ids({ sellerOrderId: order, scope: 'seller' })).toEqual([]);
    expect(await ids({ origin: 'system', reason: 'refund-pending' })).toEqual([onOrder.id]);
    expect(await ids({ from: T0.add({ minutes: 30 }) })).toEqual([onOrder.id, done.id]);
    // Unreleased last in both directions; the parity test below pins the whole order.
    expect((await ids({}, 'released'))[0]).toBe(done.id);
    expect((await ids({}, 'released', 'asc'))[0]).toBe(done.id);
    expect(await read(market, () => reader.holdCounts(market, s))).toEqual({
      active: 2,
      released: 1,
    });
    expect(
      await read(market, () => reader.holdCount(market, holdFilter(s, { status: 'active' }))),
    ).toBe(2);
    expect(
      await read(market, () =>
        reader.holdIds(market, holdFilter(s), { key: 'placed', direction: 'asc' }, 2),
      ),
    ).toEqual([oldActive.id, onOrder.id]);
    expect(
      (await read(market, () => reader.holdByIds(market, s, [done.id]))).map((h) => h.id),
    ).toEqual([done.id]);
    expect(await read(other, () => reader.holdByIds(other, s, [done.id]))).toEqual([]);
    expect(await read(other, () => reader.holdCounts(other, s))).toEqual({
      active: 0,
      released: 0,
    });
  });

  it('walks the holds cursor newest placement first across two instants', async () => {
    const s = seller();
    const older = await holdOf(s, { placedAt: T0.add({ hours: 7 }) });
    const tied = [
      await holdOf(s, { placedAt: T0.add({ hours: 8 }) }),
      await holdOf(s, { placedAt: T0.add({ hours: 8 }) }),
    ].sort((x, y) => (x.id < y.id ? 1 : -1));
    const newest = { key: 'placed', direction: 'desc' } as const;
    const first = await read(market, () => reader.holdPage(market, holdFilter(s), newest, 0, 1));
    const rest = await read(market, () =>
      reader.holdPage(market, holdFilter(s), newest, 0, 5, {
        placedAt: first[0]!.placedAt,
        holdId: first[0]!.id,
      }),
    );
    expect([...first, ...rest].map((h) => h.id)).toEqual([tied[0]!.id, tied[1]!.id, older.id]);
  });

  it('orders every sort as the in-memory fake does (the fake the flow tests trust)', async () => {
    const s = seller();
    // Ledger: recorded and occurred in reverse orders, two amounts tied.
    const entries = [
      await entryOf(s, { amount: 700n, at: T0.add({ hours: 1 }), occurred: T0.add({ hours: 9 }) }),
      await entryOf(s, { amount: 300n, at: T0.add({ hours: 2 }), occurred: T0.add({ hours: 8 }) }),
      await entryOf(s, { amount: 300n, at: T0.add({ hours: 3 }), occurred: T0.add({ hours: 7 }) }),
      await entryOf(s, { amount: 900n, at: T0.add({ hours: 3 }), occurred: T0.add({ hours: 7 }) }),
    ];
    // Holds: two active (one tied placement), two released in the reverse of their placement.
    const placed = [1, 2, 2, 3, 4].map((hours) => T0.add({ hours }));
    const made: PayoutHoldRecord[] = [];
    for (const at of placed) made.push(await holdOf(s, { placedAt: at }));
    for (const [index, hours] of [
      [3, 9],
      [4, 6],
    ] as const) {
      const releasedAt = T0.add({ hours });
      const releasedBy = randomUUID() as Id<'Account'>;
      await write(market, () =>
        holds.release(market, made[index]!.id, { releasedAt, releasedBy, reason: 'resolved' }),
      );
      made[index] = { ...made[index]!, releasedAt, releasedBy, releaseReason: 'resolved' };
    }
    const fake = new MemorySellerPageLists(
      (m) => (m.marketId === market.marketId ? entries : []),
      (m) => (m.marketId === market.marketId ? made : []),
    );
    for (const direction of ['asc', 'desc'] as const) {
      for (const key of LEDGER_SORT_KEYS) {
        const sort = { key, direction };
        const real = await read(market, () => reader.ledgerIds(market, ledgerFilter(s), sort, 10));
        expect([key, direction, real]).toEqual([
          key,
          direction,
          await fake.ledgerIds(market, ledgerFilter(s), sort, 10),
        ]);
      }
      for (const key of HOLD_SORT_KEYS) {
        const sort = { key, direction };
        const real = await read(market, () => reader.holdIds(market, holdFilter(s), sort, 10));
        expect([key, direction, real]).toEqual([
          key,
          direction,
          await fake.holdIds(market, holdFilter(s), sort, 10),
        ]);
      }
    }
  });
});
