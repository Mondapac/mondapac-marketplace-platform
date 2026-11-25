import { ApiProperty } from '@nestjs/swagger';
import type { Temporal } from '@mondapac/shared-kernel';
import type { WorkQueueAnswer } from '../application/use-cases/view-admin-work-queue.use-case';
import type { AdminKpisAnswer } from '../application/use-cases/view-admin-kpis.use-case';
import type {
  FinanceAnswer,
  FinanceKpis,
  FinanceNet,
  FunnelStep,
  LedgerReadiness,
  NetRevenue,
  SameDayShare,
  TakeRate,
} from '../../reporting';

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
  @ApiProperty({ enum: ['today', '7d', '30d', 'month', 'custom'] }) id!: string;
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

export class LedgerWindowBody {
  @ApiProperty({ example: '2026-11-17' }) from!: string;
  @ApiProperty({ example: '2026-11-23' }) to!: string;
}

export class LedgerMatchDayBody {
  @ApiProperty() day!: string;
  @ApiProperty() paidSellerOrders!: number;
  @ApiProperty() ledgerSellerOrders!: number;
  @ApiProperty() missingInLedger!: number;
  @ApiProperty() missingInSales!: number;
  @ApiProperty() matches!: boolean;
}

export class LedgerReadinessBody {
  @ApiProperty({ description: 'Net figures show only when true (one week of matching ledger).' })
  ready!: boolean;
  @ApiProperty({
    enum: [
      'ready',
      'backfill-not-finished',
      'backfill-refused-rows',
      'days-not-matching',
      'insufficient-activity',
    ],
  })
  reason!: string;
  @ApiProperty() backfillFinished!: boolean;
  @ApiProperty() backfillFailedFacts!: number;
  @ApiProperty() matchedSellerOrders!: number;
  @ApiProperty({ type: LedgerWindowBody, description: 'The 7 Market days ending yesterday.' })
  window!: LedgerWindowBody;
  @ApiProperty({ type: [LedgerMatchDayBody] }) days!: LedgerMatchDayBody[];
}

export class NetRevenueComponentBody {
  @ApiProperty({ enum: ['available', 'not-available'] }) status!: string;
  @ApiProperty({ required: false, type: MoneyBody, description: 'Only when available.' })
  amount?: MoneyBody;
  @ApiProperty({
    required: false,
    enum: ['not-reported', 'not-recorded'],
    description: 'Only when not available: never show it as 0.',
  })
  reason?: string;
}

export class NetRevenueTotalBody {
  @ApiProperty({
    enum: ['complete', 'partial'],
    description: '`partial`: no amount at all; show the components under their own labels.',
  })
  status!: string;
  @ApiProperty({ required: false, type: MoneyBody, description: 'Only when complete.' })
  amount?: MoneyBody;
  @ApiProperty({ required: false, type: [String], description: 'Only when partial.' })
  missing?: string[];
}

export class NetRevenueBody {
  @ApiProperty() currency!: string;
  @ApiProperty({ type: MoneyBody, description: 'Commission charged, without GST.' })
  commissionCharged!: MoneyBody;
  @ApiProperty({ type: MoneyBody, description: 'Commission given back by seller-borne refunds.' })
  commissionRefunded!: MoneyBody;
  @ApiProperty({
    description:
      'commission, deliveryMargin, platformFundedDiscounts, platformFundedCashback, fleetFees: ' +
      'each a NetRevenueComponentBody.',
  })
  components!: Record<string, NetRevenueComponentBody>;
  @ApiProperty({ type: NetRevenueTotalBody }) total!: NetRevenueTotalBody;
}

export class TakeRateBody {
  @ApiProperty({
    enum: ['complete', 'partial', 'no-sales'],
    description:
      'Net revenue ÷ GMV without GST. `partial`: from the `basis` components only (label it so); ' +
      '`no-sales`: no GMV in the range.',
  })
  status!: string;
  @ApiProperty({ required: false, type: Number, description: 'Basis points (1320 is 13.2%).' })
  rateBp?: number;
  @ApiProperty({ required: false, type: [String] }) basis?: string[];
  @ApiProperty({ required: false, type: [String] }) missing?: string[];
}

