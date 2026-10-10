import { ApiProperty } from '@nestjs/swagger';
import { OBSERVED_REGISTER_OUTCOMES } from '../domain/review-check';

export class ApproveRequest {
  @ApiProperty({
    format: 'uuid',
    description: 'Revision N: the pending revision the reviewer read.',
  })
  revisionId!: string;
}

export class RejectRequest {
  @ApiProperty({
    format: 'uuid',
    description: 'Revision N: the pending revision the reviewer read.',
  })
  revisionId!: string;

  @ApiProperty({
    maxLength: 2000,
    description:
      'Shown to the Seller Owner in the result mail. Personal data: stored only encrypted by ' +
      'identity, never logged.',
  })
  reason!: string;
}

export class ReviewDecidedBody {
  @ApiProperty({
    enum: ['approved', 'rejected', 'in-progress'],
    description:
      'in-progress (HTTP 202): the decision was asked of identity but not confirmed in time; it ' +
      'is finished within minutes. Read the review again.',
  })
  decision!: 'approved' | 'rejected' | 'in-progress';

  @ApiProperty({ format: 'uuid' })
  revisionId!: string;
}

export class ManualCheckRequest {
  @ApiProperty({ format: 'uuid', description: 'Revision N: the pending revision.' })
  revisionId!: string;

  @ApiProperty({
    enum: OBSERVED_REGISTER_OUTCOMES,
    description: 'What the reviewer read in the official register by hand.',
  })
  observedOutcome!: string;
}

export class ManualCheckRecordedBody {
  @ApiProperty({ format: 'uuid' })
  revisionId!: string;

  @ApiProperty({ enum: OBSERVED_REGISTER_OUTCOMES })
  observedOutcome!: string;
}
