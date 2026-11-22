import { ApiProperty } from '@nestjs/swagger';
import type { Temporal } from '@mondapac/shared-kernel';
import type { WorkQueueAnswer } from '../application/use-cases/view-admin-work-queue.use-case';
import type { AdminKpisAnswer } from '../application/use-cases/view-admin-kpis.use-case';
import type { FinanceAnswer, FinanceKpis } from '../../reporting';

export class WorkQueueItemBody {
  @ApiProperty({ description: '`<module>.<queue>`; the panel maps it to its label and link.' })
  key!: string;
  @ApiProperty({ enum: ['critical', 'today', 'review'] }) level!: string;
  @ApiProperty({
    enum: ['ok', 'error'],
    description:
      '`error`: the queue failed or took longer than 1.5 s; show "Couldn\'t load", never 0.',
  })
  status!: string;
  @ApiProperty({ required: false, description: 'Only when status is ok.' }) count?: number;
  @ApiProperty({ required: false, description: 'Part of count. Only when status is ok.' })
  overdue?: number;
  @ApiProperty({
    required: false,
    nullable: true,
    type: String,
    format: 'date-time',
    description: 'When the item that has waited longest came in; null when unknown or empty.',
  })
  oldestAt?: string | null;
  @ApiProperty({
    required: false,
    format: 'date-time',
    description: 'When this count was made (a count may be up to 60 s old; live queues never are).',
  })
  countedAt?: string;
}

export class WorkQueueBody {
  @ApiProperty({ enum: ['admin', 'seller'] }) panel!: string;
  @ApiProperty({ format: 'date-time' }) generatedAt!: string;
  @ApiProperty({
    type: [WorkQueueItemBody],
    description:
      'Critical first, then today, then review; within a level in a fixed order. A queue the ' +
      'viewer holds no key for is absent.',
  })
  queues!: WorkQueueItemBody[];
}

export function workQueueBody(answer: WorkQueueAnswer): WorkQueueBody {
  return {
    panel: answer.panel,
    generatedAt: answer.generatedAt.toString(),
    queues: answer.queues.map((item) =>
      item.status === 'ok'
        ? {
            key: item.key,
            level: item.level,
            status: item.status,
            count: item.count,
            overdue: item.overdue,
            oldestAt: item.oldestAt === null ? null : item.oldestAt.toString(),
            countedAt: item.countedAt.toString(),
          }
        : { key: item.key, level: item.level, status: item.status },
    ),
  };
}

// The admin KPIs (dashboards upgrade, phase 5). Money is minor units as a string with its
// currency; rates are basis points (1250 is 12.5%); a rate or average with nothing to divide is null.

export class DeltaBody {
  @ApiProperty({ description: 'Change against the previous period, basis points.' }) value!: number;
  @ApiProperty({ enum: ['up', 'down', 'flat'] }) direction!: string;
  @ApiProperty({
    enum: ['ok', 'na'],
    description: '`na`: the base is zero or too small; show "n/a", never 0%.',
  })
  state!: string;
}

export class KpiRangeBody {
  @ApiProperty({ description: 'First Market day, YYYY-MM-DD.' }) from!: string;
  @ApiProperty({ description: 'Last Market day (inclusive), YYYY-MM-DD.' }) to!: string;
}

export class KpiPeriodBody {
  @ApiProperty({ enum: ['today', '7d', '30d', 'month'] }) id!: string;
  @ApiProperty({ type: KpiRangeBody }) current!: KpiRangeBody;
  @ApiProperty({ type: KpiRangeBody }) previous!: KpiRangeBody;
}

export class MoneyBody {
  @ApiProperty({ description: 'Minor units, as a string.' }) amountMinor!: string;
  @ApiProperty({ description: 'ISO 4217.' }) currency!: string;
}