export class TakeRatePairBody {
  @ApiProperty({ type: TakeRateBody, nullable: true }) current!: TakeRateBody | null;
  @ApiProperty({ type: TakeRateBody, nullable: true }) previous!: TakeRateBody | null;
}

export class FinanceNetBody {
  @ApiProperty({ type: LedgerReadinessBody }) readiness!: LedgerReadinessBody;
  @ApiProperty({ type: NetRevenueBody, nullable: true, description: 'Null until ready.' })
  current!: NetRevenueBody | null;
  @ApiProperty({ type: NetRevenueBody, nullable: true, description: 'Null until ready.' })
  previous!: NetRevenueBody | null;
  @ApiProperty({ type: TakeRatePairBody }) takeRate!: TakeRatePairBody;
  @ApiProperty({
    description: 'commission, total (na unless both complete) and takeRateBp (basis points).',
  })
  deltas!: Record<string, DeltaBody>;
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
  @ApiProperty({
    type: FinanceNetBody,
    nullable: true,
    description: 'Net revenue and take rate; null when only this read failed (GMV still shows).',
  })
  net!: FinanceNetBody | null;
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

export class SameDayShareBody {
  @ApiProperty({
    enum: ['available', 'not-enough-data', 'not-available'],
    description:
      'Seller orders paid on a Market day of the period whose buyer chose the same-day delivery ' +
      'method, of all seller orders paid in it (cancelled and refunded included). ' +
      '`not-enough-data`: fewer than `minimum` paid, show "Not enough data", never a percentage. ' +
      '`not-available` (`method-unknown`): some paid seller orders have no delivery method ' +
      'recorded yet; never show 0.',
  })
  status!: string;
  @ApiProperty({
    required: false,
    enum: ['method-unknown'],
    description: 'Only when not-available.',
  })
  reason?: string;
  @ApiProperty({ required: false, type: Number, description: 'Only when available.' })
  sameDay?: number;
  @ApiProperty({
    required: false,
    type: Number,
    description: 'Seller orders paid in the period. When available or not-enough-data.',
  })
  paid?: number;
  @ApiProperty({
    required: false,
    type: Number,
    description: 'sameDay ÷ paid in basis points. Only when available.',
  })
  rateBp?: number;
  @ApiProperty({
    required: false,
    type: Number,
    description: 'The smallest paid count that gets a share (5). Only when not-enough-data.',
  })
  minimum?: number;
  @ApiProperty({
    required: false,
    type: Number,
    description: 'Paid seller orders with no delivery method yet. Only when not-available.',
  })
  unknownMethod?: number;
}

export class OrdersByStatusKpiBody {
  @ApiProperty({ description: 'Seller orders paid on a Market day of the period.' }) paid!: number;
  @ApiProperty({ description: 'Not shipped yet (not cancelled, no refund).' }) toShip!: number;
  @ApiProperty({ description: 'Shipped, not delivered (not cancelled, no refund).' })
  shipped!: number;
  @ApiProperty({ description: 'Delivered (not cancelled, no refund).' }) delivered!: number;
  @ApiProperty({ description: 'Cancelled after payment.' }) cancelled!: number;
  @ApiProperty({ description: 'Not cancelled, with at least one succeeded refund.' })
  refunded!: number;
  @ApiProperty({ nullable: true, type: Number }) cancelledRateBp!: number | null;
  @ApiProperty({ nullable: true, type: Number }) refundedRateBp!: number | null;
  @ApiProperty({ type: SameDayShareBody }) sameDayShare!: SameDayShareBody;
}

export class OrdersByStatusSectionBody {
  @ApiProperty({ enum: ['ok', 'error'] }) status!: string;
  @ApiProperty({ required: false, type: OrdersByStatusKpiBody }) kpis?: OrdersByStatusKpiBody;
}

export class StateShareBody {
  @ApiProperty({ description: 'Region code of the delivery address (pickup: the store).' })
  state!: string;
  @ApiProperty() orders!: number;
  @ApiProperty({ description: 'orders ÷ paid in basis points.' }) shareBp!: number;
}

export class OtherShareBody {
  @ApiProperty() orders!: number;
  @ApiProperty() shareBp!: number;
}

export class OrdersByStateKpiBody {
  @ApiProperty({
    enum: ['available', 'not-enough-data'],
    description: '`not-enough-data`: fewer than `minimum` paid, show no shares.',
  })
  status!: string;
  @ApiProperty({ description: 'Seller orders paid on a Market day of the period.' }) paid!: number;
  @ApiProperty({ required: false, type: Number, description: 'Only when not-enough-data.' })
  minimum?: number;
  @ApiProperty({
    required: false,
    type: [StateShareBody],
    description: 'Only when available: biggest first, at most eight.',
  })
  states?: StateShareBody[];
  @ApiProperty({
    required: false,
    type: OtherShareBody,
    nullable: true,
    description: 'Paid orders of the states beyond the listed ones.',
  })
  other?: OtherShareBody | null;
  @ApiProperty({
    required: false,
    type: OtherShareBody,
    nullable: true,
    description: 'Paid orders with no state recorded yet; never fold them into a state.',
  })
  unknown?: OtherShareBody | null;
}

export class OrdersByStateSectionBody {
  @ApiProperty({ enum: ['ok', 'error'] }) status!: string;
  @ApiProperty({ required: false, type: OrdersByStateKpiBody }) kpis?: OrdersByStateKpiBody;
}

export class MarketTargetForecastBody {
  @ApiProperty({
    enum: ['estimate', 'not-enough-data'],
    description:
      '`estimate`: GMV to date ÷ time elapsed × length of the month; label it an estimate. ' +
      '`not-enough-data`: fewer than `minimumDays` whole days of the month behind today.',
  })
  status!: string;
  @ApiProperty({ required: false, type: String, description: 'Only with `estimate`.' })
  amount?: string;
  @ApiProperty({ required: false, type: Number }) daysElapsed?: number;
  @ApiProperty({ required: false, type: Number }) minimumDays?: number;
}

export class MarketTargetKpiBody {
  @ApiProperty({ example: '2026-11', description: "The calendar month of the Market's zone." })
  month!: string;
  @ApiProperty({ example: '2026-10' }) lastMonth!: string;
  @ApiProperty() timezone!: string;
  @ApiProperty({ description: 'ISO 4217; every amount is in it.' }) currency!: string;
  @ApiProperty() daysInMonth!: number;
  @ApiProperty() dayOfMonth!: number;
  @ApiProperty({ description: 'Days still to sell in, today included.' }) daysLeft!: number;
  @ApiProperty({ description: 'GMV with GST of the 1st through now (the KPI GMV), minor units.' })
  monthToDate!: string;
  @ApiProperty({ description: 'GMV with GST of the whole month before.' }) lastMonthTotal!: string;
  @ApiProperty({ type: MarketTargetForecastBody }) forecast!: MarketTargetForecastBody;
  @ApiProperty({ nullable: true, type: String, description: 'Null while no target is set.' })
  target!: string | null;
  @ApiProperty({ nullable: true, type: Number, description: 'GMV to date ÷ target, bp.' })
  progressBp!: number | null;
  @ApiProperty({ nullable: true, type: Number, description: 'Forecast ÷ target, bp.' })
  paceBp!: number | null;
  @ApiProperty({ nullable: true, type: String }) toGo!: string | null;
  @ApiProperty({ nullable: true, type: String }) perDayToGo!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) refreshedAt!: string | null;
}

