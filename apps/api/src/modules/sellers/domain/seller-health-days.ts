import { Temporal } from '@mondapac/shared-kernel';
import type { SellerHealthInput } from './seller-health';

/**
 * One local day of a seller's health counters (seller health package 3). The day is the seller's
 * own local date (ADR-0005). Counts are of the seller's own faults only; the feeds that fill them
 * leave out customer cancels, failed payments, courier delays and disputes the seller won.
 * Seller cancellations are not counted: ordering has no seller cancel flow yet, so that metric
 * reads "no data" (owner decision, 1 Nov 2026).
 */
export interface SellerHealthDay {
  readonly day: Temporal.PlainDate;
  /** Orders paid that day. */
  readonly paidOrders: number;
  /** Orders marked ready that day, and how many of them after the promised time. */
  readonly readyOrders: number;
  readonly lateReadyOrders: number;
  /** Disputes the seller lost that day. */
  readonly lostDisputes: number;
  /** Approved reviews that day and the sum of their stars. */
  readonly reviewsApproved: number;
  readonly ratingStarsSum: number;
}

/** The window lengths in days, Market settings (ADM-06): the short one and the long one. */
export interface SellerHealthWindows {
  /** Late ready (and, once they exist, seller cancellations). */
  readonly shortDays: number;
  /** Customer rating, lost disputes, reports, and the order count behind the New label. */
  readonly longDays: number;
}

export function assertSellerHealthWindows(windows: SellerHealthWindows): void {
  const { shortDays, longDays } = windows;
  if (
    !Number.isSafeInteger(shortDays) ||
    !Number.isSafeInteger(longDays) ||
    shortDays < 1 ||
    longDays < shortDays ||
    longDays > 366
  ) {
    throw new RangeError('seller-health.windows: out of order or out of range');
  }
}

/** The days of `[today - (length - 1) days, today]`, as an inclusive first date. */
export function windowStart(today: Temporal.PlainDate, length: number): Temporal.PlainDate {
  return today.subtract({ days: length - 1 });
}

const inWindow = (day: SellerHealthDay, today: Temporal.PlainDate, length: number): boolean =>
  Temporal.PlainDate.compare(day.day, windowStart(today, length)) >= 0 &&
  Temporal.PlainDate.compare(day.day, today) <= 0;

function assertDay(day: SellerHealthDay): void {
  const counts = [
    day.paidOrders,
    day.readyOrders,
    day.lateReadyOrders,
    day.lostDisputes,
    day.reviewsApproved,
    day.ratingStarsSum,
  ];
  if (counts.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new RangeError('seller-health.day: not a count');
  }
  if (day.lateReadyOrders > day.readyOrders) {
    throw new RangeError('seller-health.day: late above ready');
  }
  if (day.ratingStarsSum < day.reviewsApproved || day.ratingStarsSum > 5 * day.reviewsApproved) {
    throw new RangeError('seller-health.day: stars outside 1 to 5 per review');
  }
}

/**
 * Sums the stored days into the input of {@link computeSellerHealth}, for the windows ending
 * `today` (the seller's local date). A day outside the long window is ignored; a day listed twice
 * is a fault of the caller. Disputes are measured against the paid orders of the long window;
 * late ready against the orders marked ready in the short window; the rating needs its reviews
 * counted in the long window. Seller cancellations have no source: base 0, no data.
 */
export function sellerHealthInputFromDays(
  days: readonly SellerHealthDay[],
  today: Temporal.PlainDate,
  windows: SellerHealthWindows,
): SellerHealthInput {
  assertSellerHealthWindows(windows);
  const seen = new Set<string>();
  let orders = 0;
  let ready = 0;
  let late = 0;
  let disputes = 0;
  let reviews = 0;
  let stars = 0;
  for (const day of days) {
    assertDay(day);
    const key = day.day.toString();
    if (seen.has(key)) throw new RangeError('seller-health.day: listed twice');
    seen.add(key);
    if (inWindow(day, today, windows.longDays)) {
      orders += day.paidOrders;
      disputes += day.lostDisputes;
      reviews += day.reviewsApproved;
      stars += day.ratingStarsSum;
    }
    if (inWindow(day, today, windows.shortDays)) {
      ready += day.readyOrders;
      late += day.lateReadyOrders;
    }
  }
  return {
    orders,
    sellerCancellations: { count: 0, base: 0 },
    lateReady: { count: late, base: ready },
    lostDisputes: { count: Math.min(disputes, orders), base: orders },
    customerRating: {
      count: reviews,
      averageHundredths: reviews === 0 ? 0 : Math.round((stars * 100) / reviews),
    },
    reports: null,
  };
}
