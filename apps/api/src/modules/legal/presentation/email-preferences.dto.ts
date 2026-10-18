import { ApiProperty } from '@nestjs/swagger';
import type { EmailPreferencesView } from '../application/use-cases/view-email-preferences.use-case';

// Bodies of the email preferences routes.

export class EmailPreferencesRequest {
  @ApiProperty({
    description: 'true: the customer agrees to receive marketing email; false: withdraws it.',
  })
  marketing!: boolean;
  @ApiProperty({
    required: false,
    enum: ['sign-up', 'account'],
    default: 'account',
    description:
      'Where the choice was made: the unticked box of the sign-up page (sent right after sign-up) or the account page.',
  })
  source?: 'sign-up' | 'account';
}

export class EmailPreferencesBody {
  @ApiProperty({ description: 'Whether the customer agreed to receive marketing email.' })
  marketing!: boolean;
  @ApiProperty({
    format: 'date-time',
    nullable: true,
    type: String,
    description: 'When the choice last changed; null when the customer never chose.',
  })
  changedAt!: string | null;
}

export const emailPreferencesBody = (view: EmailPreferencesView): EmailPreferencesBody => ({
  marketing: view.marketing,
  changedAt: view.changedAt?.toString() ?? null,
});
