import { ApiProperty } from '@nestjs/swagger';
import type { SellerNetEarningsAnswer } from '../application/use-cases/view-seller-net-earnings.use-case';
import type { SellerKpiAnswer } from '../application/use-cases/view-seller-kpis.use-case';
import type { SellerKpiTotals } from '../domain/seller-kpis';
import type { SellerGoalAnswer } from '../application/use-cases/view-seller-monthly-goal.use-case';
import type { SetSellerGoalAnswer } from '../application/use-cases/set-seller-monthly-goal.use-case';
import { MonthFiguresBody, monthFiguresBody } from './month-forecast.dto';

/** Money is a decimal string of minor units (an integer may not fit a JSON number). */
export class SellerKpiTotalsBody {
  @ApiProperty({ description: 'Goods of paid orders with GST, minor units; shipping apart.' })
  salesInclTax!: string;
  @ApiProperty({ description: 'The same without GST.' }) salesExclTax!: string;
  @ApiProperty() orders!: number;
  @ApiProperty() units!: number;
  @ApiProperty({ nullable: true, type: String, description: 'Sales with GST per order.' })
  averageOrderValue!: string | null;
  @ApiProperty({ description: 'Goods and shipping refunded in the period, with GST, positive.' })
  refundedInclTax!: string;
  @ApiProperty() refunds!: number;
  @ApiProperty({
    nullable: true,
    type: Number,
    description: 'Refunded goods over sales, basis points; null with no sales.',
  })
  refundRateBps!: number | null;
  @ApiProperty() ordersCancelled!: number;
  @ApiProperty() ordersShipped!: number;
  @ApiProperty({
    nullable: true,
    type: Number,
    description: 'Shipped on time over shipped, basis points; null when nothing shipped.',
  })
  shippedOnTimeBps!: number | null;
}

export class SellerKpiDayBody {
  @ApiProperty({ example: '2026-11-22', description: 'A Market day.' }) day!: string;
  @ApiProperty() salesInclTax!: string;
  @ApiProperty() orders!: number;
  @ApiProperty() refundedInclTax!: string;
}

export class SellerKpiCategoryBody {
  @ApiProperty({ format: 'uuid' }) categoryId!: string;
  @ApiProperty({ description: 'Sales minus refunds, with GST.' }) netSalesInclTax!: string;
  @ApiProperty() orders!: number;
  @ApiProperty() units!: number;
}

export class SellerKpiRangeBody {
  @ApiProperty({ example: '2026-11-16' }) from!: string;
  @ApiProperty({ example: '2026-11-22' }) to!: string;
}

export class SellerKpiPeriodBody {
  @ApiProperty({ enum: ['today', '7d', '30d', 'month', 'custom'] }) id!: string;
  @ApiProperty({ type: SellerKpiRangeBody }) current!: SellerKpiRangeBody;
  @ApiProperty({ type: SellerKpiRangeBody }) previous!: SellerKpiRangeBody;
  @ApiProperty() days!: number;
}

export class SellerGoalFiguresBody extends MonthFiguresBody {
  @ApiProperty({ description: "The month's goal version for the edit; 0 while none is set." })
  version!: number;
}

export class SellerGoalSectionBody {
  @ApiProperty({ enum: ['ok', 'error'], description: '`error`: the read failed or was slow.' })
  status!: string;
  @ApiProperty({ required: false, type: SellerGoalFiguresBody }) goal?: SellerGoalFiguresBody;
}

/** One section of the KPI body: its figures, `error`, or null (left out). */
export type SellerGoalSection =
  { readonly status: 'ok'; readonly value: SellerGoalAnswer } | { readonly status: 'error' } | null;

export function sellerGoalSectionBody(section: SellerGoalSection): SellerGoalSectionBody | null {
  if (section === null) return null;
  if (section.status === 'error') return { status: 'error' };
  const { value } = section;
  return {
    status: 'ok',
    goal: {
      ...monthFiguresBody(value.figures, value.timezone, value.currency),
      version: value.version,
    },
  };
}

export class SetSellerGoalRequest {
  @ApiProperty({
    example: '2026-11',
    description: 'This month of the Market or one of the next 12.',
  })
  month!: string;
  @ApiProperty({ description: 'Minor units above zero (at most 15 digits), as a string.' })
  amount!: string;
  @ApiProperty({ description: "ISO 4217: the Market's currency." }) currency!: string;
  @ApiProperty({ description: 'The version seen (0: no goal yet); a stale edit is 409.' })
  expectedVersion!: number;
}

export class SellerGoalBody {
  @ApiProperty({ example: '2026-11' }) month!: string;
  @ApiProperty({ description: 'Minor units.' }) amount!: string;
  @ApiProperty() currency!: string;
  @ApiProperty() version!: number;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}

