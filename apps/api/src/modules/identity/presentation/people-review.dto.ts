import { ApiProperty } from '@nestjs/swagger';
import {
  AdminAccountStatusChanged,
  AdminAssignRoleRequest,
  AdminRoleAssigned,
  AdminTeamPageView,
} from './admin-team.dto';
import { AdminInvitationIssued, AdminInviteRequest } from './admin-team.dto';
import {
  RoleCatalogueView,
  RoleEditorRequest,
  RoleEditRequest,
  RoleVersionRequest,
  RoleWrittenView,
} from './role-editor.dto';

// The bodies of Admin Inbox › System requests on the admin team and platform role routes (area
// people): the admin's note, the request a change opened, and whether a page asks for a note.

export const NOTE_DESCRIPTION =
  "The admin's note for the reviewer, 1 to 500 characters; required while the Market reviews " +
  'area people in Admin Inbox › System requests (else 400 on note), ignored otherwise.';

const REQUEST_DESCRIPTION =
  'The review this change opened in Admin Inbox › System requests; null when the Market does ' +
  'not review area people or nothing changed.';

/** The System requests review a change opened. */
export class PeopleReviewRequestRef {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ description: 'Shown as SR-<number>.' }) number!: number;
}

/** Whether a change is reviewed in the Market, and at which risk: the page then asks for a note. */
export class PeopleReviewView {
  @ApiProperty({ description: 'Whether the Market reviews area people.' }) reviewed!: boolean;
  @ApiProperty({ enum: ['low', 'medium', 'high'] }) risk!: 'low' | 'medium' | 'high';
}

export class PlatformRoleEditRequest extends RoleEditRequest {
  @ApiProperty({ required: false, description: NOTE_DESCRIPTION }) note?: string;
}

export class PlatformRoleEditedView extends RoleWrittenView {
  @ApiProperty({ type: PeopleReviewRequestRef, nullable: true, description: REQUEST_DESCRIPTION })
  request!: PeopleReviewRequestRef | null;
}

export class PlatformRoleCreateRequest extends RoleEditorRequest {
  @ApiProperty({ required: false, description: NOTE_DESCRIPTION }) note?: string;
}

export class PlatformRoleCreatedView extends RoleWrittenView {
  @ApiProperty({ type: PeopleReviewRequestRef, nullable: true, description: REQUEST_DESCRIPTION })
  request!: PeopleReviewRequestRef | null;
}

export class PlatformRoleDeleteRequest extends RoleVersionRequest {
  @ApiProperty({ required: false, description: NOTE_DESCRIPTION }) note?: string;
}

export class PlatformRoleDeletedView {
  @ApiProperty({
    enum: ['role.deleted', 'role.delete-requested'],
    description:
      'role.deleted (200): the role is gone. role.delete-requested (202): the delete waits for ' +
      "another admin's approval in Admin Inbox › System requests; nothing changed yet.",
  })
  code!: 'role.deleted' | 'role.delete-requested';

  @ApiProperty({ format: 'uuid' })
  roleId!: string;

  @ApiProperty({
    type: PeopleReviewRequestRef,
    nullable: true,
    description:
      'The request the delete waits on (202); null when the Market does not review area people ' +
      'and the role was deleted at once (200).',
  })
  request!: PeopleReviewRequestRef | null;
}

export class AdminInviteReviewedRequest extends AdminInviteRequest {
  @ApiProperty({ required: false, description: NOTE_DESCRIPTION }) note?: string;
}

export class AdminInvitationIssuedReviewed extends AdminInvitationIssued {
  @ApiProperty({ type: PeopleReviewRequestRef, nullable: true, description: REQUEST_DESCRIPTION })
  request!: PeopleReviewRequestRef | null;
}

export class PlatformRoleCatalogueView extends RoleCatalogueView {
  @ApiProperty({
    type: PeopleReviewView,
    description:
      'Whether creating, editing or deleting a custom role is reviewed (the editor then asks for ' +
      'a note; a delete then waits for approval).',
  })
  review!: PeopleReviewView;
}

export class AdminAssignRoleReviewedRequest extends AdminAssignRoleRequest {
  @ApiProperty({ required: false, description: NOTE_DESCRIPTION }) note?: string;
}

export class AdminRoleAssignedReviewed extends AdminRoleAssigned {
  @ApiProperty({ type: PeopleReviewRequestRef, nullable: true, description: REQUEST_DESCRIPTION })
  request!: PeopleReviewRequestRef | null;
}

/** The body of an admin's disable or enable: only the optional note. */
export class AdminStatusRequest {
  @ApiProperty({
    required: false,
    description: `${NOTE_DESCRIPTION} Read only by an enable: a disable is a stop and is never reviewed.`,
  })
  note?: string;
}

export class AdminStatusChangedReviewed extends AdminAccountStatusChanged {
  @ApiProperty({
    type: PeopleReviewRequestRef,
    nullable: true,
    description: `${REQUEST_DESCRIPTION} Always null for a disable.`,
  })
  request!: PeopleReviewRequestRef | null;
}

export class AdminTeamReviewedPageView extends AdminTeamPageView {
  @ApiProperty({
    type: PeopleReviewView,
    description:
      'Whether a role change, an enabling or an invitation is reviewed (the page then asks for ' +
      'a note); a disable or a revoke never is.',
  })
  review!: PeopleReviewView;
}
