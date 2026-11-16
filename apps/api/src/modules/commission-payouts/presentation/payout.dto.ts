import { ApiProperty } from '@nestjs/swagger';
import type { ApprovedPayoutView } from '../application/use-cases/approve-payout.use-case';
import type {
  AdminPayoutListPage,
  AdminPayoutRow,
  PayoutRowView,
} from '../application/use-cases/list-payouts.use-case';
import { PAYOUT_LIST_VIEWS, PAYOUT_ROW_ACTIONS } from '../domain/admin-payout-list';
import type { OwnHeldView } from '../application/use-cases/list-own-payout-holds.use-case';
import type {
  OwnPayoutsView,
  OwnPayoutView,
} from '../application/use-cases/list-own-payouts.use-case';
import type { NextPayoutView } from '../application/use-cases/view-next-payout.use-case';
import type { PayoutDetailView } from '../application/use-cases/view-payout.use-case';
import { BLOCK_REASONS, PAYOUT_STATES } from '../domain/payout';
import { OWN_PAYOUT_ROW_ACTIONS } from '../domain/own-payout-list';
import type { OwnPayoutListPage } from '../application/use-cases/list-own-payouts.use-case';

// Bodies of the payout routes (package 6d). Ids, enums, minor-unit strings and instants only. A
// seller's body never carries an admin, a note, a hold id, a transfer id or an internal code.

interface MoneyShape {
  readonly amountMinor: bigint;
  readonly currency: string;
}

class MoneyBody {
  @ApiProperty({ description: 'Minor units, as a string.' }) amountMinor!: string;
  @ApiProperty({ description: 'ISO 4217.' }) currency!: string;
}

const money = (value: MoneyShape): MoneyBody => ({
  amountMinor: value.amountMinor.toString(),
  currency: value.currency,
});
const instant = (value: { toString(): string }): string => value.toString();

// ---------------------------------------------------------------------------------------------
// Admin

class PayoutRowBody {
  @ApiProperty({ format: 'uuid' }) payoutId!: string;
  @ApiProperty({ format: 'uuid' }) sellerId!: string;
  @ApiProperty({ nullable: true, type: String }) storeName!: string | null;
  @ApiProperty({ enum: PAYOUT_STATES }) state!: string;
  @ApiProperty({ type: MoneyBody, description: 'The seller orders taken.' }) gross!: MoneyBody;
  @ApiProperty({ type: MoneyBody, description: 'Kept against what the seller owes.' })
  netted!: MoneyBody;
  @ApiProperty({ type: MoneyBody, description: 'What is transferred: gross less netted.' })
  transfer!: MoneyBody;
  @ApiProperty({ enum: ['AUTO', 'MANUAL'] }) approvalMode!: string;
  @ApiProperty({ enum: ['first-payout', 'terms'], nullable: true, type: String })
  approvalReason!: string | null;
  @ApiProperty({ format: 'date-time' }) slotAt!: string;
  @ApiProperty({ nullable: true, type: String }) outcomeCode!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) stateChangedAt!: string;
}

class PayoutListRowBody extends PayoutRowBody {
  @ApiProperty({
    nullable: true,
    type: String,
    format: 'uuid',
    description: "The seller's active admin hold over the whole seller (Release), or null.",
  })
  activeHoldId!: string | null;
  @ApiProperty({
    enum: PAYOUT_ROW_ACTIONS,
    isArray: true,
    description: 'The row Actions menu: what the caller may run on this payout now.',
  })
  actions!: string[];
}

class PayoutViewCountsBody {
  @ApiProperty() all!: number;
  @ApiProperty({ name: 'awaiting-approval' }) 'awaiting-approval'!: number;
  @ApiProperty() sending!: number;
  @ApiProperty() paid!: number;
  @ApiProperty() failed!: number;
  @ApiProperty({ name: 'not-sent' }) 'not-sent'!: number;
}

export class PayoutListBody {
  @ApiProperty({ type: [PayoutListRowBody], description: 'In the sort asked for.' })
  payouts!: PayoutListRowBody[];
  @ApiProperty({
    type: PayoutViewCountsBody,
    description: `The Market's payouts per view (${PAYOUT_LIST_VIEWS.join(', ')}), whatever the filter.`,
  })
  counts!: PayoutViewCountsBody;
  @ApiProperty({
    nullable: true,
    type: Number,
    description: 'Page numbers only; null in Previous/Next.',
  })
  total!: number | null;
  @ApiProperty({ nullable: true, type: Number, description: 'Page numbers only.' })
  page!: number | null;
  @ApiProperty() pageSize!: number;
  @ApiProperty({ nullable: true, type: String, description: 'Pass back as `cursor`.' })
  nextCursor!: string | null;
  @ApiProperty({ description: 'The store search matched too many stores: narrow it.' })
  searchCapped!: boolean;
}

class PayoutItemBody {
  @ApiProperty({ format: 'uuid' }) sellerOrderId!: string;
  @ApiProperty({ type: MoneyBody }) amount!: MoneyBody;
}

