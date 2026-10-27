import { ApiProperty } from '@nestjs/swagger';
import type { AdminCreditView } from '../application/use-cases/issue-admin-credit.use-case';
import type { CreditListView } from '../application/use-cases/list-admin-credit-requests.use-case';
import type { CustomerWalletSummary } from '../application/use-cases/view-customer-wallet.use-case';
import {
  ADMIN_CREDIT_REASONS,
  ADMIN_CREDIT_REJECT_REASONS,
  ADMIN_CREDIT_STATUSES,
  APPROVAL_REASONS,
  MAX_NOTE_LENGTH,
} from '../domain/admin-credit';
import { WALLET_STATUSES } from '../domain/wallet-status';

// Bodies of the admin credit routes (package 2a). Amounts are minor-unit strings; ids and codes.

export class IssueCreditRequest {
  @ApiProperty({ format: 'uuid' }) customerAccountId!: string;
  @ApiProperty({ description: 'Minor units of the Market currency, digits only.', example: '2500' })
  amount!: string;
  @ApiProperty({ description: 'ISO 4217; must be the Market currency.' }) currency!: string;
  @ApiProperty({ enum: [...ADMIN_CREDIT_REASONS] }) reasonCode!: string;
  @ApiProperty({
    required: false,
    maxLength: MAX_NOTE_LENGTH,
    description: 'Free text for the admins only; stored, shown in the admin list, sent nowhere.',
  })
  note?: string;
  @ApiProperty({ description: '8 to 128 of A-Z a-z 0-9 . _ : -; one per issue.' })
  idempotencyKey!: string;
}

export class RejectCreditRequest {
  @ApiProperty({ enum: [...ADMIN_CREDIT_REJECT_REASONS] }) reasonCode!: string;
}

export class AdminCreditBody {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) customerAccountId!: string;
  @ApiProperty({ description: 'Minor units.' }) amount!: string;
  @ApiProperty() currency!: string;
  @ApiProperty({ enum: [...ADMIN_CREDIT_REASONS] }) reasonCode!: string;
  @ApiProperty({ nullable: true, type: String }) note!: string | null;
  @ApiProperty({ enum: [...ADMIN_CREDIT_STATUSES] }) status!: string;
  @ApiProperty({ enum: [...APPROVAL_REASONS], nullable: true, type: String })
  approvalReason!: string | null;
  @ApiProperty({ format: 'uuid' }) requestedBy!: string;
  @ApiProperty({ format: 'date-time' }) requestedAt!: string;
  @ApiProperty({ format: 'date-time', nullable: true, type: String }) expiresAt!: string | null;
  @ApiProperty({ format: 'uuid', nullable: true, type: String }) decidedBy!: string | null;
  @ApiProperty({ format: 'date-time', nullable: true, type: String }) decidedAt!: string | null;
  @ApiProperty({ enum: [...ADMIN_CREDIT_REJECT_REASONS], nullable: true, type: String })
  decisionReason!: string | null;
  @ApiProperty({ format: 'uuid', nullable: true, type: String }) journalId!: string | null;
}

export class CreditListBody {
  @ApiProperty({ type: [AdminCreditBody], description: 'Newest first.' })
  entries!: AdminCreditBody[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
}

export class CustomerWalletBody {
  @ApiProperty({ format: 'uuid' }) customerAccountId!: string;
  @ApiProperty() currency!: string;
  @ApiProperty({ enum: [...WALLET_STATUSES] }) marketStatus!: string;
  @ApiProperty({ enum: ['active', 'frozen', 'closed', 'none'] }) accountStatus!: string;
  @ApiProperty({ description: 'Minor units.' }) available!: string;
  @ApiProperty({ description: 'Minor units.' }) held!: string;
  @ApiProperty({ description: 'Minor units.' }) balanceCap!: string;
  @ApiProperty({ description: 'Minor units that may still be granted before the cap.' })
  roomUnderCap!: string;
  @ApiProperty({ description: 'Minor units; above it an issue needs a second admin.' })
  issueCap!: string;
  @ApiProperty({ description: 'Minor units per admin per day in the Market time zone.' })
  dailyCap!: string;
  @ApiProperty({
    description: 'Minor units the calling admin counted today (granted, pending, approved).',
  })
  usedToday!: string;
}

const instant = (value: { toString(): string } | null): string | null =>
  value === null ? null : value.toString();

export const adminCreditBody = (view: AdminCreditView): AdminCreditBody => ({
  id: view.id,
  customerAccountId: view.customerAccountId,
  amount: view.amount.toString(),
  currency: view.currency,
  reasonCode: view.reasonCode,
  note: view.note,
  status: view.status,
  approvalReason: view.approvalReason,
  requestedBy: view.requestedBy,
  requestedAt: view.requestedAt.toString(),
  expiresAt: instant(view.expiresAt),
  decidedBy: view.decidedBy,
  decidedAt: instant(view.decidedAt),
  decisionReason: view.decisionReason,
  journalId: view.journalId,
});

export const creditListBody = (view: CreditListView): CreditListBody => ({
  entries: view.entries.map(adminCreditBody),
  nextCursor: view.nextCursor,
});

export const customerWalletBody = (view: CustomerWalletSummary): CustomerWalletBody => ({
  customerAccountId: view.customerAccountId,
  currency: view.currency,
  marketStatus: view.marketStatus,
  accountStatus: view.accountStatus,
  available: view.available.toString(),
  held: view.held.toString(),
  balanceCap: view.balanceCap.toString(),
  roomUnderCap: view.roomUnderCap.toString(),
  issueCap: view.issueCap.toString(),
  dailyCap: view.dailyCap.toString(),
  usedToday: view.usedToday.toString(),
});
