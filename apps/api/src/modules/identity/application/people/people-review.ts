import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type {
  ChangeReviewValues,
  ProposeFailure,
  RecordedRequest,
  RecordFailure,
  SystemActionProposer,
  SystemRequestRecorder,
} from '../../../../platform/change-review/change-review';

// Admin Inbox › System requests, area people (owner decisions of 15 Nov 2026): an admin's change
// of a custom platform role, of another admin's role, or the enabling of a disabled admin goes
// live at once and opens a review in the same unit. Disabling an admin opens nothing: it is a stop,
// like a wallet freeze, and never waits for a note.
//
// Owner decision of 18 Nov 2026 ("mixed"): creating a custom platform role and inviting an admin
// go live at once and are reviewed after, like the edits (a reject deletes the role while nobody
// holds it, or revokes the invitation, or disables the account that accepted it); deleting a
// custom platform role waits for another admin's approval (`proposeChange`), since a delete
// cannot be undone. Revoking an invitation only narrows access and is not reviewed.
//
// Owner decision of 18 Nov 2026, 14:06Z: an admin invitation to a sensitive role waits for
// another admin's approval too (held, nothing sent); invitations to other roles stay as above.
//
// Every opening passes risk `high`, whatever the area's policy says, so the reviewer's step-up is
// spent before a revert writes. A revert never widens access (Hassan, PR #912 and #913): see
// people-reverters.ts.

/** The review area of the people changes. */
export const PEOPLE_REVIEW_AREA = 'people';
/** A custom platform role; subject = the role id, values `{ name, permissionKeys }`. */
export const PLATFORM_ROLE_SUBJECT_KIND = 'identity.platform-role';
/** An admin's roles; subject = the admin account id, values `{ roleIds }` (sorted). */
export const ADMIN_ROLES_SUBJECT_KIND = 'identity.admin-roles';
/** An admin's status; subject = the admin account id, values `{ status }`. */
export const ADMIN_STATUS_SUBJECT_KIND = 'identity.admin-status';
/**
 * The creation of a custom platform role (reviewed after); subject = the role id, values before
 * `{ exists: false }`, after `{ exists: true, name, permissionKeys }`.
 */
export const PLATFORM_ROLE_CREATION_SUBJECT_KIND = 'identity.platform-role-creation';
/**
 * An admin invitation (reviewed after); subject = the invitation id, values before
 * `{ exists: false }`, after `{ exists: true, roleId }`. Never the invited address.
 */
export const ADMIN_INVITATION_SUBJECT_KIND = 'identity.admin-invitation';
/**
 * The deletion of a custom platform role (waits for approval); subject = the role id, values
 * before `{ name, permissionKeys, version }` (the role as it stood when asked), after
 * `{ action: 'delete' }`.
 */
export const PLATFORM_ROLE_DELETION_SUBJECT_KIND = 'identity.platform-role-deletion';

/**
 * An admin invitation to a sensitive role (the Platform Administrator, or a role with a protected
 * permission), which waits for another admin's approval (owner decision of 18 Nov 2026, 14:06Z);
 * subject = the held invitation's id, values before `{ roleId, roleVersion }` (the role as it
 * stood when asked), after `{ action: 'invite', roleId }`. Never the invited address: it stays on
 * the held invitation row, as on any pending one.
 */
export const SENSITIVE_ADMIN_INVITATION_SUBJECT_KIND = 'identity.admin-invitation-sensitive';

/** The values before of a create (nothing existed). */
export const NOTHING_BEFORE: ChangeReviewValues = Object.freeze({ exists: false });

/** The request a change opened, as the routes answer it. */
export type ReviewRef = Pick<RecordedRequest, 'id' | 'number'>;

/** Whether a people change is reviewed in the Market and at which risk (the page asks for a note). */
export interface PeopleReview {
  readonly reviewed: boolean;
  readonly risk: 'low' | 'medium' | 'high';
}

/**
 * The review policy of the people area, for a page. Opens its own read-only unit: call it outside
 * any unit (units do not nest). A store that cannot be read answers the area's default.
 */
export async function peopleReview(
  review: SystemRequestRecorder,
  context: CallContext,
): Promise<PeopleReview> {
  const policy = await review.areaPolicy(context, PEOPLE_REVIEW_AREA);
  return { reviewed: policy.enabled, risk: policy.risk };
}

/**
 * Opens the review of a people change in the caller's open unit, after its write, at high risk.
 * `ok(null)` when the area is off or nothing changed; an `err` is the caller's own refusal (a
 * missing note), so it returns it and its unit commits nothing.
 */
export async function openPeopleReview(
  review: SystemRequestRecorder,
  context: CallContext,
  change: {
    readonly subjectKind:
      | typeof PLATFORM_ROLE_SUBJECT_KIND
      | typeof ADMIN_ROLES_SUBJECT_KIND
      | typeof ADMIN_STATUS_SUBJECT_KIND
      | typeof PLATFORM_ROLE_CREATION_SUBJECT_KIND
      | typeof ADMIN_INVITATION_SUBJECT_KIND;
    readonly subjectRef: Id<'Role'> | Id<'Account'> | Id<'Invitation'>;
    readonly before: ChangeReviewValues;
    readonly after: ChangeReviewValues;
    readonly note: unknown;
  },
): Promise<Result<ReviewRef | null, RecordFailure>> {
  const opened = await review.openReview(context, {
    area: PEOPLE_REVIEW_AREA,
    subjectKind: change.subjectKind,
    subjectRef: change.subjectRef,
    before: change.before,
    after: change.after,
    note: change.note,
    risk: 'high',
  });
  if (!opened.ok) return err(opened.error);
  return ok(opened.value === null ? null : { id: opened.value.id, number: opened.value.number });
}

/**
 * Files a people action that waits for another admin's approval (owner decision of 18 Nov 2026),
 * in the caller's open unit, at high risk. `ok(null)` when the area is off: the caller applies the
 * action at once, in the same unit, as before. An `err` is the caller's own refusal (a missing
 * note, or `system-requests.already-pending` with the waiting request's number); the caller then
 * writes nothing.
 */
export async function proposePeopleAction(
  proposer: SystemActionProposer,
  context: CallContext,
  action: {
    readonly subjectKind:
      typeof PLATFORM_ROLE_DELETION_SUBJECT_KIND | typeof SENSITIVE_ADMIN_INVITATION_SUBJECT_KIND;
    readonly subjectRef: Id<'Role'> | Id<'Invitation'>;
    readonly before: ChangeReviewValues;
    readonly after: ChangeReviewValues;
    readonly note: unknown;
  },
): Promise<Result<ReviewRef | null, ProposeFailure>> {
  const proposed = await proposer.proposeChange(context, {
    area: PEOPLE_REVIEW_AREA,
    subjectKind: action.subjectKind,
    subjectRef: action.subjectRef,
    before: action.before,
    after: action.after,
    note: action.note,
    risk: 'high',
  });
  if (!proposed.ok) return err(proposed.error);
  return ok(
    proposed.value === null ? null : { id: proposed.value.id, number: proposed.value.number },
  );
}