export class OperationsKpiValuesBody {
  @ApiProperty() ordersPaid!: number;
  @ApiProperty() ordersCancelled!: number;
  @ApiProperty({ nullable: true, type: Number }) cancelRateBp!: number | null;
  @ApiProperty() ordersShipped!: number;
  @ApiProperty({ nullable: true, type: Number }) onTimeRateBp!: number | null;
  @ApiProperty({ description: 'Seller orders delivered in the period.' })
  ordersDelivered!: number;
  @ApiProperty() refunds!: number;
}

export class OperationsPointBody {
  @ApiProperty() day!: string;
  @ApiProperty() ordersPaid!: number;
  @ApiProperty() ordersCancelled!: number;
  @ApiProperty() refunds!: number;
}

export class OperationsKpiBody {
  @ApiProperty({
    nullable: true,
    type: Number,
    description:
      'Sellers with at least one paid order in the period. Null when this one count could not be read.',
  })
  sellersWithOrders!: number | null;
  @ApiProperty({ type: OperationsKpiValuesBody }) current!: OperationsKpiValuesBody;
  @ApiProperty({ type: OperationsKpiValuesBody }) previous!: OperationsKpiValuesBody;
  @ApiProperty({
    description:
      "Per number: change against the previous period. Whether up is good is the panel's call.",
  })
  deltas!: Record<string, DeltaBody>;
  @ApiProperty({ type: [OperationsPointBody] }) series!: OperationsPointBody[];
  @ApiProperty({ type: [OperationsPointBody], description: 'The previous period, day by day.' })
  previousSeries!: OperationsPointBody[];
}

export class FinanceKpiValuesBody {
  @ApiProperty({ type: MoneyBody }) gmvWithTax!: MoneyBody;
  @ApiProperty({ type: MoneyBody }) gmvWithoutTax!: MoneyBody;
  @ApiProperty({ type: MoneyBody, description: 'Goods refunded on their refund day.' })
  refundedWithTax!: MoneyBody;
  @ApiProperty({ nullable: true, type: Number }) refundRateBp!: number | null;
  @ApiProperty({ type: MoneyBody }) netSalesWithTax!: MoneyBody;
  @ApiProperty({ nullable: true, type: MoneyBody }) averageOrderWithTax!: MoneyBody | null;
}

export class FinancePointBody {
  @ApiProperty() day!: string;
  @ApiProperty() gmvWithTax!: string;
  @ApiProperty() gmvWithoutTax!: string;
  @ApiProperty() refundedWithTax!: string;
}

export class FinanceKpiBody {
  @ApiProperty() currency!: string;
  @ApiProperty({ type: FinanceKpiValuesBody }) current!: FinanceKpiValuesBody;
  @ApiProperty({ type: FinanceKpiValuesBody }) previous!: FinanceKpiValuesBody;
  @ApiProperty({ description: 'Per number: change against the previous period.' })
  deltas!: Record<string, DeltaBody>;
  @ApiProperty({ type: [FinancePointBody], description: 'Minor units as strings.' })
  series!: FinancePointBody[];
  @ApiProperty({ type: [FinancePointBody] }) previousSeries!: FinancePointBody[];
}

export class OperationsSectionBody {
  @ApiProperty({ enum: ['ok', 'error'] }) status!: string;
  @ApiProperty({ required: false, format: 'date-time', nullable: true, type: String })
  refreshedAt?: string | null;
  @ApiProperty({ required: false, type: OperationsKpiBody }) kpis?: OperationsKpiBody;
}

export class FinanceSectionBody {
  @ApiProperty({ enum: ['ok', 'error'] }) status!: string;
  @ApiProperty({ required: false, format: 'date-time', nullable: true, type: String })
  refreshedAt?: string | null;
  @ApiProperty({ required: false, type: FinanceKpiBody }) kpis?: FinanceKpiBody;
}

export class TopSellerBody {
  @ApiProperty({ format: 'uuid' }) sellerId!: string;
  @ApiProperty({ nullable: true, type: String, description: 'The public store name.' })
  storeName!: string | null;
  @ApiProperty({ type: MoneyBody, description: 'Goods sold with GST.' }) gmvWithTax!: MoneyBody;
  @ApiProperty() ordersPaid!: number;
  @ApiProperty({ nullable: true, type: Number }) onTimeRateBp!: number | null;
  @ApiProperty({ nullable: true, type: Number }) refundRateBp!: number | null;
}