class PayoutApprovalBody {
  @ApiProperty({ format: 'uuid' }) approvedBy!: string;
  @ApiProperty({ format: 'date-time' }) approvedAt!: string;
  @ApiProperty({ type: MoneyBody, description: 'The amount the admin saw and echoed.' })
  approvedTransfer!: MoneyBody;
}

class PayoutLimitsBody {
  @ApiProperty({ type: MoneyBody, description: 'The most one transfer may be (Market config).' })
  perTransfer!: MoneyBody;
  @ApiProperty({ type: MoneyBody, description: "What went to payments today in the Market's day." })
  todayTotal!: MoneyBody;
  @ApiProperty({ type: MoneyBody, description: 'Above this daily total the platform alerts.' })
  dailyAlertLevel!: MoneyBody;
  @ApiProperty({ description: "Today's total with this transfer would be above the alert level." })
  overDailyAlertLevel!: boolean;
  @ApiProperty({
    description: 'This transfer is above the per-transfer limit: payments refuses it.',
  })
  transferAboveLimit!: boolean;
}

export class PayoutDetailBody extends PayoutRowBody {
  @ApiProperty({ type: PayoutApprovalBody, nullable: true }) approval!: PayoutApprovalBody | null;
  @ApiProperty({ type: [PayoutItemBody] }) items!: PayoutItemBody[];
  @ApiProperty({
    enum: ['ready', 'not-ready', 'unknown'],
    description: "From the seller's last payout evaluation.",
  })
  accountReadiness!: string;
  @ApiProperty({
    format: 'date-time',
    nullable: true,
    type: String,
    description: 'Always null until payments gives the instant of the last bank change.',
  })
  lastBankChangeAt!: string | null;
  @ApiProperty({ type: PayoutLimitsBody, nullable: true }) limits!: PayoutLimitsBody | null;
}

export class ApprovePayoutRequest {
  @ApiProperty({
    description: 'The transfer amount the admin saw, in minor units as a string. Must equal it.',
    example: '12500',
  })
  amountMinor!: string;
}

export class ApprovedPayoutBody {
  @ApiProperty({ format: 'uuid' }) payoutId!: string;
  @ApiProperty({ enum: ['approved'] }) state!: string;
  @ApiProperty({ type: MoneyBody }) transfer!: MoneyBody;
  @ApiProperty({ format: 'uuid' }) approvedBy!: string;
  @ApiProperty({ format: 'date-time' }) approvedAt!: string;
}

const rowBody = (row: PayoutRowView): PayoutRowBody => ({
  payoutId: row.payoutId,
  sellerId: row.sellerId,
  storeName: row.storeName,
  state: row.state,
  gross: money(row.gross),
  netted: money(row.netted),
  transfer: money(row.transfer),
  approvalMode: row.approvalMode,
  approvalReason: row.approvalReason,
  slotAt: instant(row.slotAt),
  outcomeCode: row.outcomeCode,
  createdAt: instant(row.createdAt),
  stateChangedAt: instant(row.stateChangedAt),
});

const listRowBody = (row: AdminPayoutRow): PayoutListRowBody => ({
  ...rowBody(row),
  activeHoldId: row.activeHoldId,
  actions: [...row.actions],
});

export const payoutListBody = (view: AdminPayoutListPage): PayoutListBody => ({
  payouts: view.payouts.map(listRowBody),
  counts: { ...view.counts },
  total: view.total,
  page: view.page,
  pageSize: view.pageSize,
  nextCursor: view.nextCursor,
  searchCapped: view.searchCapped,
});

export const payoutDetailBody = (view: PayoutDetailView): PayoutDetailBody => ({
  ...rowBody(view),
  approval:
    view.approval === null
      ? null
      : {
          approvedBy: view.approval.approvedBy,
          approvedAt: instant(view.approval.approvedAt),
          approvedTransfer: money(view.approval.approvedTransfer),
        },
  items: view.items.map((item) => ({
    sellerOrderId: item.sellerOrderId,
    amount: money(item.amount),
  })),
  accountReadiness: view.accountReadiness,
  lastBankChangeAt: view.lastBankChangeAt === null ? null : instant(view.lastBankChangeAt),
  limits:
    view.limits === null
      ? null
      : {
          perTransfer: money(view.limits.perTransfer),
          todayTotal: money(view.limits.todayTotal),
          dailyAlertLevel: money(view.limits.dailyAlertLevel),
          overDailyAlertLevel: view.limits.overDailyAlertLevel,
          transferAboveLimit: view.limits.transferAboveLimit,
        },
});

export const approvedPayoutBody = (view: ApprovedPayoutView): ApprovedPayoutBody => ({
  payoutId: view.payoutId,
  state: view.state,
  transfer: money(view.transfer),
  approvedBy: view.approvedBy,
  approvedAt: instant(view.approvedAt),
});

// ---------------------------------------------------------------------------------------------
// Seller