export class MarketTargetSectionBody {
  @ApiProperty({ enum: ['ok', 'error'] }) status!: string;
  @ApiProperty({ required: false, type: MarketTargetKpiBody }) kpis?: MarketTargetKpiBody;
}

export class FunnelStepBody {
  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Customer-days of the period (each day counts distinct customers; one who comes back on ' +
      'another day counts again). Null: fewer than five, hidden; never show 0.',
  })
  count!: number | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'This step ÷ the step before, basis points; null for the first step or hidden.',
  })
  rateBp!: number | null;
  @ApiProperty({ type: DeltaBody, description: 'The count against the period before.' })
  change!: DeltaBody;
  @ApiProperty({
    type: DeltaBody,
    description: 'The rate against the period before, in basis points of difference.',
  })
  rateChange!: DeltaBody;
}

export class ShoppingFunnelKpiBody {
  @ApiProperty({
    enum: ['available', 'not-enough-data'],
    description: '`not-enough-data`: fewer than `minimum` viewers in the period; show no step.',
  })
  status!: string;
  @ApiProperty({ required: false, type: Number, description: 'Only when not-enough-data.' })
  minimum?: number;
  @ApiProperty({ required: false, type: FunnelStepBody, description: 'Viewed a product.' })
  viewed?: FunnelStepBody;
  @ApiProperty({ required: false, type: FunnelStepBody, description: '... and added to the cart.' })
  carted?: FunnelStepBody;
  @ApiProperty({
    required: false,
    type: FunnelStepBody,
    description: '... and placed an order (started checkout).',
  })
  checkedOut?: FunnelStepBody;
  @ApiProperty({ required: false, type: FunnelStepBody, description: '... and paid.' })
  paid?: FunnelStepBody;
  @ApiProperty({
    description: 'Days of the period with a nightly count (today has none until tomorrow).',
  })
  recordedDays!: number;
  @ApiProperty() periodDays!: number;
}