export class TopSellersKpiBody {
  @ApiProperty({ type: [TopSellerBody], description: 'Biggest GMV first, at most five.' })
  rows!: TopSellerBody[];
}

export class TopSellersSectionBody {
  @ApiProperty({ enum: ['ok', 'error'] }) status!: string;
  @ApiProperty({ required: false, type: TopSellersKpiBody }) kpis?: TopSellersKpiBody;
}

export class TopCategoryBody {
  @ApiProperty({ format: 'uuid' }) categoryId!: string;
  @ApiProperty({ nullable: true, type: String, description: 'Null when the category is gone.' })
  name!: string | null;
  @ApiProperty({ type: MoneyBody, description: 'Goods sold with GST (gross of refunds).' })
  salesWithTax!: MoneyBody;
  @ApiProperty({ description: 'Seller orders with goods of the category.' }) orders!: number;
}

export class TopCategoriesKpiBody {
  @ApiProperty({ type: [TopCategoryBody], description: 'Biggest sales first, at most five.' })
  rows!: TopCategoryBody[];
}

export class TopCategoriesSectionBody {
  @ApiProperty({ enum: ['ok', 'error'] }) status!: string;
  @ApiProperty({ required: false, type: TopCategoriesKpiBody }) kpis?: TopCategoriesKpiBody;
}

export class HealthCountBody {
  @ApiProperty({ enum: ['ok', 'error'] }) status!: string;
  @ApiProperty({ required: false, type: Number }) count?: number;
}

export class MarketHealthBody {
  @ApiProperty({
    type: HealthCountBody,
    nullable: true,
    description:
      'Offers whose certification tag outlived the certificate (an incident). Null without `catalog.product.view`.',
  })
  uncertifiedListings!: HealthCountBody | null;
  @ApiProperty({
    type: HealthCountBody,
    nullable: true,
    description: 'Sellers in the health queue. Null without `sellers.seller.view`.',
  })
  sellersAtRisk!: HealthCountBody | null;
}

export class AdminKpisBody {
  @ApiProperty({ format: 'date-time' }) generatedAt!: string;
  @ApiProperty({ enum: ['today', '7d', '30d', 'month'], description: 'The period asked for.' })
  periodId!: string;
  @ApiProperty({
    type: KpiPeriodBody,
    nullable: true,
    description:
      'The Market days of the period and of the one before; null when no section answered.',
  })
  period!: KpiPeriodBody | null;
  @ApiProperty({
    type: OperationsSectionBody,
    nullable: true,
    description: 'Null without `ordering.order.view`: leave the cards out.',
  })
  operations!: OperationsSectionBody | null;
  @ApiProperty({
    type: FinanceSectionBody,
    nullable: true,
    description: 'Null without `commission-payouts.settlement.view`: leave the cards out.',
  })
  finance!: FinanceSectionBody | null;
  @ApiProperty({
    type: TopSellersSectionBody,
    nullable: true,
    description: 'Null without `commission-payouts.settlement.view`: leave the card out.',
  })
  topSellers!: TopSellersSectionBody | null;
  @ApiProperty({
    type: TopCategoriesSectionBody,
    nullable: true,
    description: 'Null without `commission-payouts.settlement.view`: leave the card out.',
  })
  topCategories!: TopCategoriesSectionBody | null;
  @ApiProperty({
    type: MarketHealthBody,
    nullable: true,
    description:
      'Null when the viewer holds neither `catalog.product.view` nor `sellers.seller.view`.',
  })
  health!: MarketHealthBody | null;
}

const money = (amount: bigint, currency: string): MoneyBody => ({
  amountMinor: amount.toString(),
  currency,
});

const instantOf = (at: Temporal.Instant | null): string | null =>
  at === null ? null : at.toString();