export const sellerGoalBody = (answer: SetSellerGoalAnswer): SellerGoalBody => ({
  month: answer.month,
  amount: answer.goal.amount.toString(),
  currency: answer.goal.currency,
  version: answer.version,
  updatedAt: answer.updatedAt.toString(),
});

export class SellerKpisBody {
  @ApiProperty({ type: SellerKpiPeriodBody }) period!: SellerKpiPeriodBody;
  @ApiProperty({ description: 'The IANA zone the Market counts its days in.' }) timezone!: string;
  @ApiProperty({ description: 'ISO 4217; every amount is in it.' }) currency!: string;
  @ApiProperty({ type: SellerKpiTotalsBody }) current!: SellerKpiTotalsBody;
  @ApiProperty({ type: SellerKpiTotalsBody }) previous!: SellerKpiTotalsBody;
  @ApiProperty({ type: [SellerKpiDayBody], description: 'One per day of the current range.' })
  series!: SellerKpiDayBody[];
  @ApiProperty({ type: [SellerKpiDayBody], description: 'One per day of the previous range.' })
  previousSeries!: SellerKpiDayBody[];
  @ApiProperty({ type: [SellerKpiCategoryBody], description: 'Up to five, best first.' })
  topCategories!: SellerKpiCategoryBody[];
  @ApiProperty({
    nullable: true,
    type: String,
    format: 'date-time',
    description: 'The latest refresh of any figure read; null when the period has none.',
  })
  refreshedAt!: string | null;
  @ApiProperty({
    type: SellerGoalSectionBody,
    nullable: true,
    description:
      "The current calendar month against the seller's own goal, whatever the period: sales " +
      'with GST to date, last month, the month-end forecast (an estimate) and the pace. Null ' +
      'when the viewer may not read it; `error` when it failed or took too long.',
  })
  sellerGoal!: SellerGoalSectionBody | null;
}

const money = (value: bigint): string => value.toString();

function totalsBody(totals: SellerKpiTotals): SellerKpiTotalsBody {
  return {
    ...totals,
    salesInclTax: money(totals.salesInclTax),
    salesExclTax: money(totals.salesExclTax),
    averageOrderValue: totals.averageOrderValue === null ? null : money(totals.averageOrderValue),
    refundedInclTax: money(totals.refundedInclTax),
  };
}

export function sellerKpisBody(
  answer: SellerKpiAnswer,
  goal: SellerGoalSection = null,
): SellerKpisBody {
  const { kpis, period } = answer;
  const days = (rows: typeof kpis.series): SellerKpiDayBody[] =>
    rows.map((row) => ({
      day: row.day,
      salesInclTax: money(row.salesInclTax),
      orders: row.orders,
      refundedInclTax: money(row.refundedInclTax),
    }));
  return {
    period: {
      id: period.id,
      current: period.current,
      previous: period.previous,
      days: period.days,
    },
    timezone: answer.timezone,
    currency: answer.currency,
    current: totalsBody(kpis.current),
    previous: totalsBody(kpis.previous),
    series: days(kpis.series),
    previousSeries: days(kpis.previousSeries),
    topCategories: kpis.topCategories.map((row) => ({
      categoryId: row.categoryId,
      netSalesInclTax: money(row.netSalesInclTax),
      orders: row.orders,
      units: row.units,
    })),
    refreshedAt: kpis.refreshedAt === null ? null : kpis.refreshedAt.toString(),
    sellerGoal: sellerGoalSectionBody(goal),
  };
}

export class SellerNetEarningsBody {
  @ApiProperty({ type: SellerKpiRangeBody, description: 'The Market days the figure covers.' })
  range!: SellerKpiRangeBody;
  @ApiProperty({ description: 'The IANA zone the Market counts its days in.' }) timezone!: string;
  @ApiProperty({ description: 'ISO 4217.' }) currency!: string;
  @ApiProperty({
    description:
      "False until the Market's ledger has matched for a week of paid orders (FE-066); the figure " +
      'is then withheld, never sent early and never as 0.',
  })
  ready!: boolean;
  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'Net earnings in minor units, without GST: sales after refunds, minus commission (net of ' +
      'returned commission) and seller-funded cashback. Null while not `ready`.',
  })
  netEarnings!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    format: 'date-time',
    description: 'When the newest ledger rollup behind the figure was rebuilt; null with none.',
  })
  refreshedAt!: string | null;
}

export function sellerNetEarningsBody(answer: SellerNetEarningsAnswer): SellerNetEarningsBody {
  return {
    range: { from: answer.range.from, to: answer.range.to },
    timezone: answer.timezone,
    currency: answer.currency,
    ready: answer.ready,
    netEarnings: answer.earnings === null ? null : answer.earnings.netEarnings.toString(),
    refreshedAt: answer.refreshedAt === null ? null : answer.refreshedAt.toString(),
  };
}
