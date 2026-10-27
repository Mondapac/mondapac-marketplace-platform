import { ApiProperty } from '@nestjs/swagger';
import type { RateView } from '../application/use-cases/view-commission-rate.use-case';
import { LEDGER_KINDS } from '../domain/ledger';
import { HOLD_REASONS, RELEASE_REASONS, ADMIN_HOLD_REASONS } from '../domain/payout-hold';
import { APPROVAL_MODES, PAYOUT_WEEKDAYS } from '../domain/payout-terms';
import type { PayoutHoldView } from '../application/use-cases/place-payout-hold.use-case';
import type { PayoutTermsView } from '../application/use-cases/view-seller-payout-terms.use-case';
import type { LedgerView } from '../application/use-cases/view-own-ledger.use-case';

// Bodies of the commission-payouts routes. Ids, basis points and minor-unit strings only.

export class CommissionRateBody {
  @ApiProperty({ format: 'uuid' }) sellerId!: string;
  @ApiProperty({ description: 'The rate in force, in basis points (1500 = 15 %).' })
  rateBps!: number;
  @ApiProperty({
    enum: ['seller', 'market'],
    description: "The seller's own rate or the Market's.",
  })
  source!: string;
  @ApiProperty({ description: 'The Market rate, in basis points.' }) marketRateBps!: number;
}

export class SetCommissionRateRequest {
  @ApiProperty({ description: 'Basis points, a whole number from 0 to 3000.', example: 1200 })
  rateBps!: number;
}

class LedgerTotalsBody {
  @ApiProperty({ description: 'Minor units; the goods of paid orders.' }) sales!: string;
  @ApiProperty({ description: 'Minor units; the delivery fees of paid orders.' }) shipping!: string;
  @ApiProperty({ description: 'Minor units; the platform commission.' }) commission!: string;
  @ApiProperty({ description: 'Minor units; the sale rows given back by refunds.' })
  refundedSales!: string;
  @ApiProperty({ description: 'Minor units; the delivery fees given back by refunds.' })
  refundedShipping!: string;
  @ApiProperty({ description: 'Minor units; commission returned to the seller on refunds.' })
  refundedCommission!: string;
  @ApiProperty({ description: 'Minor units; debited for disputes.' }) disputeDebits!: string;
  @ApiProperty({ description: 'Minor units; credited back after a dispute.' })
  disputeReinstated!: string;
  @ApiProperty({
    description:
      'Minor units, may be negative: sales + shipping − commission − refunded sales − refunded ' +
      'shipping + refunded commission − dispute debits + dispute reinstated.',
  })
  balance!: string;
}

class LedgerEntryBody {
  @ApiProperty({ format: 'uuid' }) entryId!: string;
  @ApiProperty({ format: 'uuid' }) orderId!: string;
  @ApiProperty({ format: 'uuid' }) sellerOrderId!: string;
  @ApiProperty({ format: 'uuid', nullable: true, type: String }) orderLineId!: string | null;
  @ApiProperty({ enum: LEDGER_KINDS }) kind!: string;
  @ApiProperty({ enum: ['credit', 'debit'] }) direction!: string;
  @ApiProperty({ description: 'Minor units, never negative.' }) amount!: string;
  @ApiProperty({
    nullable: true,
    type: Number,
    description: 'Commission and refund-commission only.',
  })
  rateBps!: number | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'Commission and refund-commission only: the line amount without GST (for a reversal, the part reversed), in minor units.',
  })
  baseAmount!: string | null;
  @ApiProperty({
    format: 'uuid',
    nullable: true,
    type: String,
    description:
      'The refund (or dispute) a reversal row comes from; null for sale, shipping and commission.',
  })
  sourceId!: string | null;
  @ApiProperty({ format: 'date-time' }) occurredAt!: string;
  @ApiProperty({ format: 'date-time' }) recordedAt!: string;
}

