import { ApiProperty } from '@nestjs/swagger';
import { MAX_ACCESS_REASON_LENGTH } from '../domain/access-decision';
import { AdminTeamActionHint } from './admin-team.dto';

// Bodies and answers of the admin seller routes (identity design 3.3, 3.4, 8.6; `ux.md` F9, D3
// to D6; slice 9). Command answers hold ids and codes only: never a reason, an address or a name.
// The seller list (slice 9b) answers owners' and invitees' names and addresses to the entitled
// admin only, and never a reason.

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

/** The Seller Owner as a row of the seller list shows it (slice 9b). Personal data. */
export class AdminSellerListOwnerView {
  @ApiProperty({ format: 'uuid' })
  accountId!: string;

  @ApiProperty({ description: "The owner's sign-in address, as typed." })
  email!: string;

  @ApiProperty({ type: String, nullable: true })
  displayName!: string | null;
}

export class AdminSellerListSellerActions {
  @ApiProperty({ type: AdminTeamActionHint })
  approve!: AdminTeamActionHint;

  @ApiProperty({ type: AdminTeamActionHint })
  reject!: AdminTeamActionHint;

  @ApiProperty({ type: AdminTeamActionHint })
  suspend!: AdminTeamActionHint;

  @ApiProperty({ type: AdminTeamActionHint, description: 'Lift suspension.' })
  reinstate!: AdminTeamActionHint;
}

export class AdminSellerListInvitationActions {
  @ApiProperty({ type: AdminTeamActionHint })
  resend!: AdminTeamActionHint;

  @ApiProperty({ type: AdminTeamActionHint, description: 'Cancel the invitation.' })
  revoke!: AdminTeamActionHint;
}

/** A seller whose owner confirmed the email (identity design 8.6 row 8). */
export class AdminSellerListSellerRowView {
  @ApiProperty({ enum: ['seller'] })
  type!: 'seller';

  @ApiProperty({ format: 'uuid' })
  sellerId!: string;

  @ApiProperty({ enum: ['self', 'invitation'], description: 'Signed up, or added by an admin.' })
  origin!: 'self' | 'invitation';

  @ApiProperty({ enum: ['pending', 'approved', 'rejected', 'suspended'] })
  state!: string;

  @ApiProperty({ format: 'date-time', description: 'Since: the last change of state.' })
  stateChangedAt!: string;

  @ApiProperty({
    type: Boolean,
    nullable: true,
    description:
      'Rejected with no re-application left: show "Not approved" rather than "Changes needed". ' +
      'Null while the Market configures no re-apply limit.',
  })
  reapplyLimitReached!: boolean | null;

  @ApiProperty({ type: AdminSellerListOwnerView })
  owner!: AdminSellerListOwnerView;

  @ApiProperty({ type: AdminSellerListSellerActions })
  actions!: AdminSellerListSellerActions;
}

/** An open seller-owner invitation ("Invited"; identity design 8.6 row 8). */
export class AdminSellerListInvitationRowView {
  @ApiProperty({ enum: ['invitation'] })
  type!: 'invitation';

  @ApiProperty({ format: 'uuid' })
  invitationId!: string;

  @ApiProperty({ format: 'uuid', description: 'The seller the invitation is for.' })
  sellerId!: string;

  @ApiProperty({ description: 'The invited address.' })
  email!: string;

  @ApiProperty({ type: String, nullable: true, description: 'The name given when adding.' })
  displayName!: string | null;

  @ApiProperty({
    enum: ['pending', 'expired'],
    description: 'expired: past the expiry of its last mail (it may still be re-sent).',
  })
  status!: 'pending' | 'expired';

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Null until its mail is sent, and right after a re-send.',
  })
  expiresAt!: string | null;

  @ApiProperty({ type: AdminSellerListInvitationActions })
  actions!: AdminSellerListInvitationActions;
}

export class AdminSellerListPageView {
  @ApiProperty({
    description:
      'Sellers whose owner confirmed the email and open seller invitations of the Market, ' +
      'merged by id (creation order); `type` tells them apart.',
    type: 'array',
    items: {
      oneOf: [
        { $ref: '#/components/schemas/AdminSellerListSellerRowView' },
        { $ref: '#/components/schemas/AdminSellerListInvitationRowView' },
      ],
    },
  })
  items!: (AdminSellerListSellerRowView | AdminSellerListInvitationRowView)[];

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Pass as `after` for the next page; null on the last page.',
  })
  next!: string | null;
}
