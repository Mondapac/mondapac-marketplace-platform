import { ApiProperty } from '@nestjs/swagger';
import { ACCOUNT_STATUSES } from '../domain/connected-account';

// Answers of the seller payout-account routes: a status, counts and a flag. No Stripe id, bank
// detail or requirement content ever leaves the module.

export class PayoutAccountBody {
  @ApiProperty({ enum: [...ACCOUNT_STATUSES, 'not-connected'] })
  status!: string;

  @ApiProperty({ description: 'Stripe can pay this seller (status enabled).' })
  ready!: boolean;

  @ApiProperty({ description: 'How many items Stripe still asks of the seller.' })
  requirementsDue!: number;

  @ApiProperty()
  requirementsPastDue!: boolean;
}

export class PayoutAccountLinkBody extends PayoutAccountBody {
  @ApiProperty({
    description:
      'The one-time hosted Stripe page: open it at once, do not store or log it. The answer is no-store.',
  })
  url!: string;
}
