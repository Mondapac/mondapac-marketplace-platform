import { ApiProperty } from '@nestjs/swagger';
import type { LedgerView } from '../application/ledger-flow';
import type { RateView } from '../application/rate-flow';

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
  @ApiProperty({ description: 'Minor units; sales + shipping − commission.' }) balance!: string;
}

class LedgerEntryBody {
  @ApiProperty({ format: 'uuid' }) entryId!: string;
  @ApiProperty({ format: 'uuid' }) orderId!: string;
  @ApiProperty({ format: 'uuid' }) sellerOrderId!: string;
  @ApiProperty({ format: 'uuid', nullable: true, type: String }) orderLineId!: string | null;
  @ApiProperty({ enum: ['sale', 'shipping', 'commission'] }) kind!: string;
  @ApiProperty({ enum: ['credit', 'debit'] }) direction!: string;
  @ApiProperty({ description: 'Minor units, never negative.' }) amount!: string;
  @ApiProperty({ nullable: true, type: Number, description: 'Commission only.' })
  rateBps!: number | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Commission only: the line amount without GST, in minor units.',
  })
  baseAmount!: string | null;
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
    occurredAt: entry.occurredAt.toString(),
    recordedAt: entry.recordedAt.toString(),
  })),
  nextCursor: view.nextCursor,
});
