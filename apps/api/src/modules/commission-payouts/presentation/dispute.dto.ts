import { ApiProperty } from '@nestjs/swagger';
import type { DisputeDecisionView } from '../application/use-cases/decide-dispute.use-case';
import type {
  DisputeListView,
  DisputeRowView,
  MoneyView,
} from '../application/use-cases/list-disputes.use-case';
import type { OwnDisputeView } from '../application/use-cases/list-own-disputes.use-case';
import type {
  DecisionView,
  DisputeDetailView,
  DisputeSellerOrderView,
  TimelineView,
} from '../application/use-cases/view-dispute.use-case';
import {
  DECISION_BEARERS,
  DECISION_REASON_CODES,
  DISPUTE_BUCKETS,
  DISPUTE_STATUSES,
} from '../domain/dispute';

// Bodies of the dispute routes (package 8b). Ids, enums, minor-unit strings and instants only: a
// seller's body never carries a reason, an evidence date, a provider id or buyer data.

const MONEY_STATES = ['withdrawn', 'inquiry', 'reinstated', 'none'] as const;

class MoneyBody {
  @ApiProperty({ description: 'Minor units, as a string.' }) amountMinor!: string;
  @ApiProperty({ description: 'ISO 4217.' }) currency!: string;
}

const money = (value: MoneyView): MoneyBody => ({
  amountMinor: value.amountMinor.toString(),
  currency: value.currency,
});

class DisputeSellerBody {
  @ApiProperty({ format: 'uuid' }) sellerId!: string;
  @ApiProperty({ nullable: true, type: String, description: 'The public store name, if known.' })
  storeName!: string | null;
}

class DisputeRowBody {
  @ApiProperty({ format: 'uuid' }) disputeId!: string;
  @ApiProperty({ format: 'uuid', description: 'There is no order number yet; show this id.' })
  orderId!: string;
  @ApiProperty({ type: [DisputeSellerBody] }) sellers!: DisputeSellerBody[];
  @ApiProperty({ description: "Stripe's reason code (admin only)." }) reason!: string;
  @ApiProperty({ enum: MONEY_STATES }) moneyState!: string;
  @ApiProperty({ enum: DISPUTE_STATUSES }) status!: string;
  @ApiProperty({ enum: DISPUTE_BUCKETS }) bucket!: string;
  @ApiProperty({ format: 'date-time', nullable: true, type: String }) evidenceDueBy!: string | null;
  @ApiProperty({ type: MoneyBody }) amount!: MoneyBody;
  @ApiProperty({ format: 'date-time' }) openedAt!: string;
}

class DisputeCountsBody {
  @ApiProperty() 'needs-response'!: number;
  @ApiProperty() 'decision-needed'!: number;
  @ApiProperty() 'under-review'!: number;
  @ApiProperty() won!: number;
  @ApiProperty() closed!: number;
}