export class NextPayoutBody {
  @ApiProperty({
    format: 'date-time',
    nullable: true,
    type: String,
    description: 'When the next payout is looked at; null while the seller has no operating zone.',
  })
  slotAt!: string | null;
  @ApiProperty({ nullable: true, type: String, description: "The seller's IANA zone." })
  zone!: string | null;
  @ApiProperty({
    type: MoneyBody,
    nullable: true,
    description: 'An estimate of what would be transferred; null when nothing would.',
  })
  estimatedAmount!: MoneyBody | null;
  @ApiProperty({ enum: BLOCK_REASONS, nullable: true, type: String })
  blockReason!: string | null;
}

class OwnPayoutBody {
  @ApiProperty({ format: 'uuid' }) payoutId!: string;
  @ApiProperty({
    enum: ['scheduled', 'awaiting-approval', 'on-its-way', 'paid', 'not-sent', 'failed', 'settled'],
  })
  status!: string;
  @ApiProperty({ type: MoneyBody }) gross!: MoneyBody;
  @ApiProperty({ type: MoneyBody, description: 'Kept against what the seller owed.' })
  netted!: MoneyBody;
  @ApiProperty({ type: MoneyBody }) transfer!: MoneyBody;
  @ApiProperty({ format: 'date-time' }) slotAt!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
  @ApiProperty({ enum: BLOCK_REASONS, nullable: true, type: String }) reason!: string | null;
}

export class OwnPayoutsBody {
  @ApiProperty({ type: [OwnPayoutBody], description: 'Newest first; voided payouts are hidden.' })
  payouts!: OwnPayoutBody[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
}

class OwnHeldBody {
  @ApiProperty({ format: 'uuid', nullable: true, type: String }) sellerOrderId!: string | null;
  @ApiProperty({ type: MoneyBody, nullable: true }) amount!: MoneyBody | null;
  @ApiProperty({
    enum: ['on-hold', 'refund-pending', 'holding-period', 'awaiting-delivery'],
    description: 'A hold is shown only as on-hold (contact support) or refund-pending.',
  })
  reason!: string;
  @ApiProperty({ format: 'date-time', nullable: true, type: String })
  availableFrom!: string | null;
}

export class OwnPayoutHoldsBody {
  @ApiProperty({ type: [OwnHeldBody] }) holds!: OwnHeldBody[];
}

export const nextPayoutBody = (view: NextPayoutView): NextPayoutBody => ({
  slotAt: view.slotAt === null ? null : instant(view.slotAt),
  zone: view.zone,
  estimatedAmount: view.estimatedAmount === null ? null : money(view.estimatedAmount),
  blockReason: view.blockReason,
});

const ownPayoutBody = (view: OwnPayoutView): OwnPayoutBody => ({
  payoutId: view.payoutId,
  status: view.status,
  gross: money(view.gross),
  netted: money(view.netted),
  transfer: money(view.transfer),
  slotAt: instant(view.slotAt),
  createdAt: instant(view.createdAt),
  updatedAt: instant(view.updatedAt),
  reason: view.reason,
});

export const ownPayoutsBody = (view: OwnPayoutsView): OwnPayoutsBody => ({
  payouts: view.payouts.map(ownPayoutBody),
  nextCursor: view.nextCursor,
});

class OwnPayoutRowBody extends OwnPayoutBody {
  @ApiProperty({
    enum: OWN_PAYOUT_ROW_ACTIONS,
    isArray: true,
    description: 'The row Actions menu: open shows the payout.',
  })
  actions!: string[];
}

class OwnPayoutCountsBody {
  @ApiProperty() all!: number;
  @ApiProperty() scheduled!: number;
  @ApiProperty({ name: 'awaiting-approval' }) 'awaiting-approval'!: number;
  @ApiProperty({ name: 'on-its-way' }) 'on-its-way'!: number;
  @ApiProperty() paid!: number;
  @ApiProperty({ name: 'not-sent' }) 'not-sent'!: number;
  @ApiProperty() failed!: number;
  @ApiProperty() settled!: number;
}

export class OwnPayoutListBody {
  @ApiProperty({ type: [OwnPayoutRowBody], description: 'In the order of the sort.' })
  payouts!: OwnPayoutRowBody[];
  @ApiProperty({ type: OwnPayoutCountsBody, description: "The seller's payouts per status." })
  counts!: OwnPayoutCountsBody;
  @ApiProperty({
    nullable: true,
    type: Number,
    description: 'Page numbers only; null with Previous/Next.',
  })
  total!: number | null;
  @ApiProperty({ nullable: true, type: Number }) page!: number | null;
  @ApiProperty() pageSize!: number;
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
}

export const ownPayoutListBody = (view: OwnPayoutListPage): OwnPayoutListBody => ({
  payouts: view.payouts.map((row) => ({ ...ownPayoutBody(row), actions: [...row.actions] })),
  counts: { ...view.counts },
  total: view.total,
  page: view.page,
  pageSize: view.pageSize,
  nextCursor: view.nextCursor,
});

export const ownPayoutHoldsBody = (views: readonly OwnHeldView[]): OwnPayoutHoldsBody => ({
  holds: views.map((view) => ({
    sellerOrderId: view.sellerOrderId,
    amount: view.amount === null ? null : money(view.amount),
    reason: view.reason,
    availableFrom: view.availableFrom === null ? null : instant(view.availableFrom),
  })),
});