export class ShoppingFunnelSectionBody {
  @ApiProperty({ enum: ['ok', 'error'] }) status!: string;
  @ApiProperty({ required: false, type: ShoppingFunnelKpiBody }) kpis?: ShoppingFunnelKpiBody;
}

export class DiscountKindCostBody {
  @ApiProperty({ enum: ['promotion', 'first-order', 'free-shipping'] }) kind!: string;
  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Redemptions (an order may use several promotions). Null: 1 to 4 uses, every figure of ' +
      'the kind held back; show "fewer than 5", never 0.',
  })
  uses!: number | null;
  @ApiProperty({ type: MoneyBody, nullable: true }) amount!: MoneyBody | null;
  @ApiProperty({ type: MoneyBody, nullable: true, description: 'What Mondapac funded of it.' })
  platformShare!: MoneyBody | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Share of the whole discount, basis points; the kinds add up to 10000. Null when the ' +
      'whole is 0 or the kind is held back.',
  })
  shareBp!: number | null;
}

export class DiscountReleasedBody {
  @ApiProperty({ description: 'Orders of the period refunded or cancelled after payment.' })
  orders!: number;
  @ApiProperty({ type: MoneyBody, description: 'The discount they gave back (not in `amount`).' })
  amount!: MoneyBody;
}

export class DiscountCostKpiBody {
  @ApiProperty({
    enum: ['available', 'not-enough-data'],
    description: '`not-enough-data`: fewer than `minimum` discounted orders; show no amounts.',
  })
  status!: string;
  @ApiProperty({
    description: 'Orders paid in the period with at least one discount that still stands.',
  })
  orders!: number;
  @ApiProperty({ required: false, type: Number, description: 'Only when not-enough-data.' })
  minimum?: number;
  @ApiProperty({
    required: false,
    type: MoneyBody,
    description: 'The discounts that still stand, with GST; only when available.',
  })
  amount?: MoneyBody;
  @ApiProperty({ required: false, type: MoneyBody, description: 'Mondapac funded.' })
  platformShare?: MoneyBody;
  @ApiProperty({ required: false, type: MoneyBody, description: 'Sellers funded.' })
  sellerShare?: MoneyBody;
  @ApiProperty({
    required: false,
    type: Number,
    nullable: true,
    description: 'platformShare ÷ amount, basis points.',
  })
  platformShareBp?: number | null;
  @ApiProperty({
    required: false,
    type: DeltaBody,
    description: '`amount` against the period before.',
  })
  change?: DeltaBody;
  @ApiProperty({ required: false, type: MoneyBody }) previousAmount?: MoneyBody;
  @ApiProperty({
    required: false,
    type: [DiscountKindCostBody],
    description: 'Every kind, zeros included.',
  })
  byKind?: DiscountKindCostBody[];
  @ApiProperty({
    required: false,
    type: DiscountReleasedBody,
    nullable: true,
    description: 'Null when 1 to 4 orders gave a discount back (held back).',
  })
  released?: DiscountReleasedBody | null;
}

