import { OBSERVED_REGISTER_OUTCOMES } from '../domain/review-check';
import { ApiProperty } from '@nestjs/swagger';
import { REVISION_STATUSES, type RevisionStatus } from '../domain/business-file-revision';
import { REGISTER_MISMATCHES } from '../domain/register-check';
import { REVISION_KINDS } from '../domain/revision-kinds';

const REGISTER_STATES = ['not-performed', 'active', 'negative', 'unavailable', 'stale'] as const;
const SNAPSHOT_OUTCOMES = [
  'not-performed',
  'active',
  'not-found',
  'cancelled',
  'unavailable',
] as const;

/** What a submission recorded of the register (never a register value). */
export class ReviewRegisterAtSubmissionBody {
  @ApiProperty({ enum: SNAPSHOT_OUTCOMES })
  outcome!: (typeof SNAPSHOT_OUTCOMES)[number];

  @ApiProperty({ type: [String], enum: REGISTER_MISMATCHES })
  mismatches!: readonly string[];

  @ApiProperty({ type: String, nullable: true })
  checkedAt!: string | null;
}

export class ReviewIdentifierBody {
  @ApiProperty({ description: "The scheme code of the Market's business number." })
  scheme!: string;

  @ApiProperty({ description: 'The normalised number.' })
  value!: string;

  @ApiProperty({ description: 'The number formatted for display.' })
  display!: string;
}

/** The business details of one revision, in clear. Personal data: the answer is no-store. */
export class ReviewContentBody {
  @ApiProperty() storeName!: string;
  @ApiProperty() businessName!: string;
  @ApiProperty() phone!: string;
  @ApiProperty({ type: String, nullable: true }) contactEmail!: string | null;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    description: "The operating address, with the fields of the Market's address format.",
  })
  address!: Readonly<Record<string, string>>;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    nullable: true,
    description: 'The registered address when it differs from the operating address.',
  })
  registeredAddress!: Readonly<Record<string, string>> | null;

  @ApiProperty({ type: ReviewIdentifierBody, nullable: true })
  identifier!: ReviewIdentifierBody | null;

  @ApiProperty({ type: Boolean, nullable: true })
  registeredForIndirectTax!: boolean | null;
}

export class ReviewRevisionBody {
  @ApiProperty({ description: 'The revision id (UUID).' }) id!: string;
  @ApiProperty({ enum: REVISION_KINDS }) kind!: string;
  @ApiProperty() revisionNo!: number;
  @ApiProperty({ enum: REVISION_STATUSES }) status!: RevisionStatus;
  @ApiProperty({ description: 'ISO instant of the submission.' }) createdAt!: string;
  @ApiProperty() serviceAreaCode!: string;
  @ApiProperty({ description: 'IANA zone the seller chose.' }) operatingTimezone!: string;
  @ApiProperty({ type: ReviewRegisterAtSubmissionBody })
  registerAtSubmission!: ReviewRegisterAtSubmissionBody;
  @ApiProperty({ type: ReviewContentBody }) content!: ReviewContentBody;
}

export class ReviewManualCheckBody {
  @ApiProperty({ enum: OBSERVED_REGISTER_OUTCOMES }) observedOutcome!: string;
  @ApiProperty({ description: 'ISO instant.' }) recordedAt!: string;
}

export class ReviewRegisterBody {
  @ApiProperty({ enum: ['configured', 'none'] }) lookup!: 'configured' | 'none';
  @ApiProperty({ enum: REGISTER_STATES }) state!: (typeof REGISTER_STATES)[number];
  @ApiProperty({ type: [String], enum: REGISTER_MISMATCHES }) mismatches!: readonly string[];
  @ApiProperty({ type: String, enum: ['aged', 'draft-changed'], nullable: true })
  staleReason!: string | null;
  @ApiProperty({ type: String, nullable: true }) checkedAt!: string | null;
  @ApiProperty({
    description:
      'Whether approve would be refused by the register now: a definite negative, or no current ' +
      'active result and no manual check recorded (then record one).',
  })
  blocksApproval!: boolean;

  @ApiProperty({
    type: ReviewManualCheckBody,
    nullable: true,
    description: 'The manual register check recorded on the pending revision, or null.',
  })
  manualCheck!: ReviewManualCheckBody | null;
}

/** The review page of one seller (sellers design 6.2 `review.read`). */
export class ReviewReadBody {
  @ApiProperty({ description: 'The seller id (UUID).' }) sellerId!: string;

  @ApiProperty({
    enum: ['pending', 'approved', 'rejected', 'suspended'],
    description: 'The access state `identity` holds, read live.',
  })
  access!: string;

  @ApiProperty({
    type: ReviewRevisionBody,
    description: 'The revision under review: the pending one, else the latest.',
  })
  current!: ReviewRevisionBody;

  @ApiProperty({
    type: ReviewRevisionBody,
    nullable: true,
    description: 'The approved revision shown beside a pending identity change; else null.',
  })
  previous!: ReviewRevisionBody | null;

  @ApiProperty({ type: ReviewRegisterBody }) register!: ReviewRegisterBody;

  @ApiProperty({
    description:
      'A decision on the pending revision is in flight: approve, reject and the manual check ' +
      'answer file.decision-in-progress until it settles. Read again shortly.',
  })
  decisionInProgress!: boolean;
}
