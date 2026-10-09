import { ApiProperty } from '@nestjs/swagger';
import { MAX_ACCESS_REASON_LENGTH } from '../domain/access-decision';

// Bodies and answers of the admin seller routes (identity design 3.3, 3.4, 8.6; `ux.md` F9, D3
// to D6; slice 9). Answers hold ids and codes only: never a reason, an address or a name.

/** Reject or suspend: the reason, required (decision 9; `ux.md` D4, D5). */
export class AdminSellerReasonRequest {
  @ApiProperty({
    description:
      'Written for the Seller Owner, who reads it in the mail and on the status page. 1 to ' +
      `${MAX_ACCESS_REASON_LENGTH} characters after trimming; line breaks are kept; no control ` +
      'or bidirectional formatting character. Stored only encrypted; never logged or echoed.',
    maxLength: MAX_ACCESS_REASON_LENGTH,
  })
  reason!: string;
}

/** Add a seller: the owner's address and name (`ux.md` D6; SEL-06). */
export class AdminSellerInviteRequest {
  @ApiProperty({
    description: "The Seller Owner's sign-in address. Never logged, echoed or audited.",
    maxLength: 254,
  })
  email!: string;

  @ApiProperty({
    description:
      "The Seller Owner's name, kept at acceptance. The display-name rules: no control, " +
      'bidirectional or URL-like text.',
  })
  displayName!: string;
}

export class AdminSellerAccessDecided {
  @ApiProperty({
    enum: [
      'seller-access.approved',
      'seller-access.rejected',
      'seller-access.suspended',
      'seller-access.reinstated',
    ],
    description:
      'The decision is recorded; the Seller Owner is mailed shortly. A rejection or a ' +
      "suspension ended every session of the seller's accounts.",
  })
  code!: string;

  @ApiProperty({ format: 'uuid' })
  sellerId!: string;

  @ApiProperty({ enum: ['pending', 'approved', 'rejected', 'suspended'] })
  state!: string;

  @ApiProperty({ format: 'uuid', description: 'The recorded decision.' })
  decisionId!: string;
}

export class AdminSellerInvitationIssued {
  @ApiProperty({
    enum: ['invitation.issued'],
    description: 'The seller and its owner invitation exist; the mail follows shortly.',
  })
  code!: 'invitation.issued';

  @ApiProperty({ format: 'uuid' })
  invitationId!: string;

  @ApiProperty({ format: 'uuid', description: 'The seller the invitation is for.' })
  sellerId!: string;
}
