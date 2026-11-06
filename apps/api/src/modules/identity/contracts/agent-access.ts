import type { Id } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';

/**
 * The permission an admin must hold to manage agents (ADR-0045 decision 2; agents brief
 * AGT-01). The key is declared by the `agents` module, so identity cannot import it (ADR-0008):
 * it is a plain string here, and `identity`'s agent use cases re-check it on the caller's own
 * actor, in the unit that writes. Until `agents` declares it the permission registry holds it
 * for nobody and every such use case answers `access.denied` (fail closed).
 */
export const AGENTS_MANAGE_KEY = 'agents.agent.manage';

/** The permission to read agents (list, detail): `agents.agent.read`, also declared by `agents`. */
export const AGENTS_READ_KEY = 'agents.agent.read';

/** The access state of an agent account (ADR-0045 decision 5), read live. */
export type AgentAccess = 'active' | 'disabled' | 'invited';

/** An issued agent invitation (ADR-0045 decision 2). The handover code is shown once. */
export interface AgentInvitationIssued {
  /** The id the agent account will have: the `agents` module keys its profile by it. */
  readonly accountId: Id<'Account'>;
  readonly invitationId: Id<'Invitation'>;
  /** Shown once, to the issuing admin only; identity stores its HMAC and cannot show it again. */
  readonly handoverCode: string;
}

export type AgentInvitationFailure =
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { path: string; code: string }[];
    }
  /** An agent account or a live invitation for the address exists: to the admin only. */
  | { readonly code: 'invitation.already-pending' }
  | { readonly code: 'invitation.not-found' }
  | { readonly code: 'request.throttled'; readonly retryAfterSeconds: number }
  | { readonly code: 'access.unavailable' }
  | AccessDenied;

export type AgentAccountStatusFailure = { readonly code: 'agent.unknown' } | AccessDenied;

/** Sessions and invitations a disable or an enable changed. */
export interface AgentAccountStatusChanged {
  readonly accountId: Id<'Account'>;
  readonly revokedSessions: number;
  readonly voidedInvitations: number;
}
