import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type {
  ChangeReviewValues,
  RecordedRequest,
  RecordFailure,
  SystemRequestRecorder,
} from '../../../../platform/change-review/change-review';

// Admin Inbox › System requests, area people (owner decisions of 15 Nov 2026): an admin's change
// of a custom platform role, of another admin's role, or the enabling of a disabled admin goes
// live at once and opens a review in the same unit. Creating, deleting, inviting and revoking are
// not reviewed (owner decision: they get their own design). Disabling an admin opens nothing: it
// is a stop, like a wallet freeze, and never waits for a note.
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
      | typeof ADMIN_STATUS_SUBJECT_KIND;
    readonly subjectRef: Id<'Role'> | Id<'Account'>;
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
