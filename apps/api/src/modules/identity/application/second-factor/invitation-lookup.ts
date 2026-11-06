import type { Temporal } from '@mondapac/shared-kernel';
import type { Invitation } from '../../domain/invitation';

/** The fixed life of an acceptance's secret and tag (identity design 3.4; accepted by Hassan). */
export const ENROLMENT_SECRET_MINUTES = 15;

/**
 * Whether an invitation can be accepted through the admin path (identity design 3.4, 7.4):
 * dispatched, pending and unexpired at `now`, of the `admin` kind. Both the first-admin
 * invitation (no inviter, slice 7b) and one issued by an admin (slice 8b) pass here; the closing
 * unit of the acceptance then applies the guards of each: HF5 for the first, and for the second
 * the inviter still active and still able to grant the role (Hassan, 14.2).
 */
export function acceptableAdminInvitation(
  invitation: Invitation | null,
  now: Temporal.Instant,
): invitation is Invitation {
  return (
    invitation !== null &&
    invitation.usableAt(now) &&
    invitation.state.kind === 'admin' &&
    invitation.state.email !== null
  );
}

/**
 * Whether an invitation can be accepted through the agent path (ADR-0045 decision 2): dispatched,
 * pending and unexpired at `now`, of the `agent` kind, with a live handover code. The admin path
 * above never passes an agent invitation and this one never passes any other kind, so a token of
 * one kind cannot be used on the other's route.
 */
export function acceptableAgentInvitation(
  invitation: Invitation | null,
  now: Temporal.Instant,
): invitation is Invitation {
  return (
    invitation !== null &&
    invitation.usableAt(now) &&
    invitation.state.kind === 'agent' &&
    invitation.state.email !== null &&
    invitation.handoverCodeLive
  );
}