function financeValues(values: FinanceKpis, currency: string): FinanceKpiValuesBody {
  return {
    gmvWithTax: money(values.gmvWithTax, currency),
    gmvWithoutTax: money(values.gmvWithoutTax, currency),
    refundedWithTax: money(values.refundedWithTax, currency),
    refundRateBp: values.refundRateBp,
    netSalesWithTax: money(values.netSalesWithTax, currency),
    averageOrderWithTax:
      values.averageOrderWithTax === null ? null : money(values.averageOrderWithTax, currency),
  };
}

const financePoint = (point: FinanceAnswer['series'][number]): FinancePointBody => ({
  day: point.day,
  gmvWithTax: point.gmvWithTax.toString(),
  gmvWithoutTax: point.gmvWithoutTax.toString(),
  refundedWithTax: point.refundedWithTax.toString(),
});

function operationsSection(section: AdminKpisAnswer['operations']): OperationsSectionBody | null {
  if (section === null) return null;
  if (section.status === 'error') return { status: 'error' };
  const { value } = section;
  return {
    status: 'ok',
    refreshedAt: instantOf(value.refreshedAt),
    kpis: {
      sellersWithOrders: value.sellersWithOrders,
      current: { ...value.current },
      previous: { ...value.previous },
      deltas: { ...value.deltas },
      series: value.series.map((point) => ({ ...point })),
      previousSeries: value.previousSeries.map((point) => ({ ...point })),
    },
  };
}

function financeSection(section: AdminKpisAnswer['finance']): FinanceSectionBody | null {
  if (section === null) return null;
  if (section.status === 'error') return { status: 'error' };
  const { value } = section;
  return {
    status: 'ok',
    refreshedAt: instantOf(value.refreshedAt),
    kpis: {
      currency: value.currency,
      current: financeValues(value.current, value.currency),
      previous: financeValues(value.previous, value.currency),
      deltas: { ...value.deltas },
      series: value.series.map(financePoint),
      previousSeries: value.previousSeries.map(financePoint),
    },
  };
}

function topSellersSection(section: AdminKpisAnswer['topSellers']): TopSellersSectionBody | null {
  if (section === null) return null;
  if (section.status === 'error') return { status: 'error' };
  const { value } = section;
  return {
    status: 'ok',
    kpis: {
      rows: value.rows.map((row) => ({
        sellerId: row.sellerId,
        storeName: row.storeName,
        gmvWithTax: money(row.gmvWithTax, value.currency),
        ordersPaid: row.ordersPaid,
        onTimeRateBp: row.onTimeRateBp,
        refundRateBp: row.refundRateBp,
      })),
    },
  };
}

function topCategoriesSection(
  section: AdminKpisAnswer['topCategories'],
): TopCategoriesSectionBody | null {
  if (section === null) return null;
  if (section.status === 'error') return { status: 'error' };
  const { value } = section;
  return {
    status: 'ok',
    kpis: {
      rows: value.rows.map((row) => ({
        categoryId: row.categoryId,
        name: row.name,
        salesWithTax: money(row.salesWithTax, value.currency),
        orders: row.orders,
      })),
    },
  };
}

export function adminKpisBody(answer: AdminKpisAnswer): AdminKpisBody {
  // The period is the same in both sections; the first one that answered names it.
  const resolved = [
    answer.operations,
    answer.finance,
    answer.topSellers,
    answer.topCategories,
  ].find((section) => section !== null && section.status === 'ok');
  const period = resolved && resolved.status === 'ok' ? resolved.value.period : null;
  return {
    generatedAt: answer.generatedAt.toString(),
    periodId: answer.period,
    period: period
      ? { id: period.id, current: { ...period.current }, previous: { ...period.previous } }
      : null,
    operations: operationsSection(answer.operations),
    finance: financeSection(answer.finance),
    topSellers: topSellersSection(answer.topSellers),
    topCategories: topCategoriesSection(answer.topCategories),
    health:
      answer.health === null
        ? null
        : {
            uncertifiedListings: answer.health.uncertifiedListings,
            sellersAtRisk: answer.health.sellersAtRisk,
          },
  };
}
