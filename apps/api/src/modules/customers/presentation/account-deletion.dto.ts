import { ApiProperty } from '@nestjs/swagger';
import { BOUNDS } from '../domain/account-deletion-settings';

// Bodies of the account deletion routes.

export class AccountDeletionSettingsFields {
  @ApiProperty({ description: 'Whether a buyer may start a deletion request. Default false.' })
  enabled!: boolean;
  @ApiProperty({
    minimum: BOUNDS.waitingPeriodDays.min,
    maximum: BOUNDS.waitingPeriodDays.max,
    description: 'Days a request waits before it is carried out. Default 30.',
  })
  waitingPeriodDays!: number;
}

export class AccountDeletionSettingsBody {
  @ApiProperty({
    description: '0 while the built-in defaults are in force, then 1, 2, ... per change.',
  })
  version!: number;
  @ApiProperty({ type: AccountDeletionSettingsFields })
  settings!: AccountDeletionSettingsFields;
}

export class SetAccountDeletionSettingsRequest {
  @ApiProperty({ description: 'The version the caller last read (0 for the defaults).' })
  expectedVersion!: number;
  @ApiProperty({
    type: AccountDeletionSettingsFields,
    description: 'Every field, replacing the current ones.',
  })
  settings!: AccountDeletionSettingsFields;
  @ApiProperty({
    maxLength: BOUNDS.reasonLength,
    description:
      'Why the change is made: 1 to 500 characters of one line of plain text (no control ' +
      'characters, < or >). Kept in the change history only.',
  })
  reason!: string;
}

export class AccountDeletionAvailabilityBody {
  @ApiProperty({ description: 'False when the Market has switched account deletion off.' })
  canDeleteAccount!: boolean;
  @ApiProperty({ description: 'Days a deletion request waits before it is carried out.' })
  waitingPeriodDays!: number;
}