export class DiscountCostSectionBody {
  @ApiProperty({ enum: ['ok', 'error'] }) status!: string;
  @ApiProperty({ required: false, type: DiscountCostKpiBody }) kpis?: DiscountCostKpiBody;
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
  @ApiProperty({
    type: () => ListingsHealthBody,
    nullable: true,
    description: 'Live listings and out of stock. Null without `catalog.product.view`.',
  })
  listings!: ListingsHealthBody | null;
  @ApiProperty({
    type: () => CertificatesExpiringBody,
    nullable: true,
    description:
      'Approved seller certificates expiring in the next 30 Market days. Null without ' +
      '`certification.seller-certificate.view`.',
  })
  certificatesExpiring!: CertificatesExpiringBody | null;
  @ApiProperty({
    type: () => PayoutsOnHoldBody,
    nullable: true,
    description: 'Active payout holds. Null without `commission-payouts.settlement.view`.',
  })
  payoutsOnHold!: PayoutsOnHoldBody | null;
  @ApiProperty({
    type: () => DisputeRateBody,
    nullable: true,
    description:
      'Chargebacks opened in the period ÷ seller orders paid in it. Null without both ' +
      '`commission-payouts.dispute.view` and `ordering.order.view`.',
  })
  disputeRate!: DisputeRateBody | null;
}

export class ListingsHealthBody {
  @ApiProperty({ enum: ['ok', 'error'] }) status!: string;
  @ApiProperty({ required: false, type: Number }) active?: number;
  @ApiProperty({ required: false, type: Number }) outOfStock?: number;
  @ApiProperty({ required: false, nullable: true, type: Number, description: 'Of active.' })
  outOfStockRateBp?: number | null;
}

export class CertificatesExpiringBody {
  @ApiProperty({ enum: ['ok', 'error'] }) status!: string;
  @ApiProperty({ required: false, type: Number }) count?: number;
  @ApiProperty({ required: false, type: Number, example: 30 }) withinDays?: number;
}

export class NotAvailableBody {
  @ApiProperty({ enum: ['not-available'] }) status!: string;
  @ApiProperty({ enum: ['not-reported', 'not-recorded'] }) reason!: string;
}

export class PayoutsOnHoldBody {
  @ApiProperty({ enum: ['ok', 'error'] }) status!: string;
  @ApiProperty({ required: false, type: Number }) count?: number;
  @ApiProperty({
    required: false,
    type: NotAvailableBody,
    description: 'The money the holds keep is not recorded per hold yet: never show 0.',
  })
  amount?: NotAvailableBody;
}

export class DisputeRateBody {
  @ApiProperty({ enum: ['ok', 'error'] }) status!: string;
  @ApiProperty({ required: false, type: Number }) disputes?: number;
  @ApiProperty({ required: false, type: Number }) paidSellerOrders?: number;
  @ApiProperty({ required: false, nullable: true, type: Number }) rateBp?: number | null;
}

export class AdminKpisBody {
  @ApiProperty({ format: 'date-time' }) generatedAt!: string;
  @ApiProperty({
    enum: ['today', '7d', '30d', 'month', 'custom'],
    description: 'The period asked for (`custom`: a from/to range).',
  })
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
    type: OrdersByStatusSectionBody,
    nullable: true,
    description: 'Null without `ordering.order.view`: leave the card out.',
  })
  ordersByStatus!: OrdersByStatusSectionBody | null;
  @ApiProperty({
    type: OrdersByStateSectionBody,
    nullable: true,
    description: 'Null without `ordering.order.view`: leave the card out.',
  })
  ordersByState!: OrdersByStateSectionBody | null;
  @ApiProperty({
    type: MarketTargetSectionBody,
    nullable: true,
    description:
      'The current month against the monthly revenue target, whatever the period. Null without ' +
      '`commission-payouts.settlement.view` and `settings.monthly-revenue-target.view`.',
  })
  marketTarget!: MarketTargetSectionBody | null;
  @ApiProperty({
    type: ShoppingFunnelSectionBody,
    nullable: true,
    description: 'Null without `ordering.order.view`: leave the card out.',
  })
  shoppingFunnel!: ShoppingFunnelSectionBody | null;
  @ApiProperty({
    type: DiscountCostSectionBody,
    nullable: true,
    description:
      'Null without both `commission-payouts.settlement.view` and `promotions.promotion.manage`: ' +
      'leave the card out.',
  })
  discountCost!: DiscountCostSectionBody | null;
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
    description: 'Null when the viewer holds none of the keys of its numbers.',
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

