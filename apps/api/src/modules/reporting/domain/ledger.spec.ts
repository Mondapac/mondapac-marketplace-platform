import { Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import type { MarketDay } from './facts';
import {
  checkDayRange,
  checkLedgerFact,
  EMPTY_LEDGER_SUMS,
  ledgerReadinessOf,
  matchLedgerDays,
  netRevenueOf,
  netRevenueTotalOf,
  READINESS_MIN_MATCHED_SELLER_ORDERS,
  readinessWindow,
  rollUpLedgerDay,
  sellerNetEarningsOf,
  type LedgerFact,
  type LedgerFactKind,
  type LedgerKindSums,
} from './ledger';

// The ledger facts of reporting (dashboards v2, phase 1, PR 4), for both Market fixtures (AUD with
// cents, JPY with none): the daily rollup, net revenue with its missing components never shown as
// 0, a refund's commission given back with the opposite sign, a seller's cashback taken from its
// net earnings, the "matching ledger" readiness and the 13-month range check.

const day = (text: string): MarketDay => text as MarketDay;
const SELLER = '01900000-0000-7000-8000-000000000001' as Id<'Seller'>;
let next = 0;
const entryId = () =>
  `01900000-0000-7000-8000-${String(++next).padStart(12, '0')}` as Id<'LedgerEntry'>;

describe.each([
  ['AU', 'AUD'],
  ['ZZ', 'JPY'],
])('ledger facts in market %s', (_market, currency) => {
  const fact = (
    kind: LedgerFactKind,
    amount: bigint,
    baseAmount: bigint | null,
    sellerOrder = 'a',
  ): LedgerFact => ({
    entryId: entryId(),
    sellerOrderId:
      `01900000-0000-7000-9000-00000000000${sellerOrder === 'a' ? 1 : 2}` as Id<'SellerOrder'>,
    sellerId: SELLER,
    kind,
    currency,
    amount,
    baseAmount,
    occurredAt: Temporal.Instant.from('2026-11-20T01:00:00Z'),
    marketDay: day('2026-11-20'),
  });

  const sums = (partial: Partial<LedgerKindSums>): LedgerKindSums => ({
    ...EMPTY_LEDGER_SUMS,
    ...partial,
  });

  it('rolls a seller day up per kind with distinct seller orders and the commission base', () => {
    const rows = rollUpLedgerDay([
      fact('commission', 150n, 1000n, 'a'),
      fact('commission', 30n, 200n, 'a'),
      fact('commission', 75n, 500n, 'b'),
      fact('refund-commission', 15n, 100n, 'a'),
      fact('cashback-seller', 40n, null, 'b'),
    ]);
    expect(rows).toEqual([
      {
        currency,
        kind: 'cashback-seller',
        entries: 1,
        sellerOrders: 1,
        amount: 40n,
        baseAmount: 0n,
      },
      {
        currency,
        kind: 'commission',
        entries: 3,
        sellerOrders: 2,
        amount: 255n,
        baseAmount: 1700n,
      },
      {
        currency,
        kind: 'refund-commission',
        entries: 1,
        sellerOrders: 1,
        amount: 15n,
        baseAmount: 100n,
      },
    ]);
    expect(rollUpLedgerDay([])).toEqual([]);
  });

  it('refuses a malformed fact', () => {
    expect(() => checkLedgerFact(fact('commission', 10n, null))).toThrow(RangeError);
    expect(() => checkLedgerFact(fact('commission', 11n, 10n))).toThrow(RangeError);
    expect(() => checkLedgerFact(fact('cashback-seller', 10n, 10n))).toThrow(RangeError);
    expect(() => checkLedgerFact(fact('refund-commission', -1n, 10n))).toThrow(RangeError);
    expect(() => checkLedgerFact(fact('refund-commission', 1n, 10n))).not.toThrow();
  });

  it('nets the commission of refunds and marks every component without a source', () => {
    const revenue = netRevenueOf(
      sums({
        commission: { amount: 1500n, baseAmount: 10000n },
        'refund-commission': { amount: 300n, baseAmount: 2000n },
        // A seller's cashback is the seller's money: it never lowers the platform's revenue.
        'cashback-seller': { amount: 999n, baseAmount: 0n },
      }),
      currency,
    );
    expect(revenue.currency).toBe(currency);
    expect(revenue.commissionCharged).toBe(1500n);
    expect(revenue.commissionRefunded).toBe(300n);
    // A refund's commission is given back: it lowers the revenue (the opposite sign).
    expect(revenue.components.commission).toEqual({ status: 'available', amount: 1200n });
    expect(revenue.components.deliveryMargin).toEqual({
      status: 'not-available',
      reason: 'not-reported',
    });
    expect(revenue.components.platformFundedDiscounts.status).toBe('not-available');
    expect(revenue.components.platformFundedCashback.status).toBe('not-available');
    expect(revenue.components.fleetFees).toEqual({
      status: 'not-available',
      reason: 'not-recorded',
    });
    // Partial: no amount at all, so the commission alone can never be shown as the total.
    expect(revenue.total).toEqual({
      status: 'partial',
      missing: ['deliveryMargin', 'platformFundedDiscounts', 'platformFundedCashback', 'fleetFees'],
    });
    expect(revenue.total).not.toHaveProperty('amount');
  });

  it('totals the components with their sign only when every one is available', () => {
    const amount = (value: bigint) => ({ status: 'available' as const, amount: value });
    expect(
      netRevenueTotalOf({
        commission: amount(1200n),
        deliveryMargin: amount(300n),
        platformFundedDiscounts: amount(100n),
        platformFundedCashback: amount(50n),
        fleetFees: amount(25n),
      }),
    ).toEqual({ status: 'complete', amount: 1325n });
    expect(
      netRevenueTotalOf({
        commission: amount(1200n),
        deliveryMargin: amount(300n),
        platformFundedDiscounts: amount(100n),
        platformFundedCashback: amount(50n),
        fleetFees: { status: 'not-available', reason: 'not-recorded' },
      }),
    ).toEqual({ status: 'partial', missing: ['fleetFees'] });
  });

  it('can go below zero when a range refunds more commission than it charged', () => {
    const revenue = netRevenueOf(
      sums({ 'refund-commission': { amount: 50n, baseAmount: 400n } }),
      currency,
    );
    expect(revenue.components.commission).toEqual({ status: 'available', amount: -50n });
  });

  it("works a seller's net earnings out of its own ledger, without GST", () => {
    const earnings = sellerNetEarningsOf(
      sums({
        commission: { amount: 1500n, baseAmount: 10000n },
        'refund-commission': { amount: 300n, baseAmount: 2000n },
        'cashback-seller': { amount: 500n, baseAmount: 0n },
        'refund-cashback-seller': { amount: 100n, baseAmount: 0n },
      }),
      currency,
    );
    expect(earnings).toEqual({
      currency,
      salesWithoutTax: 10000n,
      refundedSalesWithoutTax: 2000n,
      commission: 1200n,
      sellerCashback: 400n,
      // 10000 - 2000 - 1200 - 400
      netEarnings: 6400n,
    });
    expect(sellerNetEarningsOf(EMPTY_LEDGER_SUMS, currency).netEarnings).toBe(0n);
  });
});

describe.each([
  ['AU', '2026-11-23'],
  ['ZZ', '2026-11-23'],
])('readiness in market %s', (market, todayText) => {
  const window = readinessWindow(day(todayText));
  const all = (days: readonly string[], id: string) =>
    days.map((text) => ({ sellerOrderId: `${market}-${id}-${text}`, day: day(text) }));
  const days = [
    '2026-11-16',
    '2026-11-17',
    '2026-11-18',
    '2026-11-19',
    '2026-11-20',
    '2026-11-21',
    '2026-11-22',
  ];
  const done = { finished: true, failedFacts: 0 };

  it('looks at the seven Market days ending yesterday', () => {
    expect(window).toEqual({ from: '2026-11-16', to: '2026-11-22' });
  });

  it('is ready when the backfill finished clean, every day matches and enough orders matched', () => {
    // Seven matched seller orders, all on the last five days: the first two days are empty.
    const orders = [...all(days.slice(2), 'x'), ...all(days.slice(5), 'y')];
    expect(orders).toHaveLength(READINESS_MIN_MATCHED_SELLER_ORDERS);
    const matched = matchLedgerDays(window, orders, orders, new Set());
    expect(matched).toHaveLength(7);
    expect(matched.every((row) => row.matches)).toBe(true);
    expect(matched[0]).toMatchObject({ paidSellerOrders: 0, ledgerSellerOrders: 0 });
    expect(ledgerReadinessOf(done, window, matched)).toMatchObject({
      ready: true,
      reason: 'ready',
      matchedSellerOrders: 7,
      backfillFailedFacts: 0,
    });
    expect(ledgerReadinessOf({ finished: false, failedFacts: 0 }, window, matched)).toMatchObject({
      ready: false,
      reason: 'backfill-not-finished',
    });
  });

  it('is not ready on an empty week, nor below the minimum of matched orders', () => {
    const empty = matchLedgerDays(window, [], [], new Set());
    expect(empty.every((row) => row.matches)).toBe(true);
    expect(ledgerReadinessOf(done, window, empty)).toMatchObject({
      ready: false,
      reason: 'insufficient-activity',
      matchedSellerOrders: 0,
    });
    const few = all(days.slice(1), 'x');
    expect(few).toHaveLength(READINESS_MIN_MATCHED_SELLER_ORDERS - 1);
    expect(
      ledgerReadinessOf(done, window, matchLedgerDays(window, few, few, new Set())),
    ).toMatchObject({ ready: false, reason: 'insufficient-activity', matchedSellerOrders: 6 });
  });

  it('is not ready when the backfill refused a row, however well the days match', () => {
    const orders = [...all(days, 'x'), ...all(days, 'y')];
    const matched = matchLedgerDays(window, orders, orders, new Set());
    expect(ledgerReadinessOf({ finished: true, failedFacts: 1 }, window, matched)).toMatchObject({
      ready: false,
      reason: 'backfill-refused-rows',
      backfillFailedFacts: 1,
    });
  });

  it('is not ready while a paid seller order has no commission fact on its day', () => {
    const paid = [...all(days, 'x'), ...all(days, 'y')];
    const matched = matchLedgerDays(window, paid, paid.slice(1), new Set());
    expect(matched[0]).toMatchObject({ day: '2026-11-16', missingInLedger: 1, matches: false });
    expect(ledgerReadinessOf(done, window, matched)).toMatchObject({
      ready: false,
      reason: 'days-not-matching',
      matchedSellerOrders: 13,
    });
  });

  it('counts a commission fact the sales facts do not hold as paid, unless held unpaid', () => {
    const extra = [{ sellerOrderId: 'cancelled-first', day: day('2026-11-20') }];
    expect(matchLedgerDays(window, [], extra, new Set())[4]).toMatchObject({
      missingInSales: 1,
      matches: false,
    });
    expect(matchLedgerDays(window, [], extra, new Set(['cancelled-first']))[4]).toMatchObject({
      missingInSales: 0,
      matches: true,
    });
  });

  it('does not match a commission fact on another day than the payment', () => {
    const matched = matchLedgerDays(
      window,
      [{ sellerOrderId: 'a', day: day('2026-11-20') }],
      [{ sellerOrderId: 'a', day: day('2026-11-21') }],
      new Set(),
    );
    expect(matched[4]).toMatchObject({ missingInLedger: 1 });
    expect(matched[5]).toMatchObject({ missingInSales: 1 });
  });
});

describe('checkDayRange', () => {
  const today = day('2026-11-23');
  it('accepts a range up to today of at most 13 months', () => {
    expect(checkDayRange({ from: '2026-11-01', to: '2026-11-23' }, today)).toEqual({
      from: '2026-11-01',
      to: '2026-11-23',
    });
    expect(checkDayRange({ from: '2025-10-24', to: '2026-11-23' }, today)).not.toBeNull();
  });
  it('refuses a reversed, future, malformed or too long range', () => {
    expect(checkDayRange({ from: '2026-11-10', to: '2026-11-09' }, today)).toBeNull();
    expect(checkDayRange({ from: '2026-11-10', to: '2026-11-24' }, today)).toBeNull();
    expect(checkDayRange({ from: '2026-02-30', to: '2026-03-01' }, today)).toBeNull();
    expect(checkDayRange({ from: '2025-10-23', to: '2026-11-23' }, today)).toBeNull();
    expect(checkDayRange(null, today)).toBeNull();
    expect(checkDayRange({ from: 20261101, to: '2026-11-23' }, today)).toBeNull();
  });
});
