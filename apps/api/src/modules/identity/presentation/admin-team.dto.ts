import { ApiProperty } from '@nestjs/swagger';

// Bodies and answers of the admin team routes (identity design 3.1, 3.4, 3.6, 5.3, 5.5, 8.6;
// slices 8a-2 and 8b). Ids and codes only: no answer carries an address, a name or a role name.

const UUID = 'A UUID v7.';

/** Change an admin's role (5.3 `identity.platform-role.assign`). */
export class AdminAssignRoleRequest {
  @ApiProperty({ description: `The platform role to assign. ${UUID}`, format: 'uuid' })
  roleId!: string;
}

/** Invite an admin with a role (3.4; `identity.admin-account.invite`). */
export class AdminInviteRequest {
  @ApiProperty({
    description: "The invitee's sign-in address. Never logged, echoed or audited.",
    maxLength: 254,
  })
  email!: string;

  @ApiProperty({ description: `The platform role the invitee will hold. ${UUID}`, format: 'uuid' })
  roleId!: string;
}

/** A route that takes no fields: the body is `{}` (JSON only, 6.4). */
export class AdminEmptyRequest {}

export class AdminRoleAssigned {
  @ApiProperty({
    enum: ['role.assigned', 'role.unchanged'],
    description: 'role.unchanged: the account already held the role; nothing was written.',
  })
  code!: 'role.assigned' | 'role.unchanged';

  @ApiProperty({ format: 'uuid' })
  accountId!: string;

  @ApiProperty({ format: 'uuid' })
  roleId!: string;
}

export class AdminAccountStatusChanged {
  @ApiProperty({
    enum: ['account.disabled', 'account.enabled'],
    description: 'A disable revoked every session of the account and voided its open sign-ins.',
  })
  code!: 'account.disabled' | 'account.enabled';

  @ApiProperty({ format: 'uuid' })
  accountId!: string;
}

export class AdminSecondFactorReset {
  @ApiProperty({
    enum: ['second-factor.reset'],
    description:
      'The factor was removed, every session revoked and the account mailed; its next ' +
      'sign-in mails an enrolment link.',
  })
  code!: 'second-factor.reset';

  @ApiProperty({ format: 'uuid' })
  accountId!: string;
}

export class AdminInvitationIssued {
  @ApiProperty({
    enum: ['invitation.issued'],
    description: 'The invitation exists; its mail is sent shortly, with a new token.',
  })
  code!: 'invitation.issued';

  @ApiProperty({ format: 'uuid' })
  invitationId!: string;
}

export class AdminInvitationChanged {
  @ApiProperty({
    enum: ['invitation.reissued', 'invitation.revoked'],
    description: 'reissued: the earlier link stopped working and a new mail follows.',
  })
  code!: 'invitation.reissued' | 'invitation.revoked';

  @ApiProperty({ format: 'uuid' })
  invitationId!: string;
}