function readinessBody(readiness: LedgerReadiness): LedgerReadinessBody {
  return {
    ready: readiness.ready,
    reason: readiness.reason,
    backfillFinished: readiness.backfillFinished,
    backfillFailedFacts: readiness.backfillFailedFacts,
    matchedSellerOrders: readiness.matchedSellerOrders,
    window: { ...readiness.window },
    days: readiness.days.map((day) => ({ ...day })),
  };
}

function netRevenueBody(net: NetRevenue | null): NetRevenueBody | null {
  if (net === null) return null;
  const components: Record<string, NetRevenueComponentBody> = {};
  for (const [name, component] of Object.entries(net.components)) {
    components[name] =
      component.status === 'available'
        ? { status: 'available', amount: money(component.amount, net.currency) }
        : { status: 'not-available', reason: component.reason };
  }
  return {
    currency: net.currency,
    commissionCharged: money(net.commissionCharged, net.currency),
    commissionRefunded: money(net.commissionRefunded, net.currency),
    components,
    total:
      net.total.status === 'complete'
        ? { status: 'complete', amount: money(net.total.amount, net.currency) }
        : { status: 'partial', missing: [...net.total.missing] },
  };
}

function takeRateBody(rate: TakeRate | null): TakeRateBody | null {
  if (rate === null) return null;
  if (rate.status === 'no-sales') return { status: 'no-sales' };
  if (rate.status === 'complete') return { status: 'complete', rateBp: rate.rateBp };
  return {
    status: 'partial',
    rateBp: rate.rateBp,
    basis: [...rate.basis],
    missing: [...rate.missing],
  };
}

function financeNetBody(net: FinanceNet | null): FinanceNetBody | null {
  if (net === null) return null;
  return {
    readiness: readinessBody(net.readiness),
    current: netRevenueBody(net.current),
    previous: netRevenueBody(net.previous),
    takeRate: {
      current: takeRateBody(net.takeRate.current),
      previous: takeRateBody(net.takeRate.previous),
    },
    deltas: { ...net.deltas },
  };
}

function sameDayShareBody(share: SameDayShare): SameDayShareBody {
  switch (share.status) {
    case 'available':
      return {
        status: 'available',
        sameDay: share.sameDay,
        paid: share.paid,
        rateBp: share.rateBp,
      };
    case 'not-enough-data':
      return { status: 'not-enough-data', paid: share.paid, minimum: share.minimum };
    case 'not-available':
      return { status: 'not-available', reason: share.reason, unknownMethod: share.unknownMethod };
  }
}

function ordersByStatusSection(
  section: AdminKpisAnswer['ordersByStatus'],
): OrdersByStatusSectionBody | null {
  if (section === null) return null;
  if (section.status === 'error') return { status: 'error' };
  const { counts, sameDayShare } = section.value;
  return { status: 'ok', kpis: { ...counts, sameDayShare: sameDayShareBody(sameDayShare) } };
}

function ordersByStateSection(
  section: AdminKpisAnswer['ordersByState'],
): OrdersByStateSectionBody | null {
  if (section === null) return null;
  if (section.status === 'error') return { status: 'error' };
  const { byState } = section.value;
  if (byState.status === 'not-enough-data') {
    return {
      status: 'ok',
      kpis: { status: byState.status, paid: byState.paid, minimum: byState.minimum },
    };
  }
  return {
    status: 'ok',
    kpis: {
      status: byState.status,
      paid: byState.paid,
      states: byState.states.map((row) => ({ ...row })),
      other: byState.other === null ? null : { ...byState.other },
      unknown: byState.unknown === null ? null : { ...byState.unknown },
    },
  };
}

const minorText = (value: bigint | null): string | null =>
  value === null ? null : value.toString();

