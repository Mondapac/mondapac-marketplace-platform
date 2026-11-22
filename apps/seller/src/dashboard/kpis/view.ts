import type { StatDeltaProps } from '@mondapac/ui';
import type { KpiTotals } from './types.ts';

// What the KPI cards show, from the API's totals: the change against the previous period, with
// its colour from better or worse (more refunds point up and are bad), never from the direction.

/** A previous period with fewer paid orders than this is too small to show a percentage on. */
export const MIN_BASE_ORDERS = 5;

type Sentiment = 'higher-is-better' | 'lower-is-better';

const flat = (
  sentiment: StatDeltaProps['sentiment'],
  value: string,
): Pick<StatDeltaProps, 'value' | 'direction' | 'sentiment'> => ({
  value,
  direction: 'flat',
  sentiment,
});

function judge(rise: boolean, rule: Sentiment): StatDeltaProps['sentiment'] {
  return rise === (rule === 'higher-is-better') ? 'good' : 'bad';
}

/**
 * The change of an amount or a count in percent ("+12.4%"). `n/a` when the previous figure is
 * zero or its period had fewer than {@link MIN_BASE_ORDERS} paid orders.
 */
export function changeOf(
  current: bigint,
  previous: bigint,
  previousOrders: number,
  rule: Sentiment,
  comparedWith: string,
): StatDeltaProps {
  if (previous <= 0n || previousOrders < MIN_BASE_ORDERS) {
    return { ...flat('neutral', 'n/a'), comparedWith };
  }
  const basisPoints = Number(((current - previous) * 10000n) / previous);
  if (basisPoints === 0) return { ...flat('neutral', '0.0%'), comparedWith };
  const rise = basisPoints > 0;
  return {
    value: `${rise ? '+' : '-'}${(Math.abs(basisPoints) / 100).toFixed(1)}%`,
    direction: rise ? 'up' : 'down',
    sentiment: judge(rise, rule),
    comparedWith,
  };
}

/** The change of a rate in percentage points ("+1.2 pts"); `n/a` when either period has no rate. */
export function pointsChange(
  current: number | null,
  previous: number | null,
  rule: Sentiment,
  comparedWith: string,
): StatDeltaProps {
  if (current === null || previous === null) return { ...flat('neutral', 'n/a'), comparedWith };
  const diff = current - previous;
  if (diff === 0) return { ...flat('neutral', '0.0 pts'), comparedWith };
  const rise = diff > 0;
  return {
    value: `${rise ? '+' : '-'}${(Math.abs(diff) / 100).toFixed(1)} pts`,
    direction: rise ? 'up' : 'down',
    sentiment: judge(rise, rule),
    comparedWith,
  };
}

/** A rate in basis points as a percentage ("6.7%"); "-" when there is none. */
export const percent = (bps: number | null): string =>
  bps === null ? '-' : `${(bps / 100).toFixed(1)}%`;

export interface CardDeltas {
  readonly sales: StatDeltaProps;
  readonly orders: StatDeltaProps;
  readonly averageOrderValue: StatDeltaProps;
  readonly refunded: StatDeltaProps;
  readonly refundRate: StatDeltaProps;
  readonly onTime: StatDeltaProps;
  readonly units: StatDeltaProps;
  readonly cancelled: StatDeltaProps;
}

const big = (text: string | null): bigint => (text === null ? 0n : BigInt(text));

/** The change line of every card of the strip. */
export function deltasOf(
  current: KpiTotals,
  previous: KpiTotals,
  comparedWith: string,
): CardDeltas {
  const base = previous.orders;
  return {
    sales: changeOf(
      big(current.salesInclTax),
      big(previous.salesInclTax),
      base,
      'higher-is-better',
      comparedWith,
    ),
    orders: changeOf(
      BigInt(current.orders),
      BigInt(previous.orders),
      base,
      'higher-is-better',
      comparedWith,
    ),
    averageOrderValue: changeOf(
      big(current.averageOrderValue),
      big(previous.averageOrderValue),
      base,
      'higher-is-better',
      comparedWith,
    ),
    refunded: changeOf(
      big(current.refundedInclTax),
      big(previous.refundedInclTax),
      base,
      'lower-is-better',
      comparedWith,
    ),
    refundRate: pointsChange(
      current.refundRateBps,
      previous.refundRateBps,
      'lower-is-better',
      comparedWith,
    ),
    onTime: pointsChange(
      current.shippedOnTimeBps,
      previous.shippedOnTimeBps,
      'higher-is-better',
      comparedWith,
    ),
    units: changeOf(
      BigInt(current.units),
      BigInt(previous.units),
      base,
      'higher-is-better',
      comparedWith,
    ),
    cancelled: changeOf(
      BigInt(current.ordersCancelled),
      BigInt(previous.ordersCancelled),
      base,
      'lower-is-better',
      comparedWith,
    ),
  };
}
