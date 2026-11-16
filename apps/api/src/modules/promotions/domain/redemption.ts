// What an order took from the promotions (package T2): one redemption per order and promotion,
// reserved when the order is placed, confirmed when it is paid and released when it is cancelled.
// Plain data and pure functions: no I/O, no Market lookup, amounts in integer minor units.

import type { Temporal } from '@mondapac/shared-kernel';
import type { CalculationOutput, CartLine } from './calculation/types';

export const REDEMPTION_KINDS = ['PROMOTION', 'FIRST_ORDER', 'FREE_SHIPPING', 'ORDER'] as const;
export type RedemptionKind = (typeof REDEMPTION_KINDS)[number];

export const REDEMPTION_STATUSES = ['RESERVED', 'CONFIRMED', 'RELEASED'] as const;
export type RedemptionStatus = (typeof REDEMPTION_STATUSES)[number];

export const RELEASE_REASONS = ['ORDER_CANCELLED', 'ORDER_REFUNDED'] as const;
export type ReleaseReason = (typeof RELEASE_REASONS)[number];

/** The key of the Market's first-order discount (a settings-based offer, no promotion row). */
export const FIRST_ORDER_KEY = 'first-order';
/** The key prefix of a zone's free delivery (a settings-based offer, no promotion row). */
export const FREE_SHIPPING_PREFIX = 'free-shipping:';
/**
 * The key of an order's head row (kind ORDER, zero amounts): written with every redemption, and
 * written RELEASED alone when the order is cancelled before it was redeemed. A redemption and a
 * cancellation of one order meet on this key, so whichever comes second sees the first.
 */
export const ORDER_KEY = 'order';

export interface RedemptionRecord {
  readonly id: string;
  readonly orderId: string;
  /** The promotion's id, {@link FIRST_ORDER_KEY} or `free-shipping:<zone>`. */
  readonly promotionKey: string;
  /** The stored promotion; null for a settings-based offer. */
  readonly promotionId: string | null;
  readonly kind: RedemptionKind;
  /** Null only on the head row of an order cancelled before it was redeemed. */
  readonly customerAccountId: string | null;
  /** The hash of the single-use code the order redeemed (never the code). */
  readonly codeHash: string | null;
  readonly currency: string | null;
  readonly amount: bigint;
  readonly sellerShare: bigint;
  readonly platformShare: bigint;
  /** Units of a flash sale the order discounted; null for any other promotion. */
  readonly units: number | null;
  /** `YYYY-MM` in the Market's zone, for a first-order redemption only. */
  readonly budgetMonth: string | null;
  readonly status: RedemptionStatus;
  readonly releaseReason: ReleaseReason | null;
  readonly reservedAt: Temporal.Instant;
  readonly confirmedAt: Temporal.Instant | null;
  readonly releasedAt: Temporal.Instant | null;
}

/** What a promotion key names: a stored promotion, the first-order offer or a zone's free delivery. */
export function kindOfKey(key: string): {
  readonly kind: RedemptionKind;
  readonly promotionId: string | null;
} {
  if (key === FIRST_ORDER_KEY) return { kind: 'FIRST_ORDER', promotionId: null };
  if (key.startsWith(FREE_SHIPPING_PREFIX)) return { kind: 'FREE_SHIPPING', promotionId: null };
  return { kind: 'PROMOTION', promotionId: key };
}

/** The month of an instant in a zone, `YYYY-MM`: the first-order budget is monthly in the Market's zone. */
export function budgetMonthOf(at: Temporal.Instant, timeZone: string): string {
  const date = at.toZonedDateTimeISO(timeZone).toPlainDate();
  return `${String(date.year).padStart(4, '0')}-${String(date.month).padStart(2, '0')}`;
}

/**
 * The discounts of a quote in a form two quotes can be compared by: per promotion, per line and per
 * shipping charge, each with its funding split, sorted. What checkout stored on the order must be
 * exactly what the redemption writes, so this is the contract between the two.
 */
export interface DiscountSummary {
  readonly applied: readonly {
    readonly promotionId: string;
    readonly amount: bigint;
    readonly sellerShare: bigint;
    readonly platformShare: bigint;
  }[];
  readonly lines: readonly {
    readonly lineId: string;
    readonly discount: bigint;
    readonly sellerShare: bigint;
    readonly platformShare: bigint;
  }[];
  readonly shipping: readonly {
    readonly shippingId: string;
    readonly discount: bigint;
    readonly sellerShare: bigint;
    readonly platformShare: bigint;
  }[];
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const shares = (allocations: readonly { sellerShare: bigint; platformShare: bigint }[]) =>
  allocations.reduce(
    (sum, a) => ({
      sellerShare: sum.sellerShare + a.sellerShare,
      platformShare: sum.platformShare + a.platformShare,
    }),
    { sellerShare: 0n, platformShare: 0n },
  );

/** The summary of a calculation: only what was discounted (a zero line or charge is left out). */
export function summaryOf(output: CalculationOutput): DiscountSummary {
  return {
    applied: output.applied
      .filter((a) => a.amount > 0n)
      .map((a) => ({
        promotionId: a.promotionId,
        amount: a.amount,
        sellerShare: a.sellerShare,
        platformShare: a.platformShare,
      }))
      .sort((a, b) => byText(a.promotionId, b.promotionId)),
    lines: output.lines
      .filter((line) => line.discount > 0n)
      .map((line) => ({
        lineId: line.lineId,
        discount: line.discount,
        ...shares(line.allocations),
      }))
      .sort((a, b) => byText(a.lineId, b.lineId)),
    shipping: output.shipping
      .filter((charge) => charge.discount > 0n)
      .map((charge) => ({
        shippingId: charge.shippingId,
        discount: charge.discount,
        ...shares(charge.allocations),
      }))
      .sort((a, b) => byText(a.shippingId, b.shippingId)),
  };
}

/** Whether two summaries are the same discounts, whatever order their parts came in. */
export function sameDiscounts(a: DiscountSummary, b: DiscountSummary): boolean {
  const canon = (s: DiscountSummary) =>
    JSON.stringify(
      {
        applied: [...s.applied].sort((x, y) => byText(x.promotionId, y.promotionId)),
        lines: [...s.lines].sort((x, y) => byText(x.lineId, y.lineId)),
        shipping: [...s.shipping].sort((x, y) => byText(x.shippingId, y.shippingId)),
      },
      (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value),
    );
  return canon(a) === canon(b);
}

/**
 * The units of a limited promotion (a flash sale) that an order discounted. The calculation gives a
 * limited promotion the dearest lines first (ties: the line id) and covers at most the units left
 * on each, so the same walk over the lines it allocated to gives the units it counted.
 */
export function limitedUnits(
  lines: readonly CartLine[],
  output: CalculationOutput,
  promotionId: string,
  unitsLeft: number,
): number {
  const allocated = new Set(
    output.lines
      .filter((line) =>
        line.allocations.some((a) => a.promotionId === promotionId && a.amount > 0n),
      )
      .map((line) => line.lineId),
  );
  const ordered = lines
    .filter((line) => allocated.has(line.id))
    .sort((a, b) =>
      a.unitPrice === b.unitPrice ? byText(a.id, b.id) : a.unitPrice > b.unitPrice ? -1 : 1,
    );
  let left = unitsLeft;
  let units = 0;
  for (const line of ordered) {
    const covered = Math.min(line.quantity, left);
    units += covered;
    left -= covered;
  }
  return units;
}
