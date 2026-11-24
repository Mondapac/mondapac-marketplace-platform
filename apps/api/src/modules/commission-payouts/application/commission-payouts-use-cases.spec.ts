import { err, money, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { AuditEntry, CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import type { RecordingCpOutbox } from '../../../../test/support/commission-payouts-dispute-fakes';
import { FakeUnitOfWork } from '../../../../test/support/pricing-fakes';
import { RecordingReview } from '../../../../test/support/system-request-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import type { AuditWriter } from '../../../platform/audit/audit-writer';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { PaidSellerOrder, RefundedSellerOrder } from '../contracts';
import { COMMISSION_PAYOUTS_AUDIT_ACTIONS } from '../domain/audit';
import {
  commissionBase,
  lineCommission,
  lineTaxBps,
  commissionOn,
  exclusiveRateBps,
  exclusiveWindowOpen,
  parseRateBps,
} from '../domain/commission';
import { reversedAmount } from '../domain/reversal';
import { netBySellerOrder, savingsOf, type LedgerEntry, type LedgerKind } from '../domain/ledger';
import { payoutStores } from '../../../../test/support/commission-payouts-fakes';
import type { MemoryDisputeDecisions } from '../../../../test/support/commission-payouts-fakes';
import { FakeSellerNames } from '../../../../test/support/commission-payouts-dispute-fakes';
import { sellerPageDepsOf } from '../../../../test/support/commission-payouts-seller-page-fakes';
import type { AllowingStepUp } from '../../../../test/support/commission-payouts-fakes';
import { COMMISSION_PAYOUTS_RATE_EDIT } from '../contracts/permissions';
import { ConfigPayoutTermsPolicy } from '../infrastructure/config-payout-terms-policy';
import { ConfigCommissionPolicy } from '../infrastructure/config-commission-policy';
import type { CommissionPayoutsDependencies } from './commission-payouts-dependencies';
import { COMMISSION_RATE_SUBJECT_KIND } from './money-review';
import { CommissionRateReverter, PayoutTermsReverter } from './money-reverters';
import type { LedgerPage, LedgerRepository } from './ports/ledger.repository';
import type { SellerRateRecord, SellerRateRepository } from './ports/seller-rate.repository';
import { ClearCommissionRate } from './use-cases/clear-commission-rate.use-case';
import { CommissionRates } from './use-cases/commission-rates.use-case';
import { OwnCommissionOn } from './use-cases/own-commission-on.use-case';
import { RecordRefund } from './use-cases/record-refund.use-case';
import { RecordSellerCashbackReturn } from './use-cases/record-seller-cashback-return.use-case';
import { RecordSellerCashback } from './use-cases/record-seller-cashback.use-case';
import { SellerOrderPayoutAnchorQuery } from './use-cases/seller-order-payout-anchor.use-case';
import { RecordSellerOrderPaid } from './use-cases/record-seller-order-paid.use-case';
import { SetCommissionRate } from './use-cases/set-commission-rate.use-case';
import { ViewCommissionRate } from './use-cases/view-commission-rate.use-case';
import { ViewOwnExclusiveCommission } from './use-cases/view-own-exclusive-commission.use-case';
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
  savingsBetween(
    _m: MarketContext,
    sellerId: Id<'Seller'>,
    windows: readonly { readonly from: Temporal.Instant; readonly to: Temporal.Instant }[],
  ) {
    return Promise.resolve(
      windows.map(({ from, to }) =>
        savingsOf(
          this.rows
            .filter(
              (row) =>
                row.sellerId === sellerId &&
                row.savedAmount != null &&
                Temporal.Instant.compare(row.occurredAt, from) >= 0 &&
                Temporal.Instant.compare(row.occurredAt, to) < 0,
            )
            .map((row) => ({
              currency: row.amount.currency,
              kind: row.kind,
              saved: row.savedAmount ?? 0n,
            })),
        ),
      ),
    );
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

  it('takes out the line’s own tax rate: a GST-free line keeps its whole amount as base', () => {
    // $15.90 of GST-free meat at 15 %: base $15.90, commission $2.39 (not $2.17 on 15.90 / 1.1).
    expect(lineCommission({ amount: 1590n, taxInclusive: true, taxBps: 0, rateBps: 1500 })).toEqual(
      { base: 1590n, commission: 239n, sellerReceives: 1351n },
    );
    // A taxable $11.00 line: base $10.00, commission $1.50; the seller keeps the $1.00 GST too.
    expect(
      lineCommission({ amount: 1100n, taxInclusive: true, taxBps: 1000, rateBps: 1500 }),
    ).toEqual({ base: 1000n, commission: 150n, sellerReceives: 950n });
    // An exclusive line is its own base whatever its rate.
    expect(
      lineCommission({ amount: 1000n, taxInclusive: false, taxBps: 1000, rateBps: 1500 }),
    ).toEqual({ base: 1000n, commission: 150n, sellerReceives: 850n });
  });

  it('falls back to the provisional rate only for a line with no frozen rate', () => {
    expect(lineTaxBps(0, 1000)).toBe(0);
    expect(lineTaxBps(1500, 1000)).toBe(1500);
    expect(lineTaxBps(null, 1000)).toBe(1000);
    expect(lineTaxBps(undefined, 1000)).toBe(1000);
  });

  it('uses an exclusive line as it is, and a zero rate gives zero', () => {
    expect(commissionBase(1000n, false, 1000)).toBe(1000n);
    expect(commissionOn(1000n, 1200)).toBe(120n);
    expect(commissionOn(999_999n, 0)).toBe(0n);
    expect(commissionOn(1n, 3000)).toBe(0n);
    expect(commissionOn(2n, 2500)).toBe(1n);
  });

  it('lowers an exclusive customer’s rate by the share, never under the floor or over the rate', () => {
    const half = { reductionBps: 5000, floorBps: 300, months: 12 };
    expect(exclusiveRateBps(1500, half)).toBe(750);
    expect(exclusiveRateBps(1001, half)).toBe(500); // 500.5 rounds down, in the seller's favour
    expect(exclusiveRateBps(500, half)).toBe(300);
    expect(exclusiveRateBps(200, half)).toBe(200);
    expect(exclusiveRateBps(0, half)).toBe(0);
    expect(exclusiveRateBps(1200, { reductionBps: 2500, floorBps: 500, months: 6 })).toBe(900);
    expect(exclusiveRateBps(3000, { reductionBps: 10000, floorBps: 0, months: 1 })).toBe(0);
  });

  it('keeps the lower rate for the Market’s months after the customer joined, in UTC', () => {
    const rule = { reductionBps: 5000, floorBps: 300, months: 12 };
    const since = Temporal.Instant.from('2026-01-31T10:00:00Z');
    expect(exclusiveWindowOpen(since, since, rule)).toBe(true);
    expect(exclusiveWindowOpen(since, Temporal.Instant.from('2027-01-31T09:59:59Z'), rule)).toBe(
      true,
    );
    expect(exclusiveWindowOpen(since, Temporal.Instant.from('2027-01-31T10:00:00Z'), rule)).toBe(
      false,
    );
    // A month that has no 31st ends on its last day.
    const short = { ...rule, months: 1 };
    expect(exclusiveWindowOpen(since, Temporal.Instant.from('2026-02-28T09:59:59Z'), short)).toBe(
      true,
    );
    expect(exclusiveWindowOpen(since, Temporal.Instant.from('2026-02-28T10:00:00Z'), short)).toBe(
      false,
    );
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
  let review: RecordingReview;

  beforeEach(() => {
    review = new RecordingReview();
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
      review,
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
      {
        orderLineId: LINE_1,
        lineAmount: 1100n,
        taxInclusive: inclusive,
        taxRateBps: null,
        commissionRateBps: 1500,
      },
      {
        orderLineId: LINE_2,
        lineAmount: 335n,
        taxInclusive: inclusive,
        taxRateBps: null,
        commissionRateBps: 1500,
      },
    ],
    ...overrides,
  });
  const record = (facts: PaidSellerOrder = paid(), context: CallContext = system) =>
    new RecordSellerOrderPaid(gate, deps).execute(context, facts);

  describe('rates', () => {
    it('answers the Market rate for a seller with no rate of its own', async () => {
      expect(await readRates([SELLER_A, SELLER_A])).toEqual(
        ok(
          new Map([
            [
              SELLER_A,
              {
                rateBps: marketRate,
                standardRateBps: marketRate,
                source: 'market',
                reason: 'standard',
              },
            ],
          ]),
        ),
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
        ok({
          sellerId: SELLER_A,
          rateBps: 1000,
          source: 'seller',
          marketRateBps: marketRate,
          request: null,
        }),
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
            [
              SELLER_A,
              { rateBps: 2000, standardRateBps: 2000, source: 'seller', reason: 'standard' },
            ],
            [
              SELLER_B,
              {
                rateBps: marketRate,
                standardRateBps: marketRate,
                source: 'market',
                reason: 'standard',
              },
            ],
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
          request: null,
        }),
      );
      expect(rates.rows.size).toBe(0);
      expect(audit.entries.at(-1)).toMatchObject({
        action: 'commission-payouts.commission-rate.clear',
        before: { rateBps: 900 },
        after: { marketRateBps: marketRate },
      });
    });

    it('spends the step-up proof exactly once per set and per clear, and none on a refusal', async () => {
      const spent = (deps.stepUp as AllowingStepUp).spent;
      const clear = (sellerId: unknown, context: CallContext = admin) =>
        new ClearCommissionRate(gate, deps).execute(context, { sellerId });
      expect((await setRate(SELLER_A, 1000)).ok).toBe(true);
      expect(spent).toEqual([COMMISSION_PAYOUTS_RATE_EDIT.key]);
      expect((await setRate(SELLER_A, 1200)).ok).toBe(true);
      expect(spent).toHaveLength(2);
      expect((await clear(SELLER_A)).ok).toBe(true);
      expect(spent).toEqual(Array(3).fill(COMMISSION_PAYOUTS_RATE_EDIT.key));
      // Refused before the unit: a bad rate, and a caller who is not an admin.
      expect((await setRate(SELLER_A, 'x')).ok).toBe(false);
      expect((await setRate(SELLER_A, 1000, sellerA)).ok).toBe(false);
      expect((await clear(SELLER_A, sellerA)).ok).toBe(false);
      expect(spent).toHaveLength(3);
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

  describe('the lower rate for an exclusive customer (customers phase 4b)', () => {
    const rule = config.commissionPayouts!.exclusiveCustomer!;
    const lower = (rate: number) => exclusiveRateBps(rate, rule);
    const readFor = (sellerIds: unknown, exclusive: unknown, context: CallContext = customer) =>
      new CommissionRates(gate, deps).execute(context, { sellerIds, exclusive });
    const joined = T0.subtract({ hours: 24 * 30 });

    it('lowers the exclusive seller’s rate only, on its own rate or the Market’s', async () => {
      await setRate(SELLER_B, 2000);
      expect(await readFor([SELLER_A, SELLER_B], { sellerId: SELLER_A, since: joined })).toEqual(
        ok(
          new Map([
            [
              SELLER_A,
              {
                rateBps: lower(marketRate),
                standardRateBps: marketRate,
                source: 'market',
                reason: 'exclusive',
              },
            ],
            [
              SELLER_B,
              { rateBps: 2000, standardRateBps: 2000, source: 'seller', reason: 'standard' },
            ],
          ]),
        ),
      );
      expect(await readFor([SELLER_A, SELLER_B], { sellerId: SELLER_B, since: joined })).toEqual(
        ok(
          new Map([
            [
              SELLER_A,
              {
                rateBps: marketRate,
                standardRateBps: marketRate,
                source: 'market',
                reason: 'standard',
              },
            ],
            [
              SELLER_B,
              {
                rateBps: lower(2000),
                standardRateBps: 2000,
                source: 'seller',
                reason: 'exclusive',
              },
            ],
          ]),
        ),
      );
    });

    it('keeps the rate in force once the window has closed, or for a seller not asked about', async () => {
      const longAgo = T0.toZonedDateTimeISO('UTC').subtract({ months: rule.months }).toInstant();
      expect(await readFor([SELLER_A], { sellerId: SELLER_A, since: longAgo })).toEqual(
        ok(
          new Map([
            [
              SELLER_A,
              {
                rateBps: marketRate,
                standardRateBps: marketRate,
                source: 'market',
                reason: 'standard',
              },
            ],
          ]),
        ),
      );
      expect(await readFor([SELLER_A], { sellerId: SELLER_B, since: joined })).toEqual(
        ok(
          new Map([
            [
              SELLER_A,
              {
                rateBps: marketRate,
                standardRateBps: marketRate,
                source: 'market',
                reason: 'standard',
              },
            ],
          ]),
        ),
      );
      expect(await readFor([SELLER_A], null)).toEqual(
        ok(
          new Map([
            [
              SELLER_A,
              {
                rateBps: marketRate,
                standardRateBps: marketRate,
                source: 'market',
                reason: 'standard',
              },
            ],
          ]),
        ),
      );
    });

    it('answers standard when the lower rate is no lower (a rate at or under the floor)', async () => {
      await setRate(SELLER_A, rule.floorBps);
      expect(await readFor([SELLER_A], { sellerId: SELLER_A, since: joined })).toEqual(
        ok(
          new Map([
            [
              SELLER_A,
              {
                rateBps: rule.floorBps,
                standardRateBps: rule.floorBps,
                source: 'seller',
                reason: 'standard',
              },
            ],
          ]),
        ),
      );
    });

    it('has no lower rate in a Market without the setting', async () => {
      const withoutRule = {
        ...deps,
        policy: {
          settings: (m: MarketContext) => {
            const own = new ConfigCommissionPolicy(markets).settings(m);
            return own === null ? null : { ...own, exclusiveCustomer: null };
          },
        },
      };
      expect(
        await new CommissionRates(gate, withoutRule).execute(customer, {
          sellerIds: [SELLER_A],
          exclusive: { sellerId: SELLER_A, since: joined },
        }),
      ).toEqual(
        ok(
          new Map([
            [
              SELLER_A,
              {
                rateBps: marketRate,
                standardRateBps: marketRate,
                source: 'market',
                reason: 'standard',
              },
            ],
          ]),
        ),
      );
    });

    it('refuses a malformed exclusive seller', async () => {
      for (const bad of [
        'x',
        { sellerId: 'x', since: joined },
        { sellerId: SELLER_A, since: joined.toString() },
        { sellerId: SELLER_A },
      ]) {
        expect(await readFor([SELLER_A], bad)).toMatchObject({
          ok: false,
          error: { code: 'validation.failed', fields: [{ path: 'exclusive', code: 'format' }] },
        });
      }
    });
  });

  describe('review in System requests (area money)', () => {
    const reverter = () => new CommissionRateReverter(deps);
    const revert = (before: unknown, after: unknown, context: CallContext = admin) =>
      reverter().revert(context, {
        requestId: id<'SystemRequest'>(0x5e1),
        subjectRef: SELLER_A,
        before: { rateBps: before } as Record<string, null>,
        after: { rateBps: after } as Record<string, null>,
      });

    it('labels each seller by its store name for the queue, and none when unknown or unreadable', async () => {
      const names = new FakeSellerNames();
      names.names.set(SELLER_A, 'Halal Corner');
      const refs = [SELLER_A, SELLER_B, 'not-a-seller'];
      for (const labelled of [
        new CommissionRateReverter(deps, names),
        new PayoutTermsReverter(deps, names),
      ]) {
        expect([...(await labelled.describe(admin, refs))]).toEqual([[SELLER_A, 'Halal Corner']]);
      }
      names.unavailable = true;
      expect([...(await new CommissionRateReverter(deps, names).describe(admin, refs))]).toEqual(
        [],
      );
      expect([...(await reverter().describe(admin, refs))]).toEqual([]);
    });

    it("gives one seller as the impact of a seller's own rate or terms, and none for a bad ref", async () => {
      const ask = (subjectRef: string) => ({
        requestId: id<'SystemRequest'>(0x5e2),
        subjectRef,
        before: {},
        after: {},
      });
      for (const hook of [new CommissionRateReverter(deps), new PayoutTermsReverter(deps)]) {
        expect(await hook.impact(admin, ask(SELLER_A))).toEqual({
          items: [{ label: 'sellers', count: 1, atLeast: false }],
        });
        expect(await hook.impact(admin, ask('not-a-seller'))).toBeNull();
      }
    });

    it('opens nothing and needs no note where the Market does not review money', async () => {
      expect(await setRate(SELLER_A, 1000)).toMatchObject({ ok: true, value: { request: null } });
      expect(review.opened).toHaveLength(0);
    });

    it('opens a review of a set and of a removal with the rates before and after and the note', async () => {
      review.review('money', 'low');
      const set = await new SetCommissionRate(gate, deps).execute(admin, {
        sellerId: SELLER_A,
        rateBps: 1000,
        note: 'Launch deal',
      });
      expect(set).toMatchObject({ ok: true, value: { request: { number: 1 } } });
      const cleared = await new ClearCommissionRate(gate, deps).execute(admin, {
        sellerId: SELLER_A,
        note: 'Deal over',
      });
      expect(cleared).toMatchObject({ ok: true, value: { request: { number: 2 } } });
      // Money is reviewed at high risk whatever the area's policy says.
      expect(review.opened).toEqual([
        {
          area: 'money',
          subjectKind: COMMISSION_RATE_SUBJECT_KIND,
          subjectRef: SELLER_A,
          before: { rateBps: null },
          after: { rateBps: 1000 },
          note: 'Launch deal',
          risk: 'high',
        },
        {
          area: 'money',
          subjectKind: COMMISSION_RATE_SUBJECT_KIND,
          subjectRef: SELLER_A,
          before: { rateBps: 1000 },
          after: { rateBps: null },
          note: 'Deal over',
          risk: 'high',
        },
      ]);
    });

    it('refuses a change without a note where money is reviewed', async () => {
      review.review('money', 'high');
      expect(await setRate(SELLER_A, 1000)).toMatchObject({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'note' }] },
      });
      expect(review.opened).toHaveLength(0);
    });

    it('restores the rate before, or the Market rate, while the seller still has the rate after', async () => {
      await setRate(SELLER_A, 1000);
      await setRate(SELLER_A, 1200);
      audit.entries.length = 0;
      expect(await revert(1000, 1200)).toBe('reverted');
      expect(rates.rows.get(SELLER_A)).toMatchObject({ rateBps: 1000, updatedBy: ADMIN });
      expect(await revert(null, 1000)).toBe('reverted');
      expect(rates.rows.has(SELLER_A)).toBe(false);
      // Each revert is audited as such, naming the System request.
      const REQUEST = id<'SystemRequest'>(0x5e1);
      expect(audit.entries.map((entry) => [entry.action, entry.before, entry.after])).toEqual([
        [
          'commission-payouts.commission-rate.reverted',
          { rateBps: 1200 },
          { rateBps: 1000, marketRateBps: marketRate, requestId: REQUEST },
        ],
        [
          'commission-payouts.commission-rate.reverted',
          { rateBps: 1000 },
          { rateBps: null, marketRateBps: marketRate, requestId: REQUEST },
        ],
      ]);
      // A removal is undone by setting the rate again.
      expect(await revert(900, null)).toBe('reverted');
      expect(rates.rows.get(SELLER_A)).toMatchObject({ rateBps: 900 });
      expect(review.opened).toHaveLength(0);
    });

    it('answers changed-since when the rate moved on and gone for a bad value, writing nothing', async () => {
      await setRate(SELLER_A, 1000);
      expect(await revert(null, 1200)).toBe('changed-since');
      expect(await revert(800, null)).toBe('changed-since');
      expect(await revert('x', 1000)).toBe('gone');
      expect(await revert(-1, 1000)).toBe('gone');
      // Above the highest rate an admin may set today: not written back.
      expect(await revert(5000, 1000)).toBe('gone');
      expect(rates.rows.get(SELLER_A)).toMatchObject({ rateBps: 1000 });
      const notASeller = await reverter().revert(admin, {
        requestId: id<'SystemRequest'>(0x5e2),
        subjectRef: 'not-a-seller',
        before: { rateBps: null },
        after: { rateBps: 1000 },
      });
      expect(notASeller).toBe('gone');
    });

    it('throws for anyone but a signed-in admin acting as themselves', async () => {
      await setRate(SELLER_A, 1000);
      const actingAs = {
        ...admin,
        actor: { ...admin.actor, actingAs: { adminAccountId: ADMIN } },
      } as unknown as CallContext;
      for (const context of [sellerA, system, actingAs]) {
        await expect(revert(null, 1000, context)).rejects.toThrow();
      }
      expect(rates.rows.get(SELLER_A)).toMatchObject({ rateBps: 1000 });
    });
  });

  describe("the seller's own commission on an amount", () => {
    const own = (input: unknown, context: CallContext = sellerA) =>
      new OwnCommissionOn(gate, deps).execute(
        context,
        input as { amount: bigint; taxInclusive: boolean; taxRateBps: number },
      );
    const provisional = config.commissionPayouts!.provisionalTaxRateBps;

    it('uses the Market rate, then the seller rate, and the ledger rules for base and rounding', async () => {
      const first = await own({ amount: 2000n, taxInclusive: true, taxRateBps: provisional });
      const base = commissionBase(2000n, true, provisional);
      expect(first).toEqual(
        ok({
          rateBps: marketRate,
          source: 'market',
          taxRateBps: provisional,
          commissionBase: base,
          commission: commissionOn(base, marketRate),
          sellerReceives: 2000n - commissionOn(base, marketRate),
        }),
      );
      await setRate(SELLER_A, 1000);
      expect(await own({ amount: 2000n, taxInclusive: false, taxRateBps: provisional })).toEqual(
        ok({
          rateBps: 1000,
          source: 'seller',
          taxRateBps: provisional,
          commissionBase: 2000n,
          commission: 200n,
          sellerReceives: 1800n,
        }),
      );
    });

    it("takes the line's own tax rate: the same numbers the ledger posts for that line", async () => {
      await setRate(SELLER_A, 1500);
      // A GST-free line (rate 0): nothing is taken off an inclusive amount (15.90 -> 2.39).
      const free = await own({ amount: 1590n, taxInclusive: true, taxRateBps: 0 });
      expect(free).toEqual(
        ok({
          rateBps: 1500,
          source: 'seller',
          taxRateBps: 0,
          ...(() => {
            const line = lineCommission({
              amount: 1590n,
              taxInclusive: true,
              taxBps: 0,
              rateBps: 1500,
            });
            return {
              commissionBase: line.base,
              commission: line.commission,
              sellerReceives: line.sellerReceives,
            };
          })(),
        }),
      );
      expect(free.ok && free.value.commission).toBe(239n);
      // A line rate above the provisional one takes more tax off an inclusive amount.
      const high = await own({ amount: 1150n, taxInclusive: true, taxRateBps: 1500 });
      expect(high.ok && high.value).toMatchObject({
        taxRateBps: 1500,
        commissionBase: 1000n,
        commission: 150n,
        sellerReceives: 1000n,
      });
      // An amount without tax: the rate changes nothing but is reported.
      const exclusive = await own({ amount: 1000n, taxInclusive: false, taxRateBps: 0 });
      expect(exclusive.ok && exclusive.value).toMatchObject({
        commissionBase: 1000n,
        commission: 150n,
        sellerReceives: 850n,
      });
    });

    it('answers only about the signed-in seller: it takes no seller id and shows nobody else', async () => {
      await setRate(SELLER_A, 1000);
      const b = await own(
        { amount: 1000n, taxInclusive: false, taxRateBps: 0, sellerId: SELLER_A },
        sellerB,
      );
      expect(b.ok && b.value.source).toBe('market');
    });

    it('refuses everyone but a seller, and an acting-as session', async () => {
      for (const other of [admin, customer, system]) {
        expect(
          await own({ amount: 1000n, taxInclusive: false, taxRateBps: 0 }, other),
        ).toMatchObject({
          ok: false,
          error: { code: 'access.denied' },
        });
      }
      const acting = {
        ...sellerA,
        actor: { ...sellerA.actor, actingAs: { adminAccountId: ADMIN } },
      } as unknown as CallContext;
      expect(
        await own({ amount: 1000n, taxInclusive: false, taxRateBps: 0 }, acting),
      ).toMatchObject({
        ok: false,
      });
    });

    it('validates the amount, the tax flag and the tax rate', async () => {
      for (const bad of [
        { amount: -1n, taxInclusive: true },
        { amount: 10n ** 12n + 1n, taxInclusive: true },
        { amount: 100, taxInclusive: true },
        { amount: 100n, taxInclusive: 'yes' },
        { amount: 100n, taxInclusive: true, taxRateBps: -1 },
        { amount: 100n, taxInclusive: true, taxRateBps: 5001 },
        { amount: 100n, taxInclusive: true, taxRateBps: 10.5 },
        { amount: 100n, taxInclusive: true, taxRateBps: '0' },
        { amount: 100n, taxInclusive: true, taxRateBps: null },
        // Required: a preview never falls back to the provisional rate.
        { amount: 100n, taxInclusive: true },
        {},
      ]) {
        expect(await own(bad)).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
      }
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

    it('takes each line’s frozen tax rate out of its base, so a GST-free line is not reduced', async () => {
      const lines = paid().lines;
      expect(
        await record(
          paid({
            lines: [
              { ...lines[0]!, lineAmount: 1590n, taxRateBps: 0 },
              // A frozen rate unlike the Market's provisional one: the frozen one is taken out.
              { ...lines[1]!, lineAmount: 1100n, taxRateBps: 1500 },
            ],
          }),
        ),
      ).toEqual(ok('recorded'));
      const commissions = ledger.rows.filter((r) => r.kind === 'commission');
      expect(commissions.map((r) => [r.orderLineId, r.baseAmount, r.amount])).toEqual([
        [LINE_1, 1590n, money(239n, currency)],
        // 1100 / 1.15 = 956.52 -> 957; 15 % = 143.55 -> 144.
        [LINE_2, inclusive ? 957n : 1100n, money(inclusive ? 144n : 165n, currency)],
      ]);
    });

    it.each([-1, 5001, 1.5, '0', undefined])(
      'refuses a line tax rate of %p',
      async (taxRateBps) => {
        const lines = paid().lines;
        expect(
          await record(
            paid({ lines: [{ ...lines[0]!, taxRateBps: taxRateBps as number }, lines[1]!] }),
          ),
        ).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
        expect(ledger.rows).toEqual([]);
      },
    );

    it('writes a paid seller order once, and no delivery row for a free delivery', async () => {
      expect(await record(paid({ shipping: 0n }))).toEqual(ok('recorded'));
      expect(await record(paid({ shipping: 0n }))).toEqual(ok('already-recorded'));
      expect(ledger.rows.filter((r) => r.kind === 'shipping')).toEqual([]);
      expect(ledger.rows).toHaveLength(4);
    });

    it('writes no rows for a fully discounted line, and still records the order', async () => {
      const free = paid({
        lines: [
          {
            orderLineId: LINE_1,
            lineAmount: 0n,
            taxInclusive: true,
            taxRateBps: null,
            commissionRateBps: 1500,
          },
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
            {
              orderLineId: LINE_1,
              lineAmount: 100n,
              taxInclusive: true,
              taxRateBps: null,
              commissionRateBps: 3001,
            },
          ],
        }),
      );
      await refused(
        paid({
          lines: [
            {
              orderLineId: LINE_1,
              lineAmount: 100n,
              taxInclusive: true,
              taxRateBps: null,
              commissionRateBps: 1500,
            },
            {
              orderLineId: LINE_1,
              lineAmount: 100n,
              taxInclusive: true,
              taxRateBps: null,
              commissionRateBps: 1500,
            },
          ],
        }),
      );
      // A standard rate below the line's own, or not a rate, is malformed.
      for (const commissionStandardRateBps of [1499, 3001, -1, 1.5]) {
        await refused(
          paid({
            lines: [
              {
                orderLineId: LINE_1,
                lineAmount: 100n,
                taxInclusive: true,
                taxRateBps: null,
                commissionRateBps: 1500,
                commissionStandardRateBps,
              },
            ],
          }),
        );
      }
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
      const page = sellerPageDepsOf(deps, { ledger: () => ledger.rows });
      const byAdmin = await new ViewSellerLedger(gate, page).execute(admin, { sellerId: SELLER_A });
      expect(byAdmin.ok && byAdmin.value.totals).toEqual(own.ok && own.value.totals);
      expect(
        await new ViewSellerLedger(gate, page).execute(sellerB, { sellerId: SELLER_A }),
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
  describe("the seller's savings on its exclusive customers (customers phase 4b)", () => {
    const rule = config.commissionPayouts!.exclusiveCustomer!;
    const provisional = config.commissionPayouts!.provisionalTaxRateBps;
    const lowered = exclusiveRateBps(marketRate, rule);
    const base1 = commissionBase(1100n, inclusive, provisional);
    const base2 = commissionBase(335n, inclusive, provisional);
    const saved1 = commissionOn(base1, marketRate) - commissionOn(base1, lowered);
    /** Line 1 lowered for the buyer's exclusive seller (3 units), line 2 at the standard rate. */
    const exclusivePaid = (): PaidSellerOrder =>
      paid({
        lines: [
          {
            orderLineId: LINE_1,
            lineAmount: 1100n,
            taxInclusive: inclusive,
            taxRateBps: null,
            commissionRateBps: lowered,
            commissionStandardRateBps: marketRate,
          },
          {
            orderLineId: LINE_2,
            lineAmount: 335n,
            taxInclusive: inclusive,
            taxRateBps: null,
            commissionRateBps: marketRate,
            commissionStandardRateBps: null,
          },
        ],
      });
    const refundOf = (refundId: Id<'Refund'>, unitsBefore: number, units: number) =>
      new RecordRefund(gate, deps).execute(system, {
        refundId,
        orderId: ORDER,
        sellerOrderId: SELLER_ORDER,
        sellerId: SELLER_A,
        currency,
        lossBearer: 'seller',
        settledAt: T0.add({ hours: 1 }),
        lines: [{ orderLineId: LINE_1, lineQuantity: 3, unitsBefore, units }],
        shipping: null,
      });
    const view = (context: CallContext = sellerA) =>
      new ViewOwnExclusiveCommission(gate, deps).execute(context, {});

    it('keeps the saving on the lowered line only: the standard commission less what was taken', async () => {
      expect(saved1).toBeGreaterThan(0n);
      expect(await record(exclusivePaid())).toEqual(ok('recorded'));
      const commissions = ledger.rows.filter((r) => r.kind === 'commission');
      expect(
        commissions.map((r) => [r.orderLineId, r.standardRateBps ?? null, r.savedAmount ?? null]),
      ).toEqual([
        [LINE_1, marketRate, saved1],
        [LINE_2, null, null],
      ]);
      expect(commissions[0]!.amount).toEqual(money(commissionOn(base1, lowered), currency));
      expect(base2).toBeGreaterThan(0n);
    });

    it('gives the saving back with the refunds, exactly over several partial refunds', async () => {
      await record(exclusivePaid());
      expect(await refundOf(id<'Refund'>(0x411), 0, 1)).toEqual(ok('recorded'));
      expect(await refundOf(id<'Refund'>(0x412), 1, 2)).toEqual(ok('recorded'));
      const given = ledger.rows.filter((r) => r.kind === 'refund-commission');
      expect(given.every((r) => r.standardRateBps === marketRate)).toBe(true);
      expect(given.map((r) => r.savedAmount)).toEqual([
        reversedAmount(saved1, 1n, 3n),
        saved1 - reversedAmount(saved1, 1n, 3n),
      ]);
      expect(given.reduce((n, r) => n + (r.savedAmount ?? 0n), 0n)).toBe(saved1);
    });

    it("shows the seller its rule and its savings by month, net of refunds, in the Market's zone", async () => {
      await record(exclusivePaid());
      await refundOf(id<'Refund'>(0x411), 0, 1);
      const answer = await view();
      if (!answer.ok) throw new Error('refused');
      expect(answer.value.rule).toEqual({
        standardRateBps: marketRate,
        exclusiveRateBps: lowered,
        months: rule.months,
      });
      expect(answer.value.zone).toBe(config.timezone);
      expect(answer.value.months).toHaveLength(12);
      const thisMonth = T0.toZonedDateTimeISO(config.timezone).toPlainDate().toPlainYearMonth();
      expect(answer.value.months.at(-1)).toEqual({
        month: thisMonth.toString(),
        saved: [money(saved1 - reversedAmount(saved1, 1n, 3n), currency)],
      });
      expect(answer.value.months.slice(0, -1).every((m) => m.saved.length === 0)).toBe(true);
      expect(answer.value.months[0]!.month).toBe(thisMonth.subtract({ months: 11 }).toString());
    });

    it('applies the rule to the seller’s own rate, and is null in a Market without it', async () => {
      await setRate(SELLER_A, 2000);
      expect(await view()).toMatchObject({
        ok: true,
        value: { rule: { standardRateBps: 2000, exclusiveRateBps: exclusiveRateBps(2000, rule) } },
      });
      const withoutRule = {
        ...deps,
        policy: {
          settings: (m: MarketContext) => {
            const own = new ConfigCommissionPolicy(markets).settings(m);
            return own === null ? null : { ...own, exclusiveCustomer: null };
          },
        },
      };
      expect(
        await new ViewOwnExclusiveCommission(gate, withoutRule).execute(sellerA, {}),
      ).toMatchObject({
        ok: true,
        value: { rule: null },
      });
    });

    it('shows a month net of its refunds, negative when an earlier order is refunded in it', async () => {
      await record(exclusivePaid());
      // The whole lowered line refunded 40 days later: that month gives the saving back.
      const later = T0.add({ hours: 24 * 40 });
      await new RecordRefund(gate, deps).execute(system, {
        refundId: id<'Refund'>(0x421),
        orderId: ORDER,
        sellerOrderId: SELLER_ORDER,
        sellerId: SELLER_A,
        currency,
        lossBearer: 'seller',
        settledAt: later,
        lines: [{ orderLineId: LINE_1, lineQuantity: 3, unitsBefore: 0, units: 3 }],
        shipping: null,
      });
      clock.set(later);
      const answer = await view();
      if (!answer.ok) throw new Error('refused');
      expect(answer.value.months.at(-1)!.saved).toEqual([money(-saved1, currency)]);
      expect(answer.value.months.at(-2)!.saved).toEqual([money(saved1, currency)]);
      clock.set(T0);
    });

    it('shows a seller only its own savings, and refuses anyone but a seller', async () => {
      await record(exclusivePaid());
      const other = await view(sellerB);
      expect(other.ok && other.value.months.every((m) => m.saved.length === 0)).toBe(true);
      expect(await view(admin)).toEqual(err({ code: 'access.denied' }));
      expect(await view(customer)).toEqual(err({ code: 'access.denied' }));
      expect(await view(system)).toMatchObject({ ok: false });
    });
  });

  describe("a seller's cashback for its exclusive customer (customers phase 4c)", () => {
    const CREDIT = id<'PromotionCredit'>(0xc4);
    const cashback = (over: Record<string, unknown> = {}) => ({
      creditId: CREDIT,
      orderId: ORDER,
      sellerOrderId: SELLER_ORDER,
      sellerId: SELLER_A,
      amount: 70n,
      currency,
      creditedAt: T0.add({ hours: 50 }),
      ...over,
    });
    const recordCashback = (input: unknown, context: CallContext = system) =>
      new RecordSellerCashback(gate, deps).execute(context, input as never);

    it('debits the seller order once per credit and lowers the balance', async () => {
      await record();
      expect(await recordCashback(cashback())).toEqual(ok('recorded'));
      expect(await recordCashback(cashback())).toEqual(ok('already-recorded'));
      const rows = ledger.rows.filter((r) => r.kind === 'cashback-seller');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        sellerId: SELLER_A,
        sellerOrderId: SELLER_ORDER,
        orderLineId: null,
        sourceId: CREDIT,
        amount: money(70n, currency),
        rateBps: null,
        baseAmount: null,
      });
      expect(rows[0]!.occurredAt.equals(T0.add({ hours: 50 }))).toBe(true);
      const view = await new ViewOwnLedger(gate, deps).execute(sellerA, {});
      const commission =
        commissionOn(
          inclusive
            ? commissionBase(1100n, true, config.commissionPayouts!.provisionalTaxRateBps)
            : 1100n,
          1500,
        ) +
        commissionOn(
          inclusive
            ? commissionBase(335n, true, config.commissionPayouts!.provisionalTaxRateBps)
            : 335n,
          1500,
        );
      expect(view).toMatchObject({
        ok: true,
        value: { totals: { sellerCashback: 70n, balance: 1435n + 500n - commission - 70n } },
      });
      expect(
        view.ok && view.value.entries.find((e) => e.kind === 'cashback-seller')?.direction,
      ).toBe('debit');
    });

    it('refuses another seller, another order, more than the goods, or a seller order the ledger does not hold', async () => {
      await record();
      expect(await recordCashback(cashback({ sellerId: SELLER_B }))).toEqual(
        err({ code: 'commission-payouts.ledger-inconsistent' }),
      );
      expect(await recordCashback(cashback({ orderId: id<'Order'>(0xdd) }))).toEqual(
        err({ code: 'commission-payouts.ledger-inconsistent' }),
      );
      // The sales of the seller order are 1435: a cashback above them is refused.
      expect(await recordCashback(cashback({ amount: 1436n }))).toEqual(
        err({ code: 'commission-payouts.ledger-inconsistent' }),
      );
      expect(await recordCashback(cashback({ sellerOrderId: id<'SellerOrder'>(0x5ff) }))).toEqual(
        err({ code: 'commission-payouts.ledger-inconsistent' }),
      );
      expect(ledger.rows.some((r) => r.kind === 'cashback-seller')).toBe(false);
    });

    it('refuses malformed facts, another currency, and any caller but the system', async () => {
      await record();
      const fieldsOf = async (input: unknown, context: CallContext = system) => {
        const result = await recordCashback(input, context);
        return !result.ok && 'fields' in result.error
          ? result.error.fields.map((f) => `${f.path}:${f.code}`)
          : result;
      };
      expect(await fieldsOf(cashback({ amount: 0n }))).toEqual(['amount:range']);
      expect(await fieldsOf(cashback({ amount: 70 }))).toEqual(['amount:range']);
      expect(await fieldsOf(cashback({ creditId: 'x' }))).toEqual(['creditId:format']);
      expect(await fieldsOf(cashback({ currency: currency === 'AUD' ? 'JPY' : 'AUD' }))).toEqual([
        'currency:value',
      ]);
      expect(await fieldsOf(cashback({ creditedAt: '2026-10-14T10:00:00Z' }))).toEqual([
        'creditedAt:type',
      ]);
      for (const context of [admin, sellerA, customer]) {
        expect(await recordCashback(cashback(), context)).toMatchObject({ ok: false });
      }
      expect(ledger.rows.some((r) => r.kind === 'cashback-seller')).toBe(false);
    });
  });

  describe("a seller's cashback returned after a refund (customers phase 4c-2)", () => {
    const CREDIT = id<'PromotionCredit'>(0xc4);
    const CLAWBACK_1 = id<'CreditClawback'>(0xcb1);
    const CLAWBACK_2 = id<'CreditClawback'>(0xcb2);
    const returned = (over: Record<string, unknown> = {}) => ({
      clawbackId: CLAWBACK_1,
      creditId: CREDIT,
      orderId: ORDER,
      sellerOrderId: SELLER_ORDER,
      sellerId: SELLER_A,
      amount: 30n,
      currency,
      returnedAt: T0.add({ hours: 400 }),
      ...over,
    });
    const recordReturn = (input: unknown, context: CallContext = system) =>
      new RecordSellerCashbackReturn(gate, deps).execute(context, input as never);
    const withCashback = async () => {
      await record();
      await new RecordSellerCashback(gate, deps).execute(system, {
        creditId: CREDIT,
        orderId: ORDER,
        sellerOrderId: SELLER_ORDER,
        sellerId: SELLER_A,
        amount: 70n,
        currency,
        creditedAt: T0.add({ hours: 50 }),
      });
    };

    it('announces the cashback and its return once each, and nothing for a refused one', async () => {
      await withCashback();
      expect(await recordReturn(returned())).toEqual(ok('recorded'));
      expect(await recordReturn(returned())).toEqual(ok('already-recorded'));
      // Another seller's return is refused and publishes nothing.
      expect(
        await recordReturn(returned({ clawbackId: CLAWBACK_2, sellerId: SELLER_B })),
      ).toMatchObject({ ok: false });
      const posted = (deps.outbox as unknown as RecordingCpOutbox).events
        .filter((event) => event.type === 'commission-payouts.ledger-recorded.v1')
        .map((event) => {
          const payload = event.payload as Record<string, unknown>;
          return [payload.cause, payload.sourceId, payload.sellerId];
        });
      expect(posted).toEqual([
        ['paid', null, SELLER_A],
        ['cashback', CREDIT, SELLER_A],
        ['cashback-return', CLAWBACK_1, SELLER_A],
      ]);
    });

    it('credits the seller once per clawback and nets it off the cashback total', async () => {
      await withCashback();
      expect(await recordReturn(returned())).toEqual(ok('recorded'));
      expect(await recordReturn(returned())).toEqual(ok('already-recorded'));
      const rows = ledger.rows.filter((r) => r.kind === 'refund-cashback-seller');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        sourceId: CLAWBACK_1,
        orderLineId: null,
        amount: money(30n, currency),
      });
      const view = await new ViewOwnLedger(gate, deps).execute(sellerA, {});
      expect(view).toMatchObject({ ok: true, value: { totals: { sellerCashback: 40n } } });
      expect(
        view.ok && view.value.entries.find((e) => e.kind === 'refund-cashback-seller')?.direction,
      ).toBe('credit');
    });

    it('never returns more than the cashback, in all, nor one of another seller, order or credit', async () => {
      await withCashback();
      expect(await recordReturn(returned({ amount: 50n }))).toEqual(ok('recorded'));
      expect(await recordReturn(returned({ clawbackId: CLAWBACK_2, amount: 21n }))).toEqual(
        err({ code: 'commission-payouts.ledger-inconsistent' }),
      );
      expect(await recordReturn(returned({ clawbackId: CLAWBACK_2, amount: 20n }))).toEqual(
        ok('recorded'),
      );
      const inconsistent = err({ code: 'commission-payouts.ledger-inconsistent' });
      const third = id<'CreditClawback'>(0xcb3);
      expect(await recordReturn(returned({ clawbackId: third, amount: 1n }))).toEqual(inconsistent);
      expect(
        await recordReturn(returned({ clawbackId: third, sellerId: SELLER_B, amount: 1n })),
      ).toEqual(inconsistent);
      expect(
        await recordReturn(returned({ clawbackId: third, creditId: id<'PromotionCredit'>(0xee) })),
      ).toEqual(inconsistent);
    });

    it('refuses malformed facts and any caller but the system', async () => {
      await withCashback();
      expect(await recordReturn(returned({ clawbackId: 'x' }))).toMatchObject({
        ok: false,
        error: { code: 'validation.failed' },
      });
      expect(await recordReturn(returned({ amount: 0n }))).toMatchObject({
        ok: false,
        error: { code: 'validation.failed' },
      });
      for (const context of [admin, sellerA, customer]) {
        expect(await recordReturn(returned(), context)).toMatchObject({ ok: false });
      }
      expect(ledger.rows.some((r) => r.kind === 'refund-cashback-seller')).toBe(false);
    });
  });

  it('says a seller order is lost when the platform bore a lost chargeback on it (Hassan L-6)', async () => {
    await record();
    await deps.anchors.insertIfAbsent(market, {
      sellerOrderId: SELLER_ORDER,
      orderId: ORDER,
      sellerId: SELLER_A,
      deliveredAt: T0,
      source: 'seller-click',
      holdDaysApplied: 14,
      eligibleAt: T0.add({ hours: 24 * 14 }),
      recordedAt: T0,
    });
    const anchorOf = () =>
      new SellerOrderPayoutAnchorQuery(gate, deps).execute(system, SELLER_ORDER);
    expect(await anchorOf()).toMatchObject({ ok: true, value: { disputeLost: false } });
    (deps.disputes as MemoryDisputeDecisions).decisions.push({
      id: id<'DisputeDecision'>(0xdd1),
      disputeId: id<'Dispute'>(0xdd2),
      sellerOrderId: SELLER_ORDER,
      sellerId: SELLER_A,
      bearer: 'platform',
      amount: null,
      reasonCode: 'platform-goodwill' as never,
      decidedBy: id<'Account'>(0xad),
      decidedAt: T0,
      supersedes: null,
    });
    expect(await anchorOf()).toMatchObject({ ok: true, value: { disputeLost: true } });
  });

  describe("a seller order's payout release, for promotions (customers phase 4c)", () => {
    const anchorOf = (sellerOrderId: unknown, context: CallContext = system) =>
      new SellerOrderPayoutAnchorQuery(gate, deps).execute(context, sellerOrderId as never);
    const anchor = (sellerId: Id<'Seller'> = SELLER_A) => ({
      sellerOrderId: SELLER_ORDER,
      orderId: ORDER,
      sellerId,
      deliveredAt: T0,
      source: 'seller-click' as const,
      holdDaysApplied: 14,
      eligibleAt: T0.add({ hours: 24 * 14 }),
      recordedAt: T0,
    });

    it('answers the anchor of a seller order the ledger holds, by its seller', async () => {
      await record();
      await deps.anchors.insertIfAbsent(market, anchor());
      expect(await anchorOf(SELLER_ORDER)).toEqual(
        ok({
          orderId: ORDER,
          sellerOrderId: SELLER_ORDER,
          sellerId: SELLER_A,
          eligibleAt: T0.add({ hours: 24 * 14 }),
          onHold: false,
          disputeLost: false,
        }),
      );
    });

    it('says when a payout hold covers the seller order and when a chargeback took its money (Hassan M-2)', async () => {
      await record();
      await deps.anchors.insertIfAbsent(market, anchor());
      const hold = (sellerOrderId: Id<'SellerOrder'> | null, n: number) =>
        deps.holds.insertIfAbsent(market, {
          id: id<'PayoutHold'>(0x900 + n),
          sellerId: SELLER_A,
          sellerOrderId,
          reason: 'dispute',
          origin: 'system',
          sourceRef: `dispute-${n}`,
          placedBy: null,
          placedAt: T0,
          releasedAt: null,
          releasedBy: null,
          releaseReason: null,
        });
      const read = async () => {
        const answer = await anchorOf(SELLER_ORDER);
        return answer.ok ? { onHold: answer.value.onHold, lost: answer.value.disputeLost } : null;
      };
      // A hold on another seller order of the seller does not count.
      await hold(id<'SellerOrder'>(0x5fe), 1);
      expect(await read()).toEqual({ onHold: false, lost: false });
      await hold(SELLER_ORDER, 2);
      expect(await read()).toEqual({ onHold: true, lost: false });
      await deps.holds.releaseBySource(market, 'dispute', 'dispute-2', {
        releasedAt: T0,
        releasedBy: null,
        reason: 'resolved',
      });
      expect(await read()).toEqual({ onHold: false, lost: false });
      // A hold on the whole seller covers it too.
      await hold(null, 3);
      expect(await read()).toEqual({ onHold: true, lost: false });
      const sale = ledger.rows.find((r) => r.kind === 'sale')!;
      const debit = (kind: 'dispute-debit' | 'dispute-reinstate', n: number, amount: bigint) =>
        deps.ledger.append(market, [
          {
            ...sale,
            id: id<'LedgerEntry'>(0x950 + n),
            kind,
            orderLineId: null,
            amount: { ...sale.amount, amount },
            sourceId: id<'Dispute'>(0x960),
          },
        ]);
      await debit('dispute-debit', 1, 500n);
      expect((await read())?.lost).toBe(true);
      await debit('dispute-reinstate', 2, 500n);
      expect((await read())?.lost).toBe(false);
    });

    it('is not anchored without the ledger rows, without an anchor, or with another seller', async () => {
      const notAnchored = err({ code: 'commission-payouts.not-anchored' });
      await deps.anchors.insertIfAbsent(market, anchor());
      expect(await anchorOf(SELLER_ORDER)).toEqual(notAnchored);
      await record();
      expect(await anchorOf(id<'SellerOrder'>(0x5ff))).toEqual(notAnchored);
    });

    it('refuses a malformed id and every caller but the system', async () => {
      expect(await anchorOf('nope')).toEqual(err({ code: 'validation.failed' }));
      for (const context of [admin, sellerA, customer]) {
        expect((await anchorOf(SELLER_ORDER, context)).ok).toBe(false);
      }
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

    it('announces each posting that wrote rows, ids and cause only, and none on a replay', async () => {
      const posted = () =>
        (deps.outbox as unknown as RecordingCpOutbox).events
          .filter((event) => event.type === 'commission-payouts.ledger-recorded.v1')
          .map((event) => {
            const { postingId, ...rest } = event.payload as Record<string, unknown>;
            expect(typeof postingId).toBe('string');
            return rest;
          });
      const ids = { sellerOrderId: SELLER_ORDER, sellerId: SELLER_A, orderId: ORDER };
      // The paid seller order of the beforeEach was announced once.
      expect(posted()).toEqual([{ ...ids, cause: 'paid', sourceId: null }]);
      expect(await record()).toEqual(ok('already-recorded'));
      expect(await recordRefund(refunded())).toEqual(ok('recorded'));
      expect(await recordRefund(refunded())).toEqual(ok('already-recorded'));
      // The platform bears this one: nothing is posted, nothing announced.
      expect(await recordRefund(refunded({ refundId: REFUND_2, lossBearer: 'platform' }))).toEqual(
        ok('nothing-to-post'),
      );
      expect(posted()).toEqual([
        { ...ids, cause: 'paid', sourceId: null },
        { ...ids, cause: 'refund', sourceId: REFUND_1 },
      ]);
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
            {
              orderLineId: line,
              lineAmount: 1n,
              taxInclusive: false,
              taxRateBps: null,
              commissionRateBps: 1500,
            },
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
            {
              orderLineId: LINE_1,
              lineAmount: 0n,
              taxInclusive: true,
              taxRateBps: null,
              commissionRateBps: 1500,
            },
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
