import { ApiProperty } from '@nestjs/swagger';
import type { HistoryView } from '../application/use-cases/view-my-history.use-case';
import type { MyWalletView } from '../application/use-cases/view-my-wallet.use-case';
import { lastChangedBody } from '../../../platform/audit/change-trail';
import { LastChangedDto } from '../../../platform/audit/change-trail.dto';
import type { SettingsPage } from '../application/use-cases/view-wallet-settings.use-case';
import { WALLET_STATUS_REASONS, WALLET_STATUSES } from '../domain/wallet-status';

// Bodies of the wallet routes. Amounts are minor-unit strings; ids and codes only.

class ExpiringBody {
  @ApiProperty({ format: 'date-time' }) expiresAt!: string;
  @ApiProperty({ description: 'Minor units.' }) amount!: string;
}

export class MyWalletBody {
  @ApiProperty({ description: 'ISO 4217, the Market currency.' }) currency!: string;
  @ApiProperty({ description: 'Minor units the customer can spend now.' }) available!: string;
  @ApiProperty({ description: 'Minor units set aside for orders in progress.' }) held!: string;
  @ApiProperty({ enum: [...WALLET_STATUSES] }) marketStatus!: string;
  @ApiProperty({ type: [ExpiringBody], description: 'Promo credit expiring soon, soonest first.' })
  expiringSoon!: ExpiringBody[];
}

class HistoryEntryBody {
  @ApiProperty({ format: 'uuid' }) journalId!: string;
  @ApiProperty({
    enum: ['grant-promo', 'grant-refund', 'hold', 'capture', 'release', 'expire', 'reverse'],
  })
  kind!: string;
  @ApiProperty({ description: 'Minor units, signed: credit positive, spend negative.' })
  amount!: string;
  @ApiProperty() reasonCode!: string;
  @ApiProperty({ format: 'uuid', nullable: true, type: String }) orderId!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

export class HistoryBody {
  @ApiProperty() currency!: string;
  @ApiProperty({ type: [HistoryEntryBody], description: 'Newest first.' })
  entries!: HistoryEntryBody[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
}

export class SettingsBody {
  @ApiProperty({ enum: [...WALLET_STATUSES] }) status!: string;
  @ApiProperty({ enum: [...WALLET_STATUS_REASONS], nullable: true, type: String })
  reason!: string | null;
  @ApiProperty({ format: 'date-time', nullable: true, type: String }) updatedAt!: string | null;
  @ApiProperty({
    type: Number,
    minimum: 0,
    description: '0 while never switched. Send it back as expectedVersion.',
  })
  version!: number;
  @ApiProperty({
    type: LastChangedDto,
    nullable: true,
    description: 'Who switched the wallet last and when; null while it was never switched.',
  })
  lastChanged!: LastChangedDto | null;
}

export class SetSettingsRequest {
  @ApiProperty({ enum: [...WALLET_STATUSES] }) status!: string;
  @ApiProperty({
    enum: [...WALLET_STATUS_REASONS],
    required: false,
    description: 'Required for paused and frozen; not allowed for off and active.',
  })
  reasonCode?: string;
  @ApiProperty({
    type: Number,
    minimum: 0,
    description:
      'The `version` the admin saw. A different current version answers 409 wallet.settings-conflict.',
  })
  expectedVersion!: number;
}

export const myWalletBody = (view: MyWalletView): MyWalletBody => ({
  currency: view.currency,
  available: view.available.toString(),
  held: view.held.toString(),
  marketStatus: view.marketStatus,
  expiringSoon: view.expiringSoon.map((lot) => ({
    expiresAt: lot.expiresAt.toString(),
    amount: lot.amount.toString(),
  })),
});

export const historyBody = (view: HistoryView): HistoryBody => ({
  currency: view.currency,
  entries: view.entries.map((entry) => ({
    journalId: entry.journalId,
    kind: entry.kind,
    amount: entry.amount.toString(),
    reasonCode: entry.reasonCode,
    orderId: entry.orderId,
    createdAt: entry.createdAt.toString(),
  })),
  nextCursor: view.nextCursor,
});

export const settingsBody = (view: SettingsPage): SettingsBody => ({
  status: view.status,
  reason: view.reason,
  updatedAt: view.updatedAt === null ? null : view.updatedAt.toString(),
  version: view.version,
  lastChanged: lastChangedBody(view.lastChanged),
});