function marketTargetSection(
  section: AdminKpisAnswer['marketTarget'],
): MarketTargetSectionBody | null {
  if (section === null) return null;
  if (section.status === 'error') return { status: 'error' };
  const { figures, timezone, currency, refreshedAt } = section.value;
  const { forecast } = figures;
  return {
    status: 'ok',
    kpis: {
      month: figures.month,
      lastMonth: figures.lastMonth,
      timezone,
      currency,
      daysInMonth: figures.daysInMonth,
      dayOfMonth: figures.dayOfMonth,
      daysLeft: figures.daysLeft,
      monthToDate: figures.monthToDate.toString(),
      lastMonthTotal: figures.lastMonthTotal.toString(),
      forecast:
        forecast.status === 'estimate'
          ? { status: forecast.status, amount: forecast.amount.toString() }
          : {
              status: forecast.status,
              daysElapsed: forecast.daysElapsed,
              minimumDays: forecast.minimumDays,
            },
      target: minorText(figures.target),
      progressBp: figures.progressBp,
      paceBp: figures.paceBp,
      toGo: minorText(figures.toGo),
      perDayToGo: minorText(figures.perDayToGo),
      refreshedAt: refreshedAt === null ? null : refreshedAt.toString(),
    },
  };
}

function shoppingFunnelSection(
  section: AdminKpisAnswer['shoppingFunnel'],
): ShoppingFunnelSectionBody | null {
  if (section === null) return null;
  if (section.status === 'error') return { status: 'error' };
  const { funnel } = section.value;
  if (funnel.status === 'not-enough-data') return { status: 'ok', kpis: { ...funnel } };
  const step = (value: FunnelStep): FunnelStepBody => ({
    count: value.count,
    rateBp: value.rateBp,
    change: { ...value.change },
    rateChange: { ...value.rateChange },
  });
  return {
    status: 'ok',
    kpis: {
      status: funnel.status,
      viewed: step(funnel.viewed),
      carted: step(funnel.carted),
      checkedOut: step(funnel.checkedOut),
      paid: step(funnel.paid),
      recordedDays: funnel.recordedDays,
      periodDays: funnel.periodDays,
    },
  };
}

function discountCostSection(
  section: AdminKpisAnswer['discountCost'],
): DiscountCostSectionBody | null {
  if (section === null) return null;
  if (section.status === 'error') return { status: 'error' };
  const { cost, currency } = section.value;
  if (cost.status === 'not-enough-data') return { status: 'ok', kpis: { ...cost } };
  return {
    status: 'ok',
    kpis: {
      status: cost.status,
      orders: cost.orders,
      amount: money(cost.amount, currency),
      platformShare: money(cost.platformShare, currency),
      sellerShare: money(cost.sellerShare, currency),
      platformShareBp: cost.platformShareBp,
      change: { ...cost.change },
      previousAmount: money(cost.previousAmount, currency),
      byKind: cost.byKind.map((row) => ({
        kind: row.kind,
        uses: row.uses,
        amount: row.amount === null ? null : money(row.amount, currency),
        platformShare: row.platformShare === null ? null : money(row.platformShare, currency),
        shareBp: row.shareBp,
      })),
      released:
        cost.released === null
          ? null
          : { orders: cost.released.orders, amount: money(cost.released.amount, currency) },
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
      net: financeNetBody(value.net),
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
    answer.ordersByStatus,
    answer.ordersByState,
    answer.shoppingFunnel,
    answer.discountCost,
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
    ordersByStatus: ordersByStatusSection(answer.ordersByStatus),
    ordersByState: ordersByStateSection(answer.ordersByState),
    marketTarget: marketTargetSection(answer.marketTarget),
    shoppingFunnel: shoppingFunnelSection(answer.shoppingFunnel),
    discountCost: discountCostSection(answer.discountCost),
    topSellers: topSellersSection(answer.topSellers),
    topCategories: topCategoriesSection(answer.topCategories),
    health:
      answer.health === null
        ? null
        : {
            uncertifiedListings: answer.health.uncertifiedListings,
            sellersAtRisk: answer.health.sellersAtRisk,
            listings: answer.health.listings,
            certificatesExpiring: answer.health.certificatesExpiring,
            payoutsOnHold:
              answer.health.payoutsOnHold === null ? null : { ...answer.health.payoutsOnHold },
            disputeRate: answer.health.disputeRate,
          },
  };
}
