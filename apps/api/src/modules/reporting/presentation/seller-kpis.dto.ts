import { ApiProperty } from '@nestjs/swagger';
import type { SellerKpiAnswer } from '../application/use-cases/view-seller-kpis.use-case';
import type { SellerKpiTotals } from '../domain/seller-kpis';

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
  @ApiProperty({ enum: ['today', '7d', '30d', 'month'] }) id!: string;
  @ApiProperty({ type: SellerKpiRangeBody }) current!: SellerKpiRangeBody;
  @ApiProperty({ type: SellerKpiRangeBody }) previous!: SellerKpiRangeBody;
  @ApiProperty() days!: number;
}

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

export function sellerKpisBody(answer: SellerKpiAnswer): SellerKpisBody {
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
  };
}
