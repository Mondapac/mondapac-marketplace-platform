import { ApiProperty } from '@nestjs/swagger';
import { REGISTER_CHECKERS, REGISTER_MISMATCHES } from '../domain/register-check';

const STATES = ['not-performed', 'active', 'negative', 'unavailable', 'stale'] as const;

/** The register state of a file's current number, for a reviewer (sellers design 3.4, ux 3.2a). */
export class ReviewRegisterCheckBody {
  @ApiProperty({
    enum: ['configured', 'none'],
    description: '"none": the Market has no register lookup; the reviewer records a manual check.',
  })
  lookup!: 'configured' | 'none';

  @ApiProperty({ description: "Whether the file holds a business number of the Market's scheme." })
  identifierSaved!: boolean;

  @ApiProperty({
    enum: STATES,
    description:
      'not-performed (also: no number, or no register in the Market), active, negative (not ' +
      'found or cancelled, sticky), unavailable, stale (an active result older than the maximum age).',
  })
  state!: (typeof STATES)[number];

  @ApiProperty({
    type: [String],
    enum: REGISTER_MISMATCHES,
    description: 'Values that differed from the draft; only on an active result. Flags only.',
  })
  mismatches!: readonly string[];

  @ApiProperty({ type: String, nullable: true, description: 'ISO instant of the latest answer.' })
  checkedAt!: string | null;

  @ApiProperty({ type: String, enum: REGISTER_CHECKERS, nullable: true })
  checkedBy!: string | null;

  @ApiProperty({ description: 'A definite negative closes the submission.' })
  blocksSubmit!: boolean;

  @ApiProperty({
    description:
      'Approval is blocked on this state until a successful lookup or a recorded manual check.',
  })
  blocksApproval!: boolean;
}
