import { ApiProperty } from '@nestjs/swagger';
import type { ShipToRetentionView } from '../application/use-cases/admin-view-ship-to-retention.use-case';
import {
  MAX_SHIP_TO_RETENTION_MONTHS,
  MIN_SHIP_TO_RETENTION_MONTHS,
} from '../domain/ship-to-retention';

// Body and answer of the admin routes for the ship-to retention setting (owner decision
// 2026-11-15). A switch, a number of months, a version and an instant only.

export const SHIP_TO_RETENTION_BODY_KEYS = ['enabled', 'months', 'expectedVersion'] as const;

export class ShipToRetentionRequestBody {
  @ApiProperty({
    description:
      'Whether the daily job deletes the sealed delivery address of settled orders. ' +
      'Irreversible: a deleted address is gone from every view.',
  })
  enabled!: boolean;
  @ApiProperty({
    minimum: MIN_SHIP_TO_RETENTION_MONTHS,
    maximum: MAX_SHIP_TO_RETENTION_MONTHS,
    description:
      'Months after an order is settled (every seller order delivered, shipped, cancelled or ' +
      'refunded in full; the latest of those instants) before its ' +
      "address is deleted, counted in the Market's time zone.",
  })
  months!: number;
  @ApiProperty({ description: 'The version read; 0 when the setting was never set.' })
  expectedVersion!: number;
}

export class ShipToRetentionBody {
  @ApiProperty({ description: 'Off until an admin turns it on.' }) enabled!: boolean;
  @ApiProperty({ minimum: MIN_SHIP_TO_RETENTION_MONTHS, maximum: MAX_SHIP_TO_RETENTION_MONTHS })
  months!: number;
  @ApiProperty({ description: '0 while never set.' }) version!: number;
  @ApiProperty({ format: 'date-time', nullable: true, type: String })
  updatedAt!: string | null;
  @ApiProperty({ format: 'uuid', nullable: true, type: String })
  updatedBy!: string | null;
}

export const shipToRetentionBody = (view: ShipToRetentionView) => ({
  enabled: view.enabled,
  months: view.months,
  version: view.version,
  updatedAt: view.updatedAt,
  updatedBy: view.updatedBy,
});
