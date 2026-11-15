import { randomUUID } from 'node:crypto';
import { ok, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PayoutHoldRecord } from '../../src/modules/commission-payouts/application/ports/payout-hold.repository';
import type {
  PayoutListFilter,
  PayoutSort,
} from '../../src/modules/commission-payouts/domain/admin-payout-list';
import {
  moveTo,
  openPayout,
  type Payout,
} from '../../src/modules/commission-payouts/domain/payout';
import { PrismaAdminPayoutListReader } from '../../src/modules/commission-payouts/infrastructure/prisma-admin-payout-list.reader';
import { PrismaPayoutHoldRepository } from '../../src/modules/commission-payouts/infrastructure/prisma-payout-hold.repository';
import { PrismaPayoutRepository } from '../../src/modules/commission-payouts/infrastructure/prisma-payout.repository';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';

// The admin Payouts list (super list 21) on PostgreSQL, as the application role, for both Market
// fixtures: each filter, the sorts with their tie, the Previous/Next cursor over one instant, the
// per-state counts, the export read by ids and the active admin holds of the Release action, and
// that another Market's payouts never show. Other files write payouts into the same database, so
// every read is scoped to this file's own sellers and the counts are compared with a lower bound.

const T0 = Temporal.Instant.from('2026-11-02T00:00:00Z');
const CURRENCY = { AU: 'AUD', ZZ: 'JPY' } as const;

const NO_FILTER: PayoutListFilter = {
  states: null,
  state: null,
  payoutId: null,
  sellerId: null,
  approvalMode: null,
  from: null,
  to: null,
  minAmount: null,
  maxAmount: null,
  sellerIds: null,
};
const NEWEST: PayoutSort = { key: 'created', direction: 'desc' };

