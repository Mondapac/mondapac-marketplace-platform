import { Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import type { MarketDay } from './facts';
import { daysOf, type DayRange } from './period';

// The ledger facts of reporting (dashboards v2, phase 1, PR 4): the commission and seller-cashback
// rows of commission-payouts' seller ledger, as read through its reporting facade, their daily
// rollup, and what the dashboards build from them: Mondapac's net revenue, a seller's net earnings
// and the "matching ledger" readiness that gates both (FE-066). Money is minor units with its
// currency, never with GST: the commission is worked out on goods without GST by the ledger, and
// the cashback is wallet credit, which carries none.

/** The ledger kinds reporting records (commission-payouts' `LEDGER_REPORT_KINDS`). */
export const LEDGER_FACT_KINDS = [
  'commission',
  'refund-commission',
  'cashback-seller',
  'refund-cashback-seller',
] as const;
export type LedgerFactKind = (typeof LEDGER_FACT_KINDS)[number];

export const isLedgerFactKind = (value: unknown): value is LedgerFactKind =>
  typeof value === 'string' && (LEDGER_FACT_KINDS as readonly string[]).includes(value);

/** The kinds that carry a commission base (goods without GST). */
const BASED: ReadonlySet<LedgerFactKind> = new Set(['commission', 'refund-commission']);

/**
 * One ledger row as reporting stores it. Immutable, like the row it copies: `amount` is never
 * negative and the kind gives the direction, as in the ledger. `baseAmount` is set for the two
 * commission kinds only. `marketDay` is the day of `occurredAt` in the Market's zone.
 */
export interface LedgerFact {
  readonly entryId: Id<'LedgerEntry'>;
  readonly sellerOrderId: Id<'SellerOrder'>;
  readonly sellerId: Id<'Seller'>;
  readonly kind: LedgerFactKind;
  readonly currency: string;
  readonly amount: bigint;
  readonly baseAmount: bigint | null;
  readonly occurredAt: Temporal.Instant;
  readonly marketDay: MarketDay;
}

/**
 * Refuses a malformed fact (a programming error upstream): a negative amount, a base on a cashback
 * row or none on a commission row, a commission above its base. Throws a `RangeError`, which the
 * backfill counts as a refused fact.
 */
export function checkLedgerFact(fact: LedgerFact): void {
  const based = BASED.has(fact.kind);
  if (
    !isLedgerFactKind(fact.kind) ||
    typeof fact.amount !== 'bigint' ||
    fact.amount < 0n ||
    (based &&
      (fact.baseAmount === null || fact.baseAmount < 0n || fact.amount > fact.baseAmount)) ||
    (!based && fact.baseAmount !== null)
  ) {
    throw new RangeError(`reporting: ledger entry ${fact.entryId} is malformed`);
  }
}

/** Whether a fact read again is the stored one (a ledger row never changes). */
export const sameLedgerFact = (a: LedgerFact, b: LedgerFact): boolean =>
  a.entryId === b.entryId &&
  a.sellerOrderId === b.sellerOrderId &&
  a.sellerId === b.sellerId &&
  a.kind === b.kind &&
  a.currency === b.currency &&
  a.amount === b.amount &&
  a.baseAmount === b.baseAmount &&
  a.occurredAt.epochMilliseconds === b.occurredAt.epochMilliseconds &&
  a.marketDay === b.marketDay;

/** A row of `reporting.daily_ledger`, without its day, seller and refresh time. */
export interface LedgerDayTotals {
  readonly currency: string;
  readonly kind: LedgerFactKind;
  readonly entries: number;
  /** Distinct seller orders with a row of this kind on the day. */
  readonly sellerOrders: number;
  readonly amount: bigint;
  /** The sum of the commission bases; 0 for the cashback kinds. */
  readonly baseAmount: bigint;
}

/** The rollup of one seller's day: one row per currency and kind with a fact, in a stable order. */
export function rollUpLedgerDay(facts: readonly LedgerFact[]): LedgerDayTotals[] {
  const rows = new Map<string, LedgerDayTotals & { readonly orders: Set<string> }>();
  for (const fact of facts) {
    const key = `${fact.currency}|${fact.kind}`;
    const row = rows.get(key) ?? {
      currency: fact.currency,
      kind: fact.kind,
      entries: 0,
      sellerOrders: 0,
      amount: 0n,
      baseAmount: 0n,
      orders: new Set<string>(),
    };
    row.orders.add(fact.sellerOrderId);
    rows.set(key, {
      ...row,
      entries: row.entries + 1,
      sellerOrders: row.orders.size,
      amount: row.amount + fact.amount,
      baseAmount: row.baseAmount + (fact.baseAmount ?? 0n),
    });
  }
  return [...rows.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([, row]) => ({
      currency: row.currency,
      kind: row.kind,
      entries: row.entries,
      sellerOrders: row.sellerOrders,
      amount: row.amount,
      baseAmount: row.baseAmount,
    }));
}

/** The sums of one range per kind, as the rollup holds them (amounts positive, as stored). */
export type LedgerKindSums = Readonly<
  Record<LedgerFactKind, { readonly amount: bigint; readonly baseAmount: bigint }>
>;

export const EMPTY_LEDGER_SUMS: LedgerKindSums = {
  commission: { amount: 0n, baseAmount: 0n },
  'refund-commission': { amount: 0n, baseAmount: 0n },
  'cashback-seller': { amount: 0n, baseAmount: 0n },
  'refund-cashback-seller': { amount: 0n, baseAmount: 0n },
};

/** Why a component of net revenue has no number. Never shown as 0. */
export type NotAvailableReason =
  /** The platform records it, but no facade or event brings it to reporting yet. */
  | 'not-reported'
  /** The platform does not record it at all yet. */
  | 'not-recorded';

/** A money component: a number, or explicitly none (never a silent 0). */
export type LedgerComponent =
  | { readonly status: 'available'; readonly amount: bigint }
  | { readonly status: 'not-available'; readonly reason: NotAvailableReason };

const available = (amount: bigint): LedgerComponent => ({ status: 'available', amount });
const notAvailable = (reason: NotAvailableReason): LedgerComponent => ({
  status: 'not-available',
  reason,
});

/** The components of net revenue that are added, and those taken away. */
export const NET_REVENUE_COMPONENTS = [
  'commission',
  'deliveryMargin',
  'platformFundedDiscounts',
  'platformFundedCashback',
  'fleetFees',
] as const;
export type NetRevenueComponent = (typeof NET_REVENUE_COMPONENTS)[number];

/**
 * The total of net revenue: a number only when every component has one. While any is missing it
 * carries no amount at all, only the names of the missing components, so a partial sum can never
 * be shown as the total; the available components keep their own amounts under their own labels.
 */
export type NetRevenueTotal =
  | { readonly status: 'complete'; readonly amount: bigint }
  | { readonly status: 'partial'; readonly missing: readonly NetRevenueComponent[] };

/**
 * Mondapac's net revenue of a range, without GST: commission + delivery margin − platform-funded
 * discounts − platform-funded cashback − fleet fees (design: dashboards v2 KPI definitions).
 * Every component is positive as named; `total` adds them with their sign only when all are
 * available ({@link NetRevenueTotal}).
 */
export interface NetRevenue {
  readonly currency: string;
  /** Commission charged on the range's paid goods (without GST), before refunds. */
  readonly commissionCharged: bigint;
  /** Commission given back by the range's seller-borne refunds. */
  readonly commissionRefunded: bigint;
  readonly components: Readonly<Record<NetRevenueComponent, LedgerComponent>>;
  readonly total: NetRevenueTotal;
}

/**
 * Net revenue from the range's ledger sums. Only the commission has a source in reporting today:
 * - delivery margin: ordering freezes it on each seller order's delivery quote, but its reporting
 *   facade does not carry it (`not-reported`);
 * - platform-funded discounts: ordering keeps the platform's share of each line discount and the
 *   delivery discount, which no facade carries (`not-reported`);
 * - platform-funded cashback: promotions knows which credits the platform funds, which no facade
 *   carries (`not-reported`);
 * - fleet fees: what the platform pays a fleet beyond the quote is not recorded anywhere
 *   (`not-recorded`).
 */
export function netRevenueOf(sums: LedgerKindSums, currency: string): NetRevenue {
  const commissionCharged = sums.commission.amount;
  const commissionRefunded = sums['refund-commission'].amount;
  const components: Record<NetRevenueComponent, LedgerComponent> = {
    commission: available(commissionCharged - commissionRefunded),
    deliveryMargin: notAvailable('not-reported'),
    platformFundedDiscounts: notAvailable('not-reported'),
    platformFundedCashback: notAvailable('not-reported'),
    fleetFees: notAvailable('not-recorded'),
  };
  return {
    currency,
    commissionCharged,
    commissionRefunded,
    components,
    total: netRevenueTotalOf(components),
  };
}

/** The total of the components: complete with its amount, or partial with what is missing. */
export function netRevenueTotalOf(
  components: Readonly<Record<NetRevenueComponent, LedgerComponent>>,
): NetRevenueTotal {
  const sign: Record<NetRevenueComponent, bigint> = {
    commission: 1n,
    deliveryMargin: 1n,
    platformFundedDiscounts: -1n,
    platformFundedCashback: -1n,
    fleetFees: -1n,
  };
  let amount = 0n;
  const missing: NetRevenueComponent[] = [];
  for (const name of NET_REVENUE_COMPONENTS) {
    const component = components[name];
    if (component.status === 'available') amount += sign[name] * component.amount;
    else missing.push(name);
  }
  return missing.length === 0 ? { status: 'complete', amount } : { status: 'partial', missing };
}

/**
 * A seller's net earnings of a range, without GST: sales less commission, fees and refunds
 * (design: dashboards v2 KPI definitions), all from the seller's own ledger rows, so they agree
 * with what its payouts are built from.
 * - `salesWithoutTax` is the commission base of the range's paid goods: the goods the seller is
 *   paid for (after the seller's share of discounts), without GST (the ledger's provisional tax
 *   until the tax module gives each line's exact tax).
 * - `refundedSalesWithoutTax` is the base of the range's seller-borne refunds; a refund the
 *   platform bears takes nothing from the seller, so it is not here.
 * - `commission` is net of what refunds gave back; `sellerCashback` is net of what refunds
 *   returned. Card fees are the platform's (they never reach the seller ledger).
 * - The seller's delivery fees are not part of it (the definition counts goods).
 */
export interface SellerNetEarnings {
  readonly currency: string;
  readonly salesWithoutTax: bigint;
  readonly refundedSalesWithoutTax: bigint;
  readonly commission: bigint;
  readonly sellerCashback: bigint;
  readonly netEarnings: bigint;
}

export function sellerNetEarningsOf(sums: LedgerKindSums, currency: string): SellerNetEarnings {
  const salesWithoutTax = sums.commission.baseAmount;
  const refundedSalesWithoutTax = sums['refund-commission'].baseAmount;
  const commission = sums.commission.amount - sums['refund-commission'].amount;
  const sellerCashback = sums['cashback-seller'].amount - sums['refund-cashback-seller'].amount;
  return {
    currency,
    salesWithoutTax,
    refundedSalesWithoutTax,
    commission,
    sellerCashback,
    netEarnings: salesWithoutTax - refundedSalesWithoutTax - commission - sellerCashback,
  };
}

/** How many consecutive Market days must match before net figures show (FE-066). */
export const READINESS_DAYS = 7;

/** The days the readiness looks at: the {@link READINESS_DAYS} Market days ending yesterday. */
export function readinessWindow(today: MarketDay): DayRange {
  const end = Temporal.PlainDate.from(today).subtract({ days: 1 });
  return {
    from: end.subtract({ days: READINESS_DAYS - 1 }).toString() as MarketDay,
    to: end.toString() as MarketDay,
  };
}

/** A paid seller order with goods, on its paid day (reporting's `seller_orders`). */
export interface PaidOnDay {
  readonly sellerOrderId: string;
  readonly day: MarketDay;
}

/** One day of the comparison: counts only. */
export interface LedgerMatchDay {
  readonly day: MarketDay;
  /** Seller orders paid on the day with goods above zero (reporting's sales facts). */
  readonly paidSellerOrders: number;
  /** Seller orders with a `commission` fact on the day. */
  readonly ledgerSellerOrders: number;
  /** Paid with goods, but no commission fact on that day. */
  readonly missingInLedger: number;
  /** A commission fact whose seller order reporting does not hold as paid on that day. */
  readonly missingInSales: number;
  readonly matches: boolean;
}

/**
 * The comparison of each day of `window`. A day matches when every seller order reporting holds as
 * paid on it with goods above zero has a commission fact on the same day, and every seller order
 * with a commission fact on it is held as paid on that day. A fully discounted seller order (goods
 * 0) writes no commission row, so it is left out. A seller order reporting holds but never saw paid
 * (`knownUnpaid`: it was first read after it was cancelled) does not count against the day.
 */
export function matchLedgerDays(
  window: DayRange,
  paid: readonly PaidOnDay[],
  commission: readonly PaidOnDay[],
  knownUnpaid: ReadonlySet<string>,
): LedgerMatchDay[] {
  const byDay = (rows: readonly PaidOnDay[]) => {
    const map = new Map<string, Set<string>>();
    for (const row of rows) {
      const set = map.get(row.day) ?? new Set<string>();
      set.add(row.sellerOrderId);
      map.set(row.day, set);
    }
    return map;
  };
  const paidByDay = byDay(paid);
  const ledgerByDay = byDay(commission);
  return daysOf(window).map((day) => {
    const paidSet = paidByDay.get(day) ?? new Set<string>();
    const ledgerSet = ledgerByDay.get(day) ?? new Set<string>();
    let missingInLedger = 0;
    for (const id of paidSet) if (!ledgerSet.has(id)) missingInLedger += 1;
    let missingInSales = 0;
    for (const id of ledgerSet) if (!paidSet.has(id) && !knownUnpaid.has(id)) missingInSales += 1;
    return {
      day,
      paidSellerOrders: paidSet.size,
      ledgerSellerOrders: ledgerSet.size,
      missingInLedger,
      missingInSales,
      matches: missingInLedger === 0 && missingInSales === 0,
    };
  });
}

/**
 * The fewest seller orders that must have matched (paid with goods and a commission fact on the
 * same Market day) across the {@link READINESS_DAYS} days before net figures show: on average one
 * a day. An empty week matches trivially (0 = 0) and proves nothing about the ledger subscriber;
 * seven matched orders show it kept up on real traffic over the week, while a Market that is
 * still quiet keeps its net figures withheld (fail-closed) rather than shown unproven.
 */
export const READINESS_MIN_MATCHED_SELLER_ORDERS = 7;

/** Where the ledger history backfill of the Market stands, for the readiness. */
export interface LedgerBackfillState {
  /** It has read every row recorded before it started. */
  readonly finished: boolean;
  /** Rows it refused or could not write (logged and skipped): any one leaves a hole. */
  readonly failedFacts: number;
}

export type LedgerReadinessReason =
  | 'ready'
  | 'backfill-not-finished'
  | 'backfill-refused-rows'
  | 'days-not-matching'
  | 'insufficient-activity';

/** Whether net figures may show, and why not. */
export interface LedgerReadiness {
  readonly ready: boolean;
  readonly reason: LedgerReadinessReason;
  /** The ledger history backfill has read every row recorded before it started. */
  readonly backfillFinished: boolean;
  /** Rows the backfill refused or could not write. */
  readonly backfillFailedFacts: number;
  /** Seller orders that matched across the window (counted from the days). */
  readonly matchedSellerOrders: number;
  readonly window: DayRange;
  readonly days: readonly LedgerMatchDay[];
}

/**
 * Ready when the ledger history backfill has finished without refusing a row, every one of the
 * {@link READINESS_DAYS} Market days ending yesterday matches ({@link matchLedgerDays}), and at
 * least {@link READINESS_MIN_MATCHED_SELLER_ORDERS} seller orders matched across them. Today is
 * never in it: its rows are still arriving. The readiness checks the `commission` rows only; the
 * other kinds are trusted to travel with them (same ledger, same event, same backfill).
 */
export function ledgerReadinessOf(
  backfill: LedgerBackfillState,
  window: DayRange,
  days: readonly LedgerMatchDay[],
): LedgerReadiness {
  const allMatch = days.length === READINESS_DAYS && days.every((day) => day.matches);
  // A paid seller order with its commission fact on the same day is a matched one.
  const matchedSellerOrders = days.reduce(
    (sum, day) => sum + day.paidSellerOrders - day.missingInLedger,
    0,
  );
  const reason: LedgerReadinessReason = !backfill.finished
    ? 'backfill-not-finished'
    : backfill.failedFacts !== 0
      ? 'backfill-refused-rows'
      : !allMatch
        ? 'days-not-matching'
        : matchedSellerOrders < READINESS_MIN_MATCHED_SELLER_ORDERS
          ? 'insufficient-activity'
          : 'ready';
  return {
    ready: reason === 'ready',
    reason,
    backfillFinished: backfill.finished,
    backfillFailedFacts: backfill.failedFacts,
    matchedSellerOrders,
    window,
    days,
  };
}

/** The longest range a net figure is read for: 13 months (the dashboards' custom range cap). */
export const MAX_RANGE_MONTHS = 13;

/**
 * A requested range of Market days, checked: two `YYYY-MM-DD` days, `from` not after `to`, `to` not
 * after `today`, and at most {@link MAX_RANGE_MONTHS} months long. Null when it is not.
 */
export function checkDayRange(value: unknown, today: MarketDay): DayRange | null {
  if (typeof value !== 'object' || value === null) return null;
  const { from, to } = value as { from?: unknown; to?: unknown };
  const parse = (day: unknown): Temporal.PlainDate | null => {
    if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
    try {
      return Temporal.PlainDate.from(day, { overflow: 'reject' });
    } catch {
      return null;
    }
  };
  const start = parse(from);
  const end = parse(to);
  if (start === null || end === null) return null;
  if (Temporal.PlainDate.compare(start, end) > 0) return null;
  if (Temporal.PlainDate.compare(end, Temporal.PlainDate.from(today)) > 0) return null;
  if (Temporal.PlainDate.compare(start, end.subtract({ months: MAX_RANGE_MONTHS })) <= 0)
    return null;
  return { from: start.toString() as MarketDay, to: end.toString() as MarketDay };
}
