import { ApiProperty } from '@nestjs/swagger';
import { AdminTeamActionHint, AdminTeamRoleView } from './admin-team.dto';

// Bodies and answers of the seller team routes (identity design 3.4, 5.3 to 5.5, 8.6; `ux.md` B1,
// D1 to D3, F11; slice 11). Ids and codes only, except the team list, which carries the members'
// names and addresses to the actor entitled to them. Never a token, a hash or a credential.

const UUID = 'A UUID v7.';

/** Invite a Staff member with a role (3.4; `identity.team-member.invite`). */
export class SellerTeamInviteRequest {
  @ApiProperty({
    description: "The invitee's sign-in address. Never logged, echoed or audited.",
    maxLength: 254,
  })
  email!: string;

  @ApiProperty({
    description: `The role the invitee will hold: a ready-made role or a custom role of your shop. ${UUID}`,
    format: 'uuid',
  })
  roleId!: string;
}

/** Change a member's role (5.3 `identity.team-member.assign-role`). */
export class SellerTeamAssignRoleRequest {
  @ApiProperty({ description: `The role to assign. ${UUID}`, format: 'uuid' })
  roleId!: string;
}

/** A route that takes no fields: the body is `{}` (JSON only, 6.4). */
export class SellerTeamEmptyRequest {}

export class SellerTeamInvitationIssued {
  @ApiProperty({
    enum: ['invitation.issued'],
    description: 'The invitation exists; its mail is sent shortly, with a new token.',
  })
  code!: 'invitation.issued';

  @ApiProperty({ format: 'uuid' })
  invitationId!: string;
}

export class SellerTeamInvitationChanged {
  @ApiProperty({
    enum: ['invitation.reissued', 'invitation.revoked'],
    description: 'reissued: the earlier link stopped working and a new mail follows.',
  })
  code!: 'invitation.reissued' | 'invitation.revoked';

  @ApiProperty({ format: 'uuid' })
  invitationId!: string;
}

export class SellerTeamRoleAssigned {
  @ApiProperty({
    enum: ['role.assigned', 'role.unchanged'],
    description: 'role.unchanged: the member already held the role; nothing was written.',
  })
  code!: 'role.assigned' | 'role.unchanged';

  @ApiProperty({ format: 'uuid' })
  accountId!: string;

  @ApiProperty({ format: 'uuid' })
  roleId!: string;
}

export class SellerTeamMemberRemoved {
  @ApiProperty({
    enum: ['member.removed'],
    description:
      'The member left the team; every session of its account was revoked and its open ' +
      'sign-ins voided in the same request.',
  })
  code!: 'member.removed';

  @ApiProperty({ format: 'uuid' })
  accountId!: string;
}

export class SellerTeamMemberActions {
  @ApiProperty({
    type: AdminTeamActionHint,
    description: 'Change role, for the row: whether a given role is grantable is not a row hint.',
  })
  changeRole!: AdminTeamActionHint;

  @ApiProperty({ type: AdminTeamActionHint })
  remove!: AdminTeamActionHint;
}

export class SellerTeamInvitationActions {
  @ApiProperty({ type: AdminTeamActionHint })
  resend!: AdminTeamActionHint;

  @ApiProperty({ type: AdminTeamActionHint })
  revoke!: AdminTeamActionHint;
}

export class SellerTeamMemberRowView {
  @ApiProperty({ enum: ['account'] })
  type!: 'account';

  @ApiProperty({ format: 'uuid' })
  accountId!: string;

  @ApiProperty({ description: 'The sign-in address.' })
  email!: string;

  @ApiProperty({ type: String, nullable: true })
  displayName!: string | null;

  @ApiProperty({ description: "The actor's own row." })
  self!: boolean;

  @ApiProperty({ type: AdminTeamRoleView, nullable: true })
  role!: AdminTeamRoleView | null;

  @ApiProperty({ type: SellerTeamMemberActions })
  actions!: SellerTeamMemberActions;
}

export class SellerTeamInvitationRowView {
  @ApiProperty({ enum: ['invitation'] })
  type!: 'invitation';

  @ApiProperty({ format: 'uuid' })
  invitationId!: string;

  @ApiProperty({ description: 'The invited address.' })
  email!: string;

  @ApiProperty({
    type: AdminTeamRoleView,
    nullable: true,
    description: 'Null when the role no longer exists: the invitation cannot be accepted.',
  })
  role!: AdminTeamRoleView | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  invitedByAccountId!: string | null;

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

  @ApiProperty({ type: SellerTeamInvitationActions })
  actions!: SellerTeamInvitationActions;
}

export class SellerTeamPageView {
  @ApiProperty({
    description:
      'Active members and pending Staff invitations of your shop, merged by id (creation order); ' +
      '`type` tells them apart.',
    type: 'array',
    items: {
      oneOf: [
        { $ref: '#/components/schemas/SellerTeamMemberRowView' },
        { $ref: '#/components/schemas/SellerTeamInvitationRowView' },
      ],
    },
  })
  items!: (SellerTeamMemberRowView | SellerTeamInvitationRowView)[];

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Pass as `after` for the next page; null on the last page.',
  })
  next!: string | null;
}