describe.each(TEST_MARKETS)('the admin Payouts list in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  const currency = CURRENCY[code];
  let db: Persistence;
  let reader: PrismaAdminPayoutListReader;
  let payouts: PrismaPayoutRepository;
  let holds: PrismaPayoutHoldRepository;

  beforeAll(() => {
    db = createPersistence();
    reader = new PrismaAdminPayoutListReader(db.service);
    payouts = new PrismaPayoutRepository(db.service);
    holds = new PrismaPayoutHoldRepository(db.service);
  });
  afterAll(async () => {
    await db.close();
  });

  const value = async <T>(target: MarketContext, work: () => Promise<T>): Promise<T> => {
    const result = await db.unitOfWork.run(target, async () => ok(await work()));
    if (!result.ok) throw new Error('unit failed');
    return result.value;
  };
  const seller = () => randomUUID() as Id<'Seller'>;

  /**
   * One payout of a seller of its own: MANUAL waits for approval, AUTO is instructing; `to` walks
   * it on along the state machine, each step a minute later.
   */
  async function payoutOf(
    sellerId: Id<'Seller'>,
    fields: {
      readonly amount?: bigint;
      readonly at?: Temporal.Instant;
      readonly mode?: 'AUTO' | 'MANUAL';
      readonly to?: readonly Payout['state'][];
      readonly target?: MarketContext;
    } = {},
  ): Promise<Payout> {
    const target = fields.target ?? market;
    const at = fields.at ?? T0;
    const amount = fields.amount ?? 10000n;
    let payout = openPayout({
      id: randomUUID() as Id<'Payout'>,
      sellerId,
      currency: target === market ? currency : code === 'AU' ? CURRENCY.ZZ : CURRENCY.AU,
      items: [{ sellerOrderId: randomUUID() as Id<'SellerOrder'>, amount }],
      netted: 0n,
      approvalMode: fields.mode ?? 'AUTO',
      firstPayout: false,
      minimum: 1n,
      slotAt: at,
      now: at,
    });
    await value(target, () =>
      payouts.insert(target, payout, [
        { sellerOrderId: randomUUID() as Id<'SellerOrder'>, amount },
      ]),
    );
    let step = 0;
    for (const state of fields.to ?? []) {
      step += 1;
      const next = moveTo(payout, state, at.add({ minutes: step }), {
        ...(state === 'instructed' ? { transferExecutionId: randomUUID() } : {}),
        ...(state === 'not-sent' || state === 'failed' ? { outcomeCode: 'test.refused' } : {}),
      });
      const before = payout;
      expect(await value(target, () => payouts.change(target, before, next))).toBe(true);
      payout = next;
    }
    return payout;
  }

  it('filters by view and state, payout id, seller, mode, creation time and amount, Market-scoped', async () => {
    const a = seller();
    const b = seller();
    const waiting = await payoutOf(a, { mode: 'MANUAL', amount: 5000n, at: T0 });
    const paid = await payoutOf(b, {
      amount: 20000n,
      at: T0.add({ hours: 1 }),
      to: ['instructed', 'paid'],
    });
    await payoutOf(a, { target: other, at: T0 });
    const mine = { ...NO_FILTER, sellerIds: [a, b] };
    const page = (filter: Partial<PayoutListFilter>) =>
      value(market, () => reader.page(market, { ...mine, ...filter }, NEWEST, 0, 50));
    const idsOf = async (filter: Partial<PayoutListFilter>) =>
      (await page(filter)).map((p) => p.id);

    expect(await idsOf({})).toEqual([paid.id, waiting.id]);
    expect(await idsOf({ states: ['awaiting-approval'] })).toEqual([waiting.id]);
    expect(await idsOf({ states: ['awaiting-approval'], state: 'paid' })).toEqual([]);
    expect(await idsOf({ payoutId: paid.id })).toEqual([paid.id]);
    expect(await idsOf({ sellerId: a })).toEqual([waiting.id]);
    expect(await idsOf({ approvalMode: 'MANUAL' })).toEqual([waiting.id]);
    expect(await idsOf({ from: T0.add({ minutes: 1 }) })).toEqual([paid.id]);
    expect(await idsOf({ to: T0.add({ minutes: 1 }) })).toEqual([waiting.id]);
    expect(await idsOf({ minAmount: 5000n, maxAmount: 5000n })).toEqual([waiting.id]);
    expect(await idsOf({ sellerIds: [] })).toEqual([]);
    expect(await value(market, () => reader.count(market, mine))).toBe(2);
    // The row maps back to the domain payout, money and all.
    expect((await page({ payoutId: paid.id }))[0]).toMatchObject({
      state: 'paid',
      transfer: 20000n,
      currency,
      sellerId: b,
    });
    // Another Market never sees these payouts, even by id.
    expect(await value(other, () => reader.byIds(other, [waiting.id, paid.id]))).toEqual([]);
  });

  it('sorts by amount, state change and slot with the id breaking ties, and walks the cursor over one instant', async () => {
    const sellers = [seller(), seller(), seller(), seller()];
    const made: Payout[] = [];
    for (const [index, sellerId] of sellers.entries()) {
      made.push(
        await payoutOf(sellerId, { amount: index < 2 ? 700n : 300n, at: T0.add({ hours: 24 }) }),
      );
    }
    const mine = { ...NO_FILTER, sellerIds: sellers };
    const byId = [...made].sort((x, y) => (x.id < y.id ? -1 : 1));
    const amountAsc = await value(market, () =>
      reader.page(market, mine, { key: 'amount', direction: 'asc' }, 0, 10),
    );
    expect(amountAsc.map((p) => p.transfer)).toEqual([300n, 300n, 700n, 700n]);
    expect(amountAsc.slice(0, 2).map((p) => p.id)).toEqual(
      byId.filter((p) => p.transfer === 300n).map((p) => p.id),
    );
    for (const key of ['state-changed', 'slot'] as const) {
      const rows = await value(market, () =>
        reader.page(market, mine, { key, direction: 'asc' }, 0, 10),
      );
      expect(rows.map((p) => p.id)).toEqual(byId.map((p) => p.id));
    }
    // Previous/Next: same creation instant everywhere, so only the id orders them.
    const newest = [...byId].reverse();
    const first = await value(market, () => reader.page(market, mine, NEWEST, 0, 2));
    const last = first[1]!;
    const second = await value(market, () =>
      reader.page(market, mine, NEWEST, 0, 5, { createdAt: last.createdAt, payoutId: last.id }),
    );
    expect([...first, ...second].map((p) => p.id)).toEqual(newest.map((p) => p.id));
    // Page numbers: the offset.
    const paged = await value(market, () => reader.page(market, mine, NEWEST, 2, 2));
    expect(paged.map((p) => p.id)).toEqual(newest.slice(2).map((p) => p.id));
  });

  it('counts the Market per state, at least the payouts of this file', async () => {
    const s = seller();
    await payoutOf(s, { mode: 'MANUAL' });
    await payoutOf(seller(), { to: ['not-sent'] });
    const counts = await value(market, () => reader.countByState(market));
    expect(counts['awaiting-approval']).toBeGreaterThanOrEqual(1);
    expect(counts['not-sent']).toBeGreaterThanOrEqual(1);
    expect(Object.keys(counts).sort()).toEqual(
      [
        'approved',
        'awaiting-approval',
        'failed',
        'instructed',
        'instructing',
        'not-sent',
        'paid',
        'pending',
        'settled-by-netting',
        'voided',
      ].sort(),
    );
  });

  it("names each seller's newest active admin hold over the whole seller, and nothing else", async () => {
    const a = seller();
    const b = seller();
    const c = seller();
    const holdOf = (fields: Partial<PayoutHoldRecord> & { sellerId: Id<'Seller'> }) => {
      const holdId = randomUUID() as Id<'PayoutHold'>;
      const record: PayoutHoldRecord = {
        id: holdId,
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
      return value(market, () => holds.insertIfAbsent(market, record)).then(() => record);
    };
    await holdOf({ sellerId: a, placedAt: T0 });
    const newest = await holdOf({ sellerId: a, placedAt: T0.add({ hours: 1 }) });
    // b: a system hold and a hold on one seller order only.
    await holdOf({ sellerId: b, origin: 'system', reason: 'seller-suspended', placedBy: null });
    await holdOf({ sellerId: b, sellerOrderId: randomUUID() as Id<'SellerOrder'> });
    // c: released.
    const released = await holdOf({ sellerId: c });
    await value(market, () =>
      holds.release(market, released.id, {
        releasedAt: T0.add({ hours: 2 }),
        releasedBy: randomUUID() as Id<'Account'>,
        reason: 'resolved',
      }),
    );
    const found = await value(market, () => reader.activeAdminHolds(market, [a, b, c]));
    expect([...found.entries()]).toEqual([[a, newest.id]]);
    expect((await value(other, () => reader.activeAdminHolds(other, [a]))).size).toBe(0);
  });
});