export class DisputeListBody {
  @ApiProperty({ type: DisputeCountsBody, description: 'The number of cases per bucket.' })
  counts!: DisputeCountsBody;
  @ApiProperty({ type: [DisputeRowBody], description: 'Newest opened first.' })
  disputes!: DisputeRowBody[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
}

class DecidedBody {
  @ApiProperty({ enum: DECISION_BEARERS }) bearer!: string;
  @ApiProperty({ type: MoneyBody, nullable: true }) amount!: MoneyBody | null;
  @ApiProperty({ enum: DECISION_REASON_CODES }) reasonCode!: string;
  @ApiProperty({ format: 'uuid' }) decidedBy!: string;
  @ApiProperty({ format: 'date-time' }) decidedAt!: string;
  @ApiProperty({
    nullable: true,
    description:
      'Set when the platform reversed a seller decision after the bank returned the money.',
  })
  reversal!: { reasonCode: string; decidedBy: string; decidedAt: string } | null;
}

class DisputeSellerOrderBody {
  @ApiProperty({ format: 'uuid' }) sellerOrderId!: string;
  @ApiProperty({ format: 'uuid' }) sellerId!: string;
  @ApiProperty({ nullable: true, type: String }) storeName!: string | null;
  @ApiProperty({
    type: MoneyBody,
    description: "The seller's unreversed share of this seller order.",
  })
  sellerShare!: MoneyBody;
  @ApiProperty({
    type: MoneyBody,
    description: 'The most that may be recovered now: the share less what disputes already took.',
  })
  recoverableCap!: MoneyBody;
  @ApiProperty({ description: 'The dispute still holds this seller order.' }) holdActive!: boolean;
  @ApiProperty({
    enum: ['allowed', 'reversal-allowed', 'not-allowed'],
    description: 'Whether a decision may be recorded now.',
  })
  decision!: string;
  @ApiProperty({ type: DecidedBody, nullable: true }) decided!: DecidedBody | null;
}

class TimelineBody {
  @ApiProperty({
    enum: [
      'opened',
      'funds-withdrawn',
      'funds-reinstated',
      'closed',
      'decided',
      'decision-reversed',
    ],
  })
  kind!: string;
  @ApiProperty({ format: 'date-time' }) at!: string;
  @ApiProperty({ format: 'uuid', nullable: true, type: String }) sellerOrderId!: string | null;
}

export class DisputeDetailBody {
  @ApiProperty({ format: 'uuid' }) disputeId!: string;
  @ApiProperty({ format: 'uuid' }) orderId!: string;
  @ApiProperty({ description: "Stripe's dispute id; the panel builds the Dashboard link." })
  providerDisputeId!: string;
  @ApiProperty({ type: MoneyBody }) amount!: MoneyBody;
  @ApiProperty({ enum: DISPUTE_STATUSES }) status!: string;
  @ApiProperty() inquiry!: boolean;
  @ApiProperty() closed!: boolean;
  @ApiProperty({ enum: ['won', 'lost'], nullable: true, type: String }) outcome!: string | null;
  @ApiProperty() reason!: string;
  @ApiProperty({ format: 'date-time', nullable: true, type: String }) evidenceDueBy!: string | null;
  @ApiProperty({ enum: MONEY_STATES }) moneyState!: string;
  @ApiProperty({ enum: DISPUTE_BUCKETS }) bucket!: string;
  @ApiProperty({ description: 'Lost, and the bank later returned the money: an admin case.' })
  needsReview!: boolean;
  @ApiProperty({ format: 'date-time' }) openedAt!: string;
  @ApiProperty({ type: [DisputeSellerOrderBody] }) sellerOrders!: DisputeSellerOrderBody[];
  @ApiProperty({ type: [TimelineBody], description: 'Oldest first.' }) timeline!: TimelineBody[];
}

export class DisputeDecisionRequest {
  @ApiProperty({ enum: DECISION_BEARERS }) bearer!: string;
  @ApiProperty({
    required: false,
    description:
      'Minor units as a string; required when the seller bears it (more than 0 and at most the seller order recoverableCap), absent for the platform.',
    example: '2500',
  })
  amountMinor?: string;
  @ApiProperty({ enum: DECISION_REASON_CODES }) reasonCode!: string;
}

export class DisputeDecisionBody {
  @ApiProperty({ format: 'uuid' }) disputeId!: string;
  @ApiProperty({ format: 'uuid' }) sellerOrderId!: string;
  @ApiProperty({ format: 'uuid' }) sellerId!: string;
  @ApiProperty({ enum: DECISION_BEARERS }) bearer!: string;
  @ApiProperty({ type: MoneyBody, nullable: true }) amount!: MoneyBody | null;
  @ApiProperty({ enum: DECISION_REASON_CODES }) reasonCode!: string;
  @ApiProperty({ description: 'True for the reversal of a seller decision.' }) reversal!: boolean;
  @ApiProperty({ format: 'uuid' }) decidedBy!: string;
  @ApiProperty({ format: 'date-time' }) decidedAt!: string;
  @ApiProperty({ description: 'This decision completed the case and released its holds.' })
  holdsReleased!: boolean;
  @ApiProperty({ enum: DISPUTE_BUCKETS }) bucket!: string;
}

class OwnDisputeBody {
  @ApiProperty({ format: 'uuid' }) sellerOrderId!: string;
  @ApiProperty({ format: 'uuid' }) orderId!: string;
  @ApiProperty({
    format: 'date-time',
    description: 'When the dispute began to hold this seller order.',
  })
  since!: string;
  @ApiProperty({ description: 'The dispute still holds the money of this seller order.' })
  open!: boolean;
  @ApiProperty({
    type: MoneyBody,
    nullable: true,
    description: 'What the seller repaid after the decision; absent of a reason by design.',
  })
  recoveredAmount!: MoneyBody | null;
}

export class OwnDisputesBody {
  @ApiProperty({ type: [OwnDisputeBody], description: 'Open ones first, newest first.' })
  disputes!: OwnDisputeBody[];
}

const rowBody = (row: DisputeRowView): DisputeRowBody => ({
  disputeId: row.disputeId,
  orderId: row.orderId,
  sellers: row.sellers.map((s) => ({ sellerId: s.sellerId, storeName: s.storeName })),
  reason: row.reason,
  moneyState: row.moneyState,
  status: row.status,
  bucket: row.bucket,
  evidenceDueBy: row.evidenceDueBy === null ? null : row.evidenceDueBy.toString(),
  amount: money(row.amount),
  openedAt: row.openedAt.toString(),
});

export const disputeListBody = (view: DisputeListView): DisputeListBody => ({
  counts: { ...view.counts },
  disputes: view.disputes.map(rowBody),
  nextCursor: view.nextCursor,
});

const decidedBody = (view: DecisionView): DecidedBody => ({
  bearer: view.bearer,
  amount: view.amount === null ? null : money(view.amount),
  reasonCode: view.reasonCode,
  decidedBy: view.decidedBy,
  decidedAt: view.decidedAt.toString(),
  reversal:
    view.reversal === null
      ? null
      : {
          reasonCode: view.reversal.reasonCode,
          decidedBy: view.reversal.decidedBy,
          decidedAt: view.reversal.decidedAt.toString(),
        },
});

const sellerOrderBody = (view: DisputeSellerOrderView): DisputeSellerOrderBody => ({
  sellerOrderId: view.sellerOrderId,
  sellerId: view.sellerId,
  storeName: view.storeName,
  sellerShare: money(view.sellerShare),
  recoverableCap: money(view.recoverableCap),
  holdActive: view.holdActive,
  decision: view.decision,
  decided: view.decided === null ? null : decidedBody(view.decided),
});

const timelineBody = (view: TimelineView): TimelineBody => ({
  kind: view.kind,
  at: view.at.toString(),
  sellerOrderId: view.sellerOrderId,
});

export const disputeDetailBody = (view: DisputeDetailView): DisputeDetailBody => ({
  disputeId: view.disputeId,
  orderId: view.orderId,
  providerDisputeId: view.providerDisputeId,
  amount: money(view.amount),
  status: view.status,
  inquiry: view.inquiry,
  closed: view.closed,
  outcome: view.outcome,
  reason: view.reason,
  evidenceDueBy: view.evidenceDueBy === null ? null : view.evidenceDueBy.toString(),
  moneyState: view.moneyState,
  bucket: view.bucket,
  needsReview: view.needsReview,
  openedAt: view.openedAt.toString(),
  sellerOrders: view.sellerOrders.map(sellerOrderBody),
  timeline: view.timeline.map(timelineBody),
});

export const disputeDecisionBody = (view: DisputeDecisionView): DisputeDecisionBody => ({
  disputeId: view.disputeId,
  sellerOrderId: view.sellerOrderId,
  sellerId: view.sellerId,
  bearer: view.bearer,
  amount: view.amount === null ? null : money(view.amount),
  reasonCode: view.reasonCode,
  reversal: view.reversal,
  decidedBy: view.decidedBy,
  decidedAt: view.decidedAt.toString(),
  holdsReleased: view.holdsReleased,
  bucket: view.bucket,
});

export const ownDisputesBody = (views: readonly OwnDisputeView[]): OwnDisputesBody => ({
  disputes: [...views]
    .sort(
      (a, b) =>
        Number(b.open) - Number(a.open) || b.since.epochMilliseconds - a.since.epochMilliseconds,
    )
    .map((view) => ({
      sellerOrderId: view.sellerOrderId,
      orderId: view.orderId,
      since: view.since.toString(),
      open: view.open,
      recoveredAmount: view.recoveredAmount === null ? null : money(view.recoveredAmount),
    })),
});
