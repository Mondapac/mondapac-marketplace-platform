import { err, money, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { AuditEntry, CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { FakeUnitOfWork } from '../../../../test/support/pricing-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import type { AuditWriter } from '../../../platform/audit/audit-writer';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { PaidSellerOrder, RefundedSellerOrder } from '../contracts';
import { COMMISSION_PAYOUTS_AUDIT_ACTIONS } from '../domain/audit';
import { commissionBase, commissionOn, parseRateBps } from '../domain/commission';
import { reversedAmount } from '../domain/reversal';
import { netBySellerOrder, type LedgerEntry, type LedgerKind } from '../domain/ledger';
import { payoutStores } from '../../../../test/support/commission-payouts-fakes';
import { ConfigPayoutTermsPolicy } from '../infrastructure/config-payout-terms-policy';
import { ConfigCommissionPolicy } from '../infrastructure/config-commission-policy';
import type { CommissionPayoutsDependencies } from './commission-payouts-dependencies';
import type { LedgerPage, LedgerRepository } from './ports/ledger.repository';
import type { SellerRateRecord, SellerRateRepository } from './ports/seller-rate.repository';
import { ClearCommissionRate } from './use-cases/clear-commission-rate.use-case';
import { CommissionRates } from './use-cases/commission-rates.use-case';
import { RecordRefund } from './use-cases/record-refund.use-case';
import { RecordSellerOrderPaid } from './use-cases/record-seller-order-paid.use-case';
import { SetCommissionRate } from './use-cases/set-commission-rate.use-case';
import { ViewCommissionRate } from './use-cases/view-commission-rate.use-case';
import { ViewOwnLedger } from './use-cases/view-own-ledger.use-case';
import { ViewSellerLedger } from './use-cases/view-seller-ledger.use-case';

// Commission and the seller ledger in memory on both Market fixtures (AU: AUD, 15 %, prices with
// GST 10 %; ZZ: JPY, 12 %, prices without tax): the Market rate and a seller's own rate, each
// change audited; a paid seller order written once into an insert-only ledger; each seller sees
// only its own ledger and balance.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const T0 = Temporal.Instant.from('2026-10-14T10:00:00Z');
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const SELLER_A = id<'Seller'>(0x51);
const SELLER_B = id<'Seller'>(0x52);
const GHOST = id<'Seller'>(0x5f);
const ADMIN = id<'Account'>(0xad);
const ORDER = id<'Order'>(0x101);
const SELLER_ORDER = id<'SellerOrder'>(0x201);
const LINE_1 = id<'OrderLine'>(0x301);
const LINE_2 = id<'OrderLine'>(0x302);

const ACTIONS = new Set<string>(COMMISSION_PAYOUTS_AUDIT_ACTIONS.map((a) => a.action));

class RecordingAudit implements AuditWriter {
  readonly entries: AuditEntry[] = [];
  record(_context: CallContext, entry: AuditEntry): Promise<void> {
    if (!ACTIONS.has(entry.action)) throw new Error(`audit: unknown action ${entry.action}`);
    this.entries.push(entry);
    return Promise.resolve();
  }
}

class MemoryRates implements SellerRateRepository {
  readonly rows = new Map<string, SellerRateRecord & { updatedBy: Id<'Account'> }>();
  find(_m: MarketContext, sellerId: Id<'Seller'>) {
    return Promise.resolve(this.rows.get(sellerId) ?? null);
  }
  findForUpdate(m: MarketContext, sellerId: Id<'Seller'>) {
    this.locked.push(sellerId);
    return this.find(m, sellerId);
  }
  readonly locked: Id<'Seller'>[] = [];
  findMany(_m: MarketContext, sellerIds: readonly Id<'Seller'>[]) {
    return Promise.resolve(sellerIds.flatMap((sellerId) => this.rows.get(sellerId) ?? []));
  }
  save(_m: MarketContext, record: SellerRateRecord & { updatedBy: Id<'Account'> }) {
    this.rows.set(record.sellerId, record);
    return Promise.resolve();
  }
  remove(_m: MarketContext, sellerId: Id<'Seller'>) {
    return Promise.resolve(this.rows.delete(sellerId));
  }
}

/**
 * Insert-only like the table: rows are appended, a repeated (seller order, kind, line, source)
 * skipped (the key is NULLS NOT DISTINCT, so a null line or source clashes with another null).
 */
class MemoryLedger implements LedgerRepository {
  readonly rows: LedgerEntry[] = [];
  listSellerOrder(_m: MarketContext, sellerOrderId: Id<'SellerOrder'>) {
    return Promise.resolve(this.rows.filter((row) => row.sellerOrderId === sellerOrderId));
  }
  sellerOfSellerOrder(_m: MarketContext, sellerOrderId: Id<'SellerOrder'>) {
    return Promise.resolve(
      this.rows.find((row) => row.sellerOrderId === sellerOrderId)?.sellerId ?? null,
    );
  }
  hasSellerOrder(_m: MarketContext, sellerOrderId: Id<'SellerOrder'>) {
    return Promise.resolve(this.rows.some((row) => row.sellerOrderId === sellerOrderId));
  }
  netBySellerOrder(_m: MarketContext, sellerId: Id<'Seller'>, currency: string) {
    return Promise.resolve(netBySellerOrder(this.rows, sellerId, currency));
  }
  append(_m: MarketContext, entries: readonly LedgerEntry[]) {
    let count = 0;
    for (const entry of entries) {
      const clash = this.rows.some(
        (row) =>
          row.sellerOrderId === entry.sellerOrderId &&
          row.kind === entry.kind &&
          row.orderLineId === entry.orderLineId &&
          row.sourceId === entry.sourceId,
      );
      if (!clash) {
        this.rows.push(entry);
        count += 1;
      }
    }
    return Promise.resolve(count);
  }
  list(_m: MarketContext, sellerId: Id<'Seller'>, page: LedgerPage) {
    return Promise.resolve(
      this.rows
        .filter((row) => row.sellerId === sellerId)
        .sort(
          (a, b) =>
            b.recordedAt.epochMilliseconds - a.recordedAt.epochMilliseconds ||
            b.id.localeCompare(a.id),
        )
        .filter(
          (row) =>
            page.after === null ||
            row.recordedAt.epochMilliseconds < page.after.recordedAt.epochMilliseconds ||
            (row.recordedAt.epochMilliseconds === page.after.recordedAt.epochMilliseconds &&
              row.id < page.after.id),
        )
        .slice(0, page.limit),
    );
  }
  sums(_m: MarketContext, sellerId: Id<'Seller'>) {
    const sums = new Map<string, { currency: string; kind: LedgerEntry['kind']; amount: bigint }>();
    for (const row of this.rows.filter((r) => r.sellerId === sellerId)) {
      const key = `${row.amount.currency}/${row.kind}`;
      const sum = sums.get(key) ?? { currency: row.amount.currency, kind: row.kind, amount: 0n };
      sums.set(key, { ...sum, amount: sum.amount + row.amount.amount });
    }
    return Promise.resolve([...sums.values()]);
  }
}

describe('commission arithmetic', () => {
  it('takes the provisional tax out of an inclusive line, rounding half up', () => {
    // $11.00 with 10 % GST inside: base $10.00, 15 % = $1.50 (domain design 4.3 worked example).
    expect(commissionBase(1100n, true, 1000)).toBe(1000n);
    expect(commissionOn(1000n, 1500)).toBe(150n);
    // $3.35 with GST inside: 335 / 1.1 = 304.545… -> 305; 15 % = 45.75 -> 46.
    expect(commissionBase(335n, true, 1000)).toBe(305n);
    expect(commissionOn(305n, 1500)).toBe(46n);
  });

  it('uses an exclusive line as it is, and a zero rate gives zero', () => {
    expect(commissionBase(1000n, false, 1000)).toBe(1000n);
    expect(commissionOn(1000n, 1200)).toBe(120n);
    expect(commissionOn(999_999n, 0)).toBe(0n);
    expect(commissionOn(1n, 3000)).toBe(0n);
    expect(commissionOn(2n, 2500)).toBe(1n);
  });

  it.each([-1, 3001, 1.5, '1500', null, undefined, NaN])('refuses the rate %p', (value) => {
    expect(parseRateBps(value)).toEqual(err({ code: 'validation.failed', path: 'rateBps' }));
  });
});

describe.each([['AU'], ['ZZ']] as const)('commission and seller ledger in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const config = markets.get(market.marketId);
  const currency = config.defaultCurrency;
  const marketRate = config.commissionPayouts!.defaultRateBps;
  const inclusive = config.pricesIncludeTax;
  const clock = new FixedClock(T0);
  const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
  const actor = (population: 'admin' | 'seller' | 'customer', sellerId: Id<'Seller'> | null) =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population,
        accountId: population === 'admin' ? ADMIN : id<'Account'>(0xa1),
        sessionId: id<'Session'>(0x61),
        sellerId,
      }),
      `cp-${population}-abcd`,
    );
  const admin = actor('admin', null);
  const sellerA = actor('seller', SELLER_A);
  const sellerB = actor('seller', SELLER_B);
  const customer = actor('customer', null);
  const system = testCallContext(market, 'system', 'cp-system-abcd');

  let rates: MemoryRates;
  let ledger: MemoryLedger;
  let audit: RecordingAudit;
  let known: Set<string>;
  let deps: CommissionPayoutsDependencies;

  beforeEach(() => {
    rates = new MemoryRates();
    ledger = new MemoryLedger();
    audit = new RecordingAudit();
    known = new Set([SELLER_A, SELLER_B]);
    deps = {
      unitOfWork: new FakeUnitOfWork(),
      rates,
      ledger,
      policy: new ConfigCommissionPolicy(markets),
      ...payoutStores(new ConfigPayoutTermsPolicy(markets)),
      sellers: {
        exists: (_c: CallContext, sellerId: Id<'Seller'>) => Promise.resolve(known.has(sellerId)),
      },
      audit,
      ids: new SequenceIdGenerator(clock),
      clock,
    };
  });

  const setRate = (sellerId: unknown, rateBps: unknown, context: CallContext = admin) =>
    new SetCommissionRate(gate, deps).execute(context, { sellerId, rateBps });
  const readRates = (sellerIds: unknown, context: CallContext = customer) =>
    new CommissionRates(gate, deps).execute(context, { sellerIds });
  const paid = (overrides: Partial<PaidSellerOrder> = {}): PaidSellerOrder => ({
    orderId: ORDER,
    sellerOrderId: SELLER_ORDER,
    sellerId: SELLER_A,
    currency,
    shipping: 500n,
    paidAt: T0,
    lines: [
      { orderLineId: LINE_1, lineAmount: 1100n, taxInclusive: inclusive, commissionRateBps: 1500 },
      { orderLineId: LINE_2, lineAmount: 335n, taxInclusive: inclusive, commissionRateBps: 1500 },
    ],
    ...overrides,
  });
  const record = (facts: PaidSellerOrder = paid(), context: CallContext = system) =>
    new RecordSellerOrderPaid(gate, deps).execute(context, facts);

  describe('rates', () => {
    it('answers the Market rate for a seller with no rate of its own', async () => {
      expect(await readRates([SELLER_A, SELLER_A])).toEqual(
        ok(new Map([[SELLER_A, { rateBps: marketRate, source: 'market' }]])),
      );
      expect(
        await new ViewCommissionRate(gate, deps).execute(admin, { sellerId: SELLER_A }),
      ).toEqual(
        ok({
          sellerId: SELLER_A,
          rateBps: marketRate,
          source: 'market',
          marketRateBps: marketRate,
        }),
      );
    });

    it("sets a seller's own rate, audits old and new, and flags a rate under the Market's", async () => {
      expect(await setRate(SELLER_A, 1000)).toEqual(
        ok({ sellerId: SELLER_A, rateBps: 1000, source: 'seller', marketRateBps: marketRate }),
      );
      expect(rates.rows.get(SELLER_A)).toMatchObject({
        rateBps: 1000,
        updatedAt: T0,
        updatedBy: ADMIN,
      });
      await setRate(SELLER_A, 2000);
      // The "before" of the audit row is read under the row lock.
      expect(rates.locked).toEqual([SELLER_A, SELLER_A]);
      expect(await readRates([SELLER_A, SELLER_B])).toEqual(
        ok(
          new Map([
            [SELLER_A, { rateBps: 2000, source: 'seller' }],
            [SELLER_B, { rateBps: marketRate, source: 'market' }],
          ]),
        ),
      );
      expect(audit.entries.map((e) => [e.action, e.targetId, e.before, e.after])).toEqual([
        [
          'commission-payouts.commission-rate.set',
          SELLER_A,
          { rateBps: null },
          { rateBps: 1000, marketRateBps: marketRate, belowMarketRate: true },
        ],
        [
          'commission-payouts.commission-rate.set',
          SELLER_A,
          { rateBps: 1000 },
          { rateBps: 2000, marketRateBps: marketRate, belowMarketRate: false },
        ],
      ]);
    });

    it('removes a seller rate back to the Market rate, audited; nothing to remove is not found', async () => {
      const clear = (sellerId: unknown) =>
        new ClearCommissionRate(gate, deps).execute(admin, { sellerId });
      expect(await clear(SELLER_A)).toEqual(err({ code: 'commission-payouts.rate-not-set' }));
      await setRate(SELLER_A, 900);
      expect(await clear(SELLER_A)).toEqual(
        ok({
          sellerId: SELLER_A,
          rateBps: marketRate,
          source: 'market',
          marketRateBps: marketRate,
        }),
      );
      expect(rates.rows.size).toBe(0);
      expect(audit.entries.at(-1)).toMatchObject({
        action: 'commission-payouts.commission-rate.clear',
        before: { rateBps: 900 },
        after: { marketRateBps: marketRate },
      });
    });

    it('refuses a bad id or rate, an unknown seller, and every caller but an admin', async () => {
      expect(await setRate('nope', 3001)).toEqual(
        err({
          code: 'validation.failed',
          fields: [
            { path: 'sellerId', code: 'format' },
            { path: 'rateBps', code: 'range' },
          ],
        }),
      );
      expect(await setRate(GHOST, 1000)).toEqual(
        err({ code: 'commission-payouts.seller-not-found' }),
      );
      expect(await setRate(SELLER_A, 1000, sellerA)).toEqual(err({ code: 'access.denied' }));
      expect(await setRate(SELLER_A, 1000, system)).toMatchObject({ ok: false });
      expect(rates.rows.size).toBe(0);
      expect(audit.entries).toEqual([]);
    });

    it('caps the system read at 100 ids and refuses a malformed one', async () => {
      expect(await readRates(Array.from({ length: 101 }, () => SELLER_A))).toMatchObject({
        ok: false,
        error: { code: 'validation.failed' },
      });
      expect(await readRates(['x'])).toMatchObject({
        ok: false,
        error: { code: 'validation.failed' },
      });
      expect(await readRates([])).toEqual(ok(new Map()));
      // Only the signed-in customer (checkout) may read the rates.
      const anonymous = testCallContext(market, 'anonymous', 'cp-anon-abcd');
      for (const other of [admin, sellerA, system]) {
        expect(await readRates([SELLER_A], other)).toMatchObject({
          ok: false,
          error: { code: 'access.denied' },
        });
      }
      expect(await readRates([SELLER_A], anonymous)).toMatchObject({
        ok: false,
        error: { code: 'access.unauthenticated' },
      });
    });
  });

  describe('ledger', () => {
    const base1 = inclusive
      ? commissionBase(1100n, true, config.commissionPayouts!.provisionalTaxRateBps)
      : 1100n;
    const base2 = inclusive
      ? commissionBase(335n, true, config.commissionPayouts!.provisionalTaxRateBps)
      : 335n;
    const commission = commissionOn(base1, 1500) + commissionOn(base2, 1500);

    it('writes a sale and a commission per line and the delivery fee, at the frozen rate', async () => {
      // A later change of the seller's rate does not touch the rate frozen on the lines.
      await setRate(SELLER_A, 500);
      expect(await record()).toEqual(ok('recorded'));
      expect(
        ledger.rows.map((r) => [r.kind, r.orderLineId, r.amount, r.rateBps, r.baseAmount]),
      ).toEqual([
        ['sale', LINE_1, money(1100n, currency), null, null],
        ['commission', LINE_1, money(commissionOn(base1, 1500), currency), 1500, base1],
        ['sale', LINE_2, money(335n, currency), null, null],
        ['commission', LINE_2, money(commissionOn(base2, 1500), currency), 1500, base2],
        ['shipping', null, money(500n, currency), null, null],
      ]);
      if (code === 'AU') expect([base1, base2]).toEqual([1000n, 305n]);
      if (code === 'ZZ') expect([base1, base2]).toEqual([1100n, 335n]);
      expect(ledger.rows.every((r) => r.occurredAt.equals(T0) && r.sellerId === SELLER_A)).toBe(
        true,
      );
    });

    it('writes a paid seller order once, and no delivery row for a free delivery', async () => {
      expect(await record(paid({ shipping: 0n }))).toEqual(ok('recorded'));
      expect(await record(paid({ shipping: 0n }))).toEqual(ok('already-recorded'));
      expect(ledger.rows.filter((r) => r.kind === 'shipping')).toEqual([]);
      expect(ledger.rows).toHaveLength(4);
    });

    it('writes no rows for a fully discounted line, and still records the order', async () => {
      const free = paid({
        lines: [
          { orderLineId: LINE_1, lineAmount: 0n, taxInclusive: true, commissionRateBps: 1500 },
        ],
      });
      expect(await record(free)).toEqual(ok('recorded'));
      expect(ledger.rows.map((r) => r.kind)).toEqual(['shipping']);
    });

    it('refuses malformed facts whole, another currency, and any caller but the system', async () => {
      const refused = async (facts: PaidSellerOrder) =>
        expect(await record(facts)).toMatchObject({
          ok: false,
          error: { code: 'validation.failed' },
        });
      await refused(paid({ currency: currency === 'AUD' ? 'JPY' : 'AUD' }));
      await refused(paid({ lines: [] }));
      await refused(paid({ shipping: -1n }));
      await refused(
        paid({
          lines: [
            { orderLineId: LINE_1, lineAmount: 100n, taxInclusive: true, commissionRateBps: 3001 },
          ],
        }),
      );
      await refused(
        paid({
          lines: [
            { orderLineId: LINE_1, lineAmount: 100n, taxInclusive: true, commissionRateBps: 1500 },
            { orderLineId: LINE_1, lineAmount: 100n, taxInclusive: true, commissionRateBps: 1500 },
          ],
        }),
      );
      expect(await record(paid(), admin)).toMatchObject({ ok: false });
      expect(await record(paid(), sellerA)).toMatchObject({ ok: false });
      expect(ledger.rows).toEqual([]);
    });

    it('shows a seller only its own ledger and balance, and an admin any seller', async () => {
      await record();
      const own = await new ViewOwnLedger(gate, deps).execute(sellerA, {});
      expect(own).toMatchObject({
        ok: true,
        value: {
          sellerId: SELLER_A,
          currency,
          totals: {
            sales: 1435n,
            shipping: 500n,
            commission,
            balance: 1435n + 500n - commission,
          },
          nextCursor: null,
        },
      });
      expect(own.ok && own.value.entries.map((e) => e.direction).sort()).toEqual([
        'credit',
        'credit',
        'credit',
        'debit',
        'debit',
      ]);
      const other = await new ViewOwnLedger(gate, deps).execute(sellerB, {});
      expect(other).toMatchObject({ ok: true, value: { sellerId: SELLER_B, entries: [] } });
      const byAdmin = await new ViewSellerLedger(gate, deps).execute(admin, { sellerId: SELLER_A });
      expect(byAdmin.ok && byAdmin.value.totals).toEqual(own.ok && own.value.totals);
      expect(
        await new ViewSellerLedger(gate, deps).execute(sellerB, { sellerId: SELLER_A }),
      ).toEqual(err({ code: 'access.denied' }));
      expect(await new ViewOwnLedger(gate, deps).execute(customer, {})).toMatchObject({
        ok: false,
      });
    });

    it('pages newest first with an opaque cursor and refuses a malformed one', async () => {
      await record();
      const first = await new ViewOwnLedger(gate, deps).execute(sellerA, { limit: 2 });
      if (!first.ok) throw new Error('read failed');
      expect(first.value.entries).toHaveLength(2);
      expect(first.value.nextCursor).not.toBeNull();
      const rest = await new ViewOwnLedger(gate, deps).execute(sellerA, {
        limit: 10,
        cursor: first.value.nextCursor,
      });
      if (!rest.ok) throw new Error('read failed');
      expect(rest.value.entries).toHaveLength(3);
      expect(rest.value.nextCursor).toBeNull();
      const ids = [...first.value.entries, ...rest.value.entries].map((e) => e.entryId);
      expect(new Set(ids).size).toBe(5);
      expect(
        await new ViewOwnLedger(gate, deps).execute(sellerA, { cursor: 'x', limit: 0 }),
      ).toEqual(
        err({
          code: 'validation.failed',
          fields: [
            { path: 'limit', code: 'range' },
            { path: 'cursor', code: 'format' },
          ],
        }),
      );
    });
  });
  describe('refund reversals', () => {
    const REFUND_1 = id<'Refund'>(0x401);
    const REFUND_2 = id<'Refund'>(0x402);
    const REFUND_3 = id<'Refund'>(0x403);
    const T1 = T0.add({ hours: 2 });
    const settingsOf = config.commissionPayouts!;
    const base1 = commissionBase(1100n, inclusive, settingsOf.provisionalTaxRateBps);
    const base2 = commissionBase(335n, inclusive, settingsOf.provisionalTaxRateBps);

    /** Line 1 has 3 units (1100 in all), line 2 has 5 (335 in all); delivery 500, charge 550 (AU). */
    const refunded = (overrides: Partial<RefundedSellerOrder> = {}): RefundedSellerOrder => ({
      refundId: REFUND_1,
      orderId: ORDER,
      sellerOrderId: SELLER_ORDER,
      sellerId: SELLER_A,
      currency,
      lossBearer: 'seller',
      settledAt: T1,
      lines: [{ orderLineId: LINE_1, lineQuantity: 3, unitsBefore: 0, units: 1 }],
      shipping: null,
      ...overrides,
    });
    const recordRefund = (facts: RefundedSellerOrder, context: CallContext = system) =>
      new RecordRefund(gate, deps).execute(context, facts);
    const reversals = () => ledger.rows.filter((r) => r.sourceId !== null);
    const sum = (kind: LedgerKind) =>
      ledger.rows.filter((r) => r.kind === kind).reduce((n, r) => n + r.amount.amount, 0n);

    beforeEach(async () => {
      await record();
    });

    it('reverses the stored sale and commission rows of a refunded line, with the original rate', async () => {
      expect(await recordRefund(refunded())).toEqual(ok('recorded'));
      expect(
        reversals().map((r) => [r.kind, r.orderLineId, r.amount, r.rateBps, r.baseAmount]),
      ).toEqual([
        ['refund-sale', LINE_1, money(reversedAmount(1100n, 1n, 3n), currency), null, null],
        [
          'refund-commission',
          LINE_1,
          money(reversedAmount(commissionOn(base1, 1500), 1n, 3n), currency),
          1500,
          reversedAmount(base1, 1n, 3n),
        ],
      ]);
      expect(reversals().every((r) => r.sourceId === REFUND_1 && r.occurredAt.equals(T1))).toBe(
        true,
      );
      if (code === 'AU') {
        // 1100 / 3 = 366.67 -> 367; commission 150 / 3 = 50 on a base of 1000 / 3 = 333.
        expect(reversals().map((r) => r.amount.amount)).toEqual([367n, 50n]);
      }
    });

    it('is the same on a replay of the refund, and the ledger keeps one set of rows', async () => {
      expect(await recordRefund(refunded())).toEqual(ok('recorded'));
      const rows = ledger.rows.length;
      expect(await recordRefund(refunded())).toEqual(ok('already-recorded'));
      expect(ledger.rows).toHaveLength(rows);
    });

    it('reverses exactly the original rows over several partial refunds, in any order', async () => {
      const steps: [Id<'Refund'>, number, number][] = [
        [REFUND_1, 0, 1],
        [REFUND_2, 1, 1],
        [REFUND_3, 2, 1],
      ];
      // Posted out of order: the later refunds do not depend on the earlier ones being posted.
      for (const [refundId, before, units] of [steps[2]!, steps[0]!, steps[1]!]) {
        expect(
          await recordRefund(
            refunded({
              refundId,
              lines: [{ orderLineId: LINE_1, lineQuantity: 3, unitsBefore: before, units }],
            }),
          ),
        ).toEqual(ok('recorded'));
      }
      const line1 = (kind: LedgerKind) =>
        ledger.rows
          .filter((r) => r.kind === kind && r.orderLineId === LINE_1)
          .reduce((n, r) => n + r.amount.amount, 0n);
      expect(ledger.rows.filter((r) => r.kind === 'refund-sale')).toHaveLength(3);
      expect(line1('refund-sale')).toBe(line1('sale'));
      expect(line1('refund-commission')).toBe(line1('commission'));
      expect(
        ledger.rows.filter(
          (r) => r.kind === 'refund-commission' && r.baseAmount! < r.amount.amount,
        ),
      ).toEqual([]);
    });

    it('reverses the delivery fee in proportion to the charge refunded, whole at the end', async () => {
      // A charge of 550 (500 fee plus 50 tax inside the fee for AU would be 500; here the charge
      // is passed as ordering gives it): 275 of 550 is half the 500 row, then the rest.
      expect(
        await recordRefund(
          refunded({
            lines: [],
            shipping: { refundedBefore: 0n, refundedAfter: 275n, charge: 550n },
          }),
        ),
      ).toEqual(ok('recorded'));
      expect(
        await recordRefund(
          refunded({
            refundId: REFUND_2,
            lines: [],
            shipping: { refundedBefore: 275n, refundedAfter: 550n, charge: 550n },
          }),
        ),
      ).toEqual(ok('recorded'));
      expect(
        ledger.rows.filter((r) => r.kind === 'refund-shipping').map((r) => r.amount.amount),
      ).toEqual([250n, 250n]);
      expect(sum('refund-shipping')).toBe(sum('shipping'));
      expect(reversals().every((r) => r.orderLineId === null)).toBe(true);
    });

    it('posts nothing when the platform bears the loss, but answers so', async () => {
      expect(await recordRefund(refunded({ lossBearer: 'platform' }))).toEqual(
        ok('nothing-to-post'),
      );
      expect(reversals()).toEqual([]);
    });

    it('moves the balance: sales + shipping − commission − refunds + refunded commission', async () => {
      await recordRefund(
        refunded({
          lines: [{ orderLineId: LINE_2, lineQuantity: 5, unitsBefore: 0, units: 5 }],
          shipping: { refundedBefore: 0n, refundedAfter: 550n, charge: 550n },
        }),
      );
      const view = await new ViewOwnLedger(gate, deps).execute(sellerA, {});
      const commission1 = commissionOn(base1, 1500);
      const commission2 = commissionOn(base2, 1500);
      expect(view).toMatchObject({
        ok: true,
        value: {
          totals: {
            sales: 1435n,
            shipping: 500n,
            commission: commission1 + commission2,
            refundedSales: 335n,
            refundedShipping: 500n,
            refundedCommission: commission2,
            balance: 1435n + 500n - (commission1 + commission2) - 335n - 500n + commission2,
          },
        },
      });
      const directions = view.ok
        ? Object.fromEntries(view.value.entries.map((e) => [e.kind, e.direction]))
        : {};
      expect(directions).toMatchObject({
        sale: 'credit',
        shipping: 'credit',
        commission: 'debit',
        'refund-sale': 'debit',
        'refund-shipping': 'debit',
        'refund-commission': 'credit',
      });
    });

    it('lets the balance go negative when more went back than the seller still holds', async () => {
      // The seller order took 1435 + 500; reverse everything, leaving only the commission given
      // back against nothing: sales − refunds nets to zero, the balance equals what is left.
      await recordRefund(
        refunded({
          lines: [
            { orderLineId: LINE_1, lineQuantity: 3, unitsBefore: 0, units: 3 },
            { orderLineId: LINE_2, lineQuantity: 5, unitsBefore: 0, units: 5 },
          ],
          shipping: { refundedBefore: 0n, refundedAfter: 550n, charge: 550n },
        }),
      );
      const view = await new ViewOwnLedger(gate, deps).execute(sellerA, {});
      expect(view.ok && view.value.totals.balance).toBe(0n);
    });

    it('skips a share that rounds to zero for the sale but still writes the commission row', async () => {
      const tiny = id<'SellerOrder'>(0x2f1);
      const line = id<'OrderLine'>(0x3f1);
      await record(
        paid({
          sellerOrderId: tiny,
          shipping: 0n,
          lines: [
            { orderLineId: line, lineAmount: 1n, taxInclusive: false, commissionRateBps: 1500 },
          ],
        }),
      );
      // One minor unit over 999 units: the first unit's share is 0.001 -> 0.
      expect(
        await recordRefund(
          refunded({
            sellerOrderId: tiny,
            lines: [{ orderLineId: line, lineQuantity: 999, unitsBefore: 0, units: 1 }],
          }),
        ),
      ).toEqual(ok('recorded'));
      expect(reversals().map((r) => [r.kind, r.amount.amount])).toEqual([
        ['refund-commission', 0n],
      ]);
    });

    it('refuses a line with no stored rows, fully discounted or not on the seller order', async () => {
      const free = id<'SellerOrder'>(0x2f2);
      await record(
        paid({
          sellerOrderId: free,
          lines: [
            { orderLineId: LINE_1, lineAmount: 0n, taxInclusive: true, commissionRateBps: 1500 },
          ],
        }),
      );
      const answer = await recordRefund(
        refunded({
          sellerOrderId: free,
          lines: [{ orderLineId: LINE_1, lineQuantity: 1, unitsBefore: 0, units: 1 }],
        }),
      );
      expect(answer).toEqual(err({ code: 'commission-payouts.ledger-inconsistent' }));
      expect(reversals()).toEqual([]);
    });

    it('refuses a double reversal: other refunds plus this one would pass the stored row', async () => {
      // Refund 1 takes all 3 units; refund 2 claims the first unit again (a wrong unitsBefore).
      expect(
        await recordRefund(
          refunded({ lines: [{ orderLineId: LINE_1, lineQuantity: 3, unitsBefore: 0, units: 3 }] }),
        ),
      ).toEqual(ok('recorded'));
      const rows = ledger.rows.length;
      expect(await recordRefund(refunded({ refundId: REFUND_2 }))).toEqual(
        err({ code: 'commission-payouts.ledger-inconsistent' }),
      );
      // The same for the delivery fee: all of it back, then a part again.
      const fee = (refundId: Id<'Refund'>, before: bigint, after: bigint) =>
        recordRefund(
          refunded({
            refundId,
            lines: [],
            shipping: { refundedBefore: before, refundedAfter: after, charge: 550n },
          }),
        );
      expect(await fee(REFUND_1, 0n, 550n)).toEqual(ok('recorded'));
      expect(await fee(REFUND_3, 0n, 100n)).toEqual(
        err({ code: 'commission-payouts.ledger-inconsistent' }),
      );
      expect(ledger.rows.length).toBe(rows + 1);
      // Replaying refund 1 itself is not a double reversal.
      expect(await fee(REFUND_1, 0n, 550n)).toEqual(ok('already-recorded'));
    });

    it('refuses facts that do not fit the stored rows, and writes nothing', async () => {
      const code_ = async (facts: RefundedSellerOrder) => {
        const answer = await recordRefund(facts);
        return answer.ok ? 'ok' : answer.error.code;
      };
      expect(await code_(refunded({ sellerOrderId: id<'SellerOrder'>(0x2ff) }))).toBe(
        'commission-payouts.ledger-inconsistent',
      );
      expect(await code_(refunded({ sellerId: SELLER_B }))).toBe(
        'commission-payouts.ledger-inconsistent',
      );
      expect(
        await code_(
          refunded({
            lines: [
              { orderLineId: id<'OrderLine'>(0x3ff), lineQuantity: 1, unitsBefore: 0, units: 1 },
            ],
          }),
        ),
      ).toBe('commission-payouts.ledger-inconsistent');
      // A line with a sale row but no commission row is a ledger the refund cannot be matched to.
      ledger.rows.splice(
        ledger.rows.findIndex((r) => r.kind === 'commission' && r.orderLineId === LINE_2),
        1,
      );
      expect(
        await code_(
          refunded({
            lines: [{ orderLineId: LINE_2, lineQuantity: 5, unitsBefore: 0, units: 1 }],
          }),
        ),
      ).toBe('commission-payouts.ledger-inconsistent');
      for (const facts of [
        refunded({ currency: currency === 'AUD' ? 'JPY' : 'AUD' }),
        refunded({ lossBearer: 'customer' as never }),
        refunded({ lines: [] }),
        refunded({ lines: [{ orderLineId: LINE_1, lineQuantity: 3, unitsBefore: 3, units: 1 }] }),
        refunded({ lines: [{ orderLineId: LINE_1, lineQuantity: 3, unitsBefore: 0, units: 0 }] }),
        refunded({
          lines: [
            { orderLineId: LINE_1, lineQuantity: 3, unitsBefore: 0, units: 1 },
            { orderLineId: LINE_1, lineQuantity: 3, unitsBefore: 1, units: 1 },
          ],
        }),
        refunded({ lines: [], shipping: { refundedBefore: 5n, refundedAfter: 5n, charge: 9n } }),
        refunded({ lines: [], shipping: { refundedBefore: 0n, refundedAfter: 10n, charge: 9n } }),
      ]) {
        expect(await code_(facts)).toBe('validation.failed');
      }
      expect(await recordRefund(refunded(), admin)).toMatchObject({ ok: false });
      expect(await recordRefund(refunded(), sellerA)).toMatchObject({ ok: false });
      expect(reversals()).toEqual([]);
    });
  });
});
