import { ApiProperty } from '@nestjs/swagger';
import { OFFER_CHANGE_REASONS } from '../domain/events';
import { REVIEW_CHECK_CODES } from '../domain/review-check-codes';

// Bodies and answers of the admin product revision review routes (catalog design 4.2, 8.2, 8.3a).
// Ids and codes only.

export class ProductRevisionApproveRequest {
  @ApiProperty({
    minimum: 1,
    description: 'The product version the reviewer saw (a row of the review queue).',
  })
  version!: number;

  @ApiProperty({
    enum: REVIEW_CHECK_CODES,
    isArray: true,
    description:
      'The named checks the reviewer ticked. Every check the row lists in `requiredChecks` must be here.',
  })
  checksConfirmed!: string[];
}

export class ProductRevisionRequestChangesRequest {
  @ApiProperty({
    minimum: 1,
    description: 'The product version the reviewer saw (a row of the review queue).',
  })
  version!: number;

  @ApiProperty({
    enum: OFFER_CHANGE_REASONS,
    description: 'Why the seller must change the product.',
  })
  reasonCode!: string;
}

export class ProductRevisionDecided {}