export class LedgerBody {
  @ApiProperty({ format: 'uuid' }) sellerId!: string;
  @ApiProperty({ description: 'ISO 4217, the Market currency.' }) currency!: string;
  @ApiProperty({ type: LedgerTotalsBody }) totals!: LedgerTotalsBody;
  @ApiProperty({ type: [LedgerEntryBody], description: 'Newest first.' })
  entries!: LedgerEntryBody[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
}

export const rateBody = (view: RateView): CommissionRateBody => ({
  sellerId: view.sellerId,
  rateBps: view.rateBps,
  source: view.source,
  marketRateBps: view.marketRateBps,
});

export const ledgerBody = (view: LedgerView): LedgerBody => ({
  sellerId: view.sellerId,
  currency: view.currency,
  totals: {
    sales: view.totals.sales.toString(),
    shipping: view.totals.shipping.toString(),
    commission: view.totals.commission.toString(),
    refundedSales: view.totals.refundedSales.toString(),
    refundedShipping: view.totals.refundedShipping.toString(),
    refundedCommission: view.totals.refundedCommission.toString(),
    disputeDebits: view.totals.disputeDebits.toString(),
    disputeReinstated: view.totals.disputeReinstated.toString(),
    balance: view.totals.balance.toString(),
  },
  entries: view.entries.map((entry) => ({
    entryId: entry.entryId,
    orderId: entry.orderId,
    sellerOrderId: entry.sellerOrderId,
    orderLineId: entry.orderLineId,
    kind: entry.kind,
    direction: entry.direction,
    amount: entry.amount.toString(),
    rateBps: entry.rateBps,
    baseAmount: entry.baseAmount === null ? null : entry.baseAmount.toString(),
    sourceId: entry.sourceId,
    occurredAt: entry.occurredAt.toString(),
    recordedAt: entry.recordedAt.toString(),
  })),
  nextCursor: view.nextCursor,
});

class PayoutTermsValuesBody {
  @ApiProperty({ enum: PAYOUT_WEEKDAYS, isArray: true }) weekdays!: string[];
  @ApiProperty({ example: '10:00', description: "HH:mm in the seller's own time zone." })
  localTime!: string;
  @ApiProperty({ description: 'Days held after a delivery the carrier confirmed (7 to 60).' })
  holdDaysCarrier!: number;
  @ApiProperty({
    description: "Days held after a delivery only the seller's click confirmed (7 to 60).",
  })
  holdDaysSellerClick!: number;
  @ApiProperty({
    description: 'Minor units of the Market currency; a smaller payout carries over.',
  })
  minimumMinor!: string;
  @ApiProperty({ enum: APPROVAL_MODES }) approvalMode!: string;
  @ApiProperty({
    description: 'Market config only: the first payout of a new seller waits for an admin.',
  })
  firstPayoutManual!: boolean;
}

class PayoutTermsOverrideBody {
  @ApiProperty({ enum: PAYOUT_WEEKDAYS, isArray: true, nullable: true, type: [String] })
  weekdays!: string[] | null;
  @ApiProperty({ nullable: true, type: String }) localTime!: string | null;
  @ApiProperty({ nullable: true, type: Number }) holdDaysCarrier!: number | null;
  @ApiProperty({ nullable: true, type: Number }) holdDaysSellerClick!: number | null;
  @ApiProperty({ nullable: true, type: String }) minimumMinor!: string | null;
  @ApiProperty({ enum: APPROVAL_MODES, nullable: true, type: String }) approvalMode!: string | null;
}

export class PayoutTermsBody {
  @ApiProperty({ format: 'uuid' }) sellerId!: string;
  @ApiProperty({ enum: ['seller', 'market'], description: 'Whether the seller has its own terms.' })
  source!: string;
  @ApiProperty({ type: PayoutTermsValuesBody, description: 'The terms in force.' })
  effective!: PayoutTermsValuesBody;
  @ApiProperty({
    type: PayoutTermsOverrideBody,
    nullable: true,
    description: "The seller's own values (null fields use the Market's), or null.",
  })
  override!: PayoutTermsOverrideBody | null;
  @ApiProperty({
    nullable: true,
    type: Number,
    description: 'The override version to send back as expectedVersion; null without an override.',
  })
  version!: number | null;
}

export class SetPayoutTermsRequest {
  @ApiProperty({ enum: PAYOUT_WEEKDAYS, isArray: true, required: false })
  weekdays?: string[];
  @ApiProperty({ required: false, example: '10:00' }) localTime?: string;
  @ApiProperty({ required: false, description: '7 to 60.' }) holdDaysCarrier?: number;
  @ApiProperty({ required: false, description: '7 to 60.' }) holdDaysSellerClick?: number;
  @ApiProperty({ required: false, description: 'Minor units, at least 1.' }) minimumMinor?: number;
  @ApiProperty({ enum: APPROVAL_MODES, required: false }) approvalMode?: string;
  @ApiProperty({
    nullable: true,
    required: false,
    type: Number,
    description:
      'The version the admin saw; null (or absent) when the seller had no override. A field left out uses the Market value; at least one must be set.',
  })
  expectedVersion?: number | null;
}

export class PayoutHoldBody {
  @ApiProperty({ format: 'uuid' }) holdId!: string;
  @ApiProperty({ format: 'uuid' }) sellerId!: string;
  @ApiProperty({ format: 'uuid', nullable: true, type: String }) sellerOrderId!: string | null;
  @ApiProperty({ enum: HOLD_REASONS }) reason!: string;
  @ApiProperty({ enum: ['admin', 'system'] }) origin!: string;
  @ApiProperty({ format: 'date-time' }) placedAt!: string;
  @ApiProperty() active!: boolean;
  @ApiProperty({ format: 'date-time', nullable: true, type: String }) releasedAt!: string | null;
  @ApiProperty({ enum: RELEASE_REASONS, nullable: true, type: String }) releaseReason!:
    string | null;
}

export class PayoutHoldsBody {
  @ApiProperty({ type: [PayoutHoldBody], description: 'Active holds first, newest first.' })
  holds!: PayoutHoldBody[];
}

export class PlacePayoutHoldRequest {
  @ApiProperty({ enum: ADMIN_HOLD_REASONS, description: 'The reason code (required).' })
  reason!: string;
  @ApiProperty({
    format: 'uuid',
    required: false,
    description: "One of the seller's seller orders; absent = the whole seller.",
  })
  sellerOrderId?: string;
}

export class ReleasePayoutHoldRequest {
  @ApiProperty({ enum: RELEASE_REASONS, description: 'The reason code (required).' })
  reason!: string;
}

export const payoutTermsBody = (view: PayoutTermsView): PayoutTermsBody => ({
  sellerId: view.sellerId,
  source: view.source,
  effective: {
    weekdays: [...view.effective.weekdays],
    localTime: view.effective.localTime,
    holdDaysCarrier: view.effective.holdDaysCarrier,
    holdDaysSellerClick: view.effective.holdDaysSellerClick,
    minimumMinor: view.effective.minimumMinor.toString(),
    approvalMode: view.effective.approvalMode,
    firstPayoutManual: view.effective.firstPayoutManual,
  },
  override:
    view.override === null
      ? null
      : {
          weekdays: view.override.weekdays === null ? null : [...view.override.weekdays],
          localTime: view.override.localTime,
          holdDaysCarrier: view.override.holdDaysCarrier,
          holdDaysSellerClick: view.override.holdDaysSellerClick,
          minimumMinor:
            view.override.minimumMinor === null ? null : view.override.minimumMinor.toString(),
          approvalMode: view.override.approvalMode,
        },
  version: view.version,
});

export const payoutHoldBody = (view: PayoutHoldView): PayoutHoldBody => ({
  holdId: view.holdId,
  sellerId: view.sellerId,
  sellerOrderId: view.sellerOrderId,
  reason: view.reason,
  origin: view.origin,
  placedAt: view.placedAt.toString(),
  active: view.active,
  releasedAt: view.releasedAt === null ? null : view.releasedAt.toString(),
  releaseReason: view.releaseReason,
});
