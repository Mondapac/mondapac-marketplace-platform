import { randomUUID } from 'node:crypto';
import { money, ok, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import {
  DISPUTE_SORT_KEYS,
  type DisputeListFilter,
} from '../../src/modules/commission-payouts/domain/admin-dispute-list';
import type { DisputeCase } from '../../src/modules/commission-payouts/domain/dispute';
import type { LedgerEntry } from '../../src/modules/commission-payouts/domain/ledger';
import { PrismaAdminDisputeListReader } from '../../src/modules/commission-payouts/infrastructure/prisma-admin-dispute-list.reader';
import { PrismaDisputeRepository } from '../../src/modules/commission-payouts/infrastructure/prisma-dispute.repository';
import { PrismaLedgerRepository } from '../../src/modules/commission-payouts/infrastructure/prisma-ledger.repository';
import { MarketLedger, MemoryDisputes } from '../support/commission-payouts-dispute-fakes';
import { MemoryAdminDisputeList } from '../support/commission-payouts-dispute-list-fakes';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';

// The admin Disputes list (super list 23) on PostgreSQL, as the application role, for both Market
// fixtures: each filter (the money state as stored flags), the sorts with their tie and the
// evidence deadline's nulls, the Previous/Next cursor over one instant, the bucket counts, the
// disputed orders of a seller from the ledger, and that another Market's cases never show. Other
// files write cases into the same database, so every read is scoped to this file's own orders.

const T0 = Temporal.Instant.from('2026-11-03T00:00:00Z');
const CURRENCY = { AU: 'AUD', ZZ: 'JPY' } as const;
const NO_FILTER: DisputeListFilter = {
  bucket: null,
  status: null,
  moneyState: null,
  caseOrOrderId: null,
  from: null,
  to: null,
  dueBefore: null,
  minAmount: null,
  maxAmount: null,
  orderIds: null,
};
const NEWEST = { key: 'opened', direction: 'desc' } as const;

describe.each(TEST_MARKETS)('the admin Disputes list in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  let db: Persistence;
  let reader: PrismaAdminDisputeListReader;
  let disputes: PrismaDisputeRepository;
  let ledger: PrismaLedgerRepository;

  beforeAll(() => {
    db = createPersistence();
    reader = new PrismaAdminDisputeListReader(db.service);
    disputes = new PrismaDisputeRepository(db.service);
    ledger = new PrismaLedgerRepository(db.service);
  });
  afterAll(async () => {
    await db.close();
  });

  const write = async <T>(target: MarketContext, work: () => Promise<T>): Promise<T> => {
    const result = await db.unitOfWork.run(target, async () => ok(await work()));
    if (!result.ok) throw new Error('unit failed');
    return result.value;
  };
  const value = async <T>(target: MarketContext, work: () => Promise<T>): Promise<T> => {
    const result = await db.unitOfWork.run(target, async () => ok(await work()), {
      readOnly: true,
    });
    if (!result.ok) throw new Error('unit failed');
    return result.value;
  };
  const currencyOf = (target: MarketContext) =>
    target === market ? CURRENCY[code] : code === 'AU' ? CURRENCY.ZZ : CURRENCY.AU;

  /** One case of its own order, with a seller order of `sellerId` in the ledger. */
  async function caseOf(
    fields: Partial<DisputeCase> & {
      readonly sellerId?: Id<'Seller'>;
      readonly target?: MarketContext;
    } = {},
  ): Promise<DisputeCase> {
    const { sellerId, target = market, ...rest } = fields;
    const at = rest.openedAt ?? T0;
    const c: DisputeCase = {
      disputeId: randomUUID() as Id<'Dispute'>,
      orderId: randomUUID() as Id<'Order'>,
      providerDisputeId: 'dp_list',
      amount: money(2000n, currencyOf(target)),
      status: 'needs_response',
      inquiry: false,
      closed: false,
      outcome: null,
      reason: 'fraudulent',
      evidenceDueBy: null,
      fundsWithdrawn: false,
      fundsWithdrawnAt: null,
      fundsReinstated: false,
      fundsReinstatedAt: null,
      openedAt: at,
      closedAt: null,
      bucket: 'needs-response',
      lastSyncedVersion: 1,
      createdAt: at,
      updatedAt: at,
      ...rest,
    };
    expect(await write(target, () => disputes.insert(target, c))).toBe(true);
    if (sellerId !== undefined) {
      const entry: LedgerEntry = {
        id: randomUUID() as Id<'LedgerEntry'>,
        sellerId,
        orderId: c.orderId,
        sellerOrderId: randomUUID() as Id<'SellerOrder'>,
        orderLineId: randomUUID() as Id<'OrderLine'>,
        kind: 'sale',
        amount: money(1000n, currencyOf(target)),
        rateBps: null,
        baseAmount: null,
        sourceId: null,
        occurredAt: at,
        recordedAt: at,
      };
      await write(target, () => ledger.append(target, [entry]));
    }
    return c;
  }

  it('filters by bucket, status, money, ids, dates, deadline and amount, Market-scoped', async () => {
    const a = await caseOf({ evidenceDueBy: T0.add({ hours: 24 }) });
    const b = await caseOf({
      openedAt: T0.add({ hours: 1 }),
      bucket: 'under-review',
      status: 'under_review',
      inquiry: true,
      amount: money(5000n, CURRENCY[code]),
    });
    const c = await caseOf({
      openedAt: T0.add({ hours: 2 }),
      bucket: 'won',
      status: 'won',
      closed: true,
      outcome: 'won',
      fundsWithdrawn: true,
      fundsWithdrawnAt: T0.add({ hours: 2 }),
      fundsReinstated: true,
      fundsReinstatedAt: T0.add({ hours: 2 }),
      closedAt: T0.add({ hours: 2 }),
    });
    const d = await caseOf({
      openedAt: T0.add({ hours: 3 }),
      bucket: 'decision-needed',
      status: 'lost',
      closed: true,
      outcome: 'lost',
      fundsWithdrawn: true,
      fundsWithdrawnAt: T0.add({ hours: 3 }),
      closedAt: T0.add({ hours: 3 }),
    });
    const foreign = await caseOf({ target: other });
    const mine = { ...NO_FILTER, orderIds: [a, b, c, d, foreign].map((x) => x.orderId) };
    const found = async (fields: Partial<DisputeListFilter>) =>
      (await value(market, () => reader.page(market, { ...mine, ...fields }, NEWEST, 0, 20))).map(
        (row) => row.disputeId,
      );
    expect(await found({})).toEqual([d, c, b, a].map((x) => x.disputeId));
    expect(await found({ bucket: 'won' })).toEqual([c.disputeId]);
    expect(await found({ status: 'lost' })).toEqual([d.disputeId]);
    expect(await found({ moneyState: 'reinstated' })).toEqual([c.disputeId]);
    expect(await found({ moneyState: 'withdrawn' })).toEqual([d.disputeId]);
    expect(await found({ moneyState: 'inquiry' })).toEqual([b.disputeId]);
    expect(await found({ moneyState: 'none' })).toEqual([a.disputeId]);
    expect(await found({ caseOrOrderId: a.disputeId })).toEqual([a.disputeId]);
    expect(await found({ caseOrOrderId: b.orderId })).toEqual([b.disputeId]);
    expect(await found({ caseOrOrderId: foreign.disputeId })).toEqual([]);
    expect(await found({ from: T0.add({ hours: 1 }), to: T0.add({ hours: 3 }) })).toEqual([
      c.disputeId,
      b.disputeId,
    ]);
    expect(await found({ dueBefore: T0.add({ hours: 48 }) })).toEqual([a.disputeId]);
    expect(await found({ minAmount: 3000n })).toEqual([b.disputeId]);
    expect(await found({ maxAmount: 2000n })).toEqual([d, c, a].map((x) => x.disputeId));
    expect(await value(market, () => reader.count(market, mine))).toBe(4);
    const counts = await value(market, () => reader.countByBucket(market));
    expect(counts.won).toBeGreaterThanOrEqual(1);
    expect(counts['decision-needed']).toBeGreaterThanOrEqual(1);
    expect(
      (await value(market, () => reader.byIds(market, [a.disputeId, foreign.disputeId]))).map(
        (x) => x.disputeId,
      ),
    ).toEqual([a.disputeId]);
  });

  it("finds a seller's disputed orders from the ledger, never another Market's", async () => {
    const seller = randomUUID() as Id<'Seller'>;
    const one = await caseOf({ sellerId: seller });
    const two = await caseOf({ sellerId: seller, openedAt: T0.add({ minutes: 1 }) });
    await caseOf({ sellerId: randomUUID() as Id<'Seller'> });
    await caseOf({ sellerId: seller, target: other });
    const orders = await value(market, () => reader.disputedOrdersOfSellers(market, [seller], 100));
    expect([...orders].sort()).toEqual([one.orderId, two.orderId].sort());
    expect(await value(market, () => reader.disputedOrdersOfSellers(market, [], 100))).toEqual([]);
  });

  it('walks the disputed orders in chunks and stops at the limit', async () => {
    const seller = randomUUID() as Id<'Seller'>;
    const mine: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      mine.push((await caseOf({ sellerId: seller, openedAt: T0.add({ minutes: i }) })).orderId);
      await caseOf({ sellerId: randomUUID() as Id<'Seller'>, openedAt: T0.add({ minutes: i }) });
    }
    mine.sort();
    // A chunk of 2 ids per query: every one of the seller's orders is found across chunks.
    const small = new PrismaAdminDisputeListReader(db.service, 2);
    const all = await value(market, () => small.disputedOrdersOfSellers(market, [seller], 100));
    expect([...all]).toEqual(mine);
    // The limit stops the walk with the first orders in order id order.
    const three = await value(market, () => small.disputedOrdersOfSellers(market, [seller], 3));
    expect([...three]).toEqual(mine.slice(0, 3));
  });

  it('walks the Previous/Next cursor newest opened first across a tie', async () => {
    const at = T0.add({ hours: 10 });
    const older = await caseOf({ openedAt: T0.add({ hours: 9 }) });
    const tied = [await caseOf({ openedAt: at }), await caseOf({ openedAt: at })].sort((x, y) =>
      x.disputeId < y.disputeId ? 1 : -1,
    );
    const mine = { ...NO_FILTER, orderIds: [older, ...tied].map((x) => x.orderId) };
    const first = await value(market, () => reader.page(market, mine, NEWEST, 0, 1));
    expect(first.map((x) => x.disputeId)).toEqual([tied[0]!.disputeId]);
    const rest = await value(market, () =>
      reader.page(market, mine, NEWEST, 0, 5, {
        openedAt: first[0]!.openedAt,
        disputeId: first[0]!.disputeId,
      }),
    );
    expect(rest.map((x) => x.disputeId)).toEqual([tied[1]!.disputeId, older.disputeId]);
  });

  it('orders every sort as the in-memory fake does (the fake the flow tests trust)', async () => {
    const at = T0.add({ hours: 20 });
    const made = [
      await caseOf({ openedAt: at, amount: money(300n, CURRENCY[code]) }),
      await caseOf({
        openedAt: at,
        amount: money(300n, CURRENCY[code]),
        evidenceDueBy: at.add({ hours: 5 }),
        updatedAt: at.add({ hours: 9 }),
      }),
      await caseOf({
        openedAt: at.add({ minutes: 1 }),
        amount: money(100n, CURRENCY[code]),
        evidenceDueBy: at.add({ hours: 1 }),
      }),
      await caseOf({ openedAt: at.add({ minutes: 2 }), evidenceDueBy: at.add({ hours: 1 }) }),
    ];
    const mine = { ...NO_FILTER, orderIds: made.map((x) => x.orderId) };
    const memory = new MemoryDisputes(new MarketLedger());
    for (const c of await value(market, () =>
      reader.byIds(
        market,
        made.map((x) => x.disputeId),
      ),
    )) {
      memory.cases.set(`${market.marketId}:${c.disputeId}`, c);
    }
    const fake = new MemoryAdminDisputeList(memory, new MarketLedger());
    for (const direction of ['asc', 'desc'] as const) {
      for (const key of DISPUTE_SORT_KEYS) {
        const sort = { key, direction };
        const real = await value(market, () => reader.idsPage(market, mine, sort, 10));
        expect([key, direction, real]).toEqual([
          key,
          direction,
          await fake.idsPage(market, mine, sort, 10),
        ]);
      }
    }
  });
});
