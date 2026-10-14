import { ApiProperty } from '@nestjs/swagger';
import type { Temporal } from '@mondapac/shared-kernel';
import type {
  ConnectedAccountPage,
  ConnectedAccountRow,
} from '../application/use-cases/admin-list-connected-accounts.use-case';
import type { ConnectedAccountDetail } from '../application/use-cases/admin-view-connected-account.use-case';
import type {
  PayoutAccountLink,
  PayoutAccountView,
  PayoutChangeView,
} from '../application/use-cases/view-payout-account.use-case';
import { ACCOUNT_STATUSES } from '../domain/connected-account';
import { CHANGE_KINDS } from '../domain/payout-change';

// Answers of the payout-account routes: a status, counts, flags and the kind and time of each
// bank change. No Stripe id, bank detail or requirement content ever leaves the module.

export class PayoutChangeBody {
  @ApiProperty({ description: 'ISO 8601 instant (UTC).' })
  detectedAt!: string;

  @ApiProperty({ enum: [...CHANGE_KINDS] })
  kind!: string;
}

export class PayoutAccountBody {
  @ApiProperty({ enum: [...ACCOUNT_STATUSES, 'not-connected'] })
  status!: string;

  @ApiProperty({
    description: 'Stripe can pay this seller (status enabled) and no waiting period is running.',
  })
  ready!: boolean;

  @ApiProperty({ description: 'How many items Stripe still asks of the seller.' })
  requirementsDue!: number;

  @ApiProperty()
  requirementsPastDue!: boolean;

  @ApiProperty({ description: 'The signed-in Seller Owner has two-step sign-in on.' })
  secondFactorActive!: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'ISO 8601 instant: the end of the waiting period after a bank change.',
  })
  coolingOffUntil!: string | null;

  @ApiProperty({ description: 'Stripe payouts are paused for the waiting period.' })
  payoutsPaused!: boolean;

  @ApiProperty({ type: [PayoutChangeBody], description: 'Newest first, at most 10.' })
  changes!: PayoutChangeBody[];
}

export class PayoutAccountLinkBody extends PayoutAccountBody {
  @ApiProperty({
    description:
      'The one-time hosted Stripe page: open it at once, do not store or log it. The answer is no-store.',
  })
  url!: string;
}

export class ConnectedAccountRowBody {
  @ApiProperty({ format: 'uuid' })
  sellerId!: string;

  @ApiProperty({ type: String, nullable: true, description: 'Null: no seller name source yet.' })
  sellerName!: string | null;

  @ApiProperty({ enum: [...ACCOUNT_STATUSES] })
  status!: string;

  @ApiProperty()
  ready!: boolean;

  @ApiProperty()
  requirementsDue!: number;

  @ApiProperty()
  requirementsPastDue!: boolean;

  @ApiProperty({ type: String, nullable: true })
  coolingOffUntil!: string | null;

  @ApiProperty()
  payoutsPaused!: boolean;

  @ApiProperty({ type: String, nullable: true })
  lastReadAt!: string | null;

  @ApiProperty()
  createdAt!: string;
}

export class ConnectedAccountDetailBody extends ConnectedAccountRowBody {
  @ApiProperty({ type: [PayoutChangeBody], description: 'Newest first, at most 10.' })
  changes!: PayoutChangeBody[];
}

export class ConnectedAccountPageBody {
  @ApiProperty({ type: [ConnectedAccountRowBody] })
  items!: ConnectedAccountRowBody[];

  @ApiProperty({ type: String, nullable: true })
  nextCursor!: string | null;
}

const text = (instant: Temporal.Instant): string => instant.toString();
const optionalText = (instant: Temporal.Instant | null): string | null =>
  instant === null ? null : text(instant);

const changeBody = (change: PayoutChangeView): PayoutChangeBody => ({
  detectedAt: text(change.detectedAt),
  kind: change.kind,
});

export const payoutAccountBody = (view: PayoutAccountView): PayoutAccountBody => ({
  status: view.status,
  ready: view.ready,
  requirementsDue: view.requirementsDue,
  requirementsPastDue: view.requirementsPastDue,
  secondFactorActive: view.secondFactorActive,
  coolingOffUntil: optionalText(view.coolingOffUntil),
  payoutsPaused: view.payoutsPaused,
  changes: view.changes.map(changeBody),
});

export const payoutAccountLinkBody = (link: PayoutAccountLink): PayoutAccountLinkBody => ({
  ...payoutAccountBody(link),
  url: link.url,
});

export const connectedAccountRowBody = (row: ConnectedAccountRow): ConnectedAccountRowBody => ({
  sellerId: row.sellerId,
  sellerName: row.sellerName,
  status: row.status,
  ready: row.ready,
  requirementsDue: row.requirementsDue,
  requirementsPastDue: row.requirementsPastDue,
  coolingOffUntil: optionalText(row.coolingOffUntil),
  payoutsPaused: row.payoutsPaused,
  lastReadAt: optionalText(row.lastReadAt),
  createdAt: text(row.createdAt),
});

export const connectedAccountDetailBody = (
  detail: ConnectedAccountDetail,
): ConnectedAccountDetailBody => ({
  ...connectedAccountRowBody(detail),
  changes: detail.changes.map(changeBody),
});

export const connectedAccountPageBody = (page: ConnectedAccountPage): ConnectedAccountPageBody => ({
  items: page.items.map(connectedAccountRowBody),
  nextCursor: page.nextCursor,
});

export class PayoutAccountCodeRequest {
  @ApiProperty({
    description: 'A current 6-digit code from the authenticator app, or a recovery code.',
  })
  code!: string;
}
