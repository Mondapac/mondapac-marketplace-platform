import type { Temporal } from '@mondapac/shared-kernel';
import type { Invitation } from '../../domain/invitation';

/** The fixed life of an acceptance's secret and tag (identity design 3.4; accepted by Hassan). */
export const ENROLMENT_SECRET_MINUTES = 15;

/**
 * Whether an invitation can be accepted through the admin path of slice 7b (identity design 3.4,
 * 7.4): dispatched, pending and unexpired at `now`, of the `admin` kind, with no inviter. An
 * admin invitation with an inviter needs the inviter re-checked (Hassan, 14.2), which comes with
 * the admin team of slice 8b; until then it is refused like any other unusable invitation.
 */
export function acceptableAdminInvitation(
  invitation: Invitation | null,
  now: Temporal.Instant,
): invitation is Invitation {
  return (
    invitation !== null &&
    invitation.usableAt(now) &&
    invitation.state.kind === 'admin' &&
    invitation.state.invitedByAccountId === null &&
    invitation.state.email !== null
  );
}
