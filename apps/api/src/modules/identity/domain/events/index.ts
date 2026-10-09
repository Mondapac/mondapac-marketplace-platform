import { defineEvent, eventField, POPULATIONS } from '@mondapac/shared-kernel';
import type { EventDefinition } from '@mondapac/shared-kernel';

/**
 * A customer account was created by sign-up (identity design 8.2; slice 1d). Ids only: the
 * email and the password never reach an event. The verification mail is not driven by it but
 * by the link request recorded in the same unit (3.7, slice 3); its consumers come later.
 */
export const CustomerAccountRegistered = defineEvent({
  type: 'identity.customer-account-registered.v1',
  aggregateType: 'account',
  payload: { accountId: eventField.id() },
});

/**
 * Someone signed up again with the address of an existing account of the same Market and
 * population (identity design 6.7 and 8.2). The answer to the request was the same as for a
 * new address (AC 21); this event drives the only difference, the mail (slice 3):
 *
 * - `unverified-replaced`: the account was unverified; its password (and, for a seller, its
 *   name) was replaced, the purge anchor restarted, and a new verification link is due.
 * - `verified-notice`: the account is verified; nothing changed but the notice instant, and
 *   the holder gets "you already have an account", at most once in 24 hours.
 */
export const SignUpRepeated = defineEvent({
  type: 'identity.sign-up-repeated.v1',
  aggregateType: 'account',
  payload: {
    accountId: eventField.id(),
    cause: eventField.enumOf(['unverified-replaced', 'verified-notice'] as const),
  },
});

/** The purposes of a one-time link (identity design 3.7; data design 3.7). */
export const LINK_PURPOSES = [
  'verify-email',
  'reset-password',
  'enrol-second-factor',
  'confirm-second-factor-reset',
] as const;

/**
 * A one-time link was requested (identity design 3.7 and 6.6): the row exists without a token;
 * identity's own mail handler mints the token, sends the mail and stores the hash (9). Not
 * recorded when the mail counters refused the mail (Mojtaba, item 3): the request's verdict
 * travels in the unit, and the handler never reads a counter.
 */
export const OneTimeLinkRequested = defineEvent({
  type: 'identity.one-time-link-requested.v1',
  aggregateType: 'one-time-link',
  payload: {
    linkId: eventField.id(),
    accountId: eventField.id(),
    purpose: eventField.enumOf(LINK_PURPOSES),
  },
});

/**
 * The account's email was confirmed through its link and password (identity design 3.2, 8.2).
 * Consumers: the seller welcome mail only (slice 5, sent on `identity.seller-registered.v1`,
 * recorded in the same unit). The reviewer notice is not sent on it: it follows a seller's
 * submission, through the seller-access contract (identity design 8.7, request R-3).
 */
export const AccountEmailVerified = defineEvent({
  type: 'identity.account-email-verified.v1',
  aggregateType: 'account',
  payload: {
    accountId: eventField.id(),
    population: eventField.enumOf(POPULATIONS),
  },
});

/** The origins of a seller (identity design 2.1): self-registration or an owner invitation. */
export const SELLER_ORIGINS = ['self', 'invitation'] as const;

/** The access states of a seller (identity design 3.3). */
export const SELLER_ACCESS_STATES = ['pending', 'approved', 'rejected', 'suspended'] as const;

/**
 * A seller exists for other modules (identity design 8.2; ADR-0022): published at the owner's
 * email verification for a self-registration, as the `SellerAccess` version step that sets
 * `registeredAt` (M4), so no consumer sees a seller the 7-day purge may still delete; at
 * creation for an invitation (slice 9; `ownerAccountId` null: the owner joins when it accepts).
 * `sellers` creates its record under the same id when it
 * consumes it. Ids and codes only: no name, no email.
 */
export const SellerRegistered = defineEvent({
  type: 'identity.seller-registered.v1',
  aggregateType: 'seller-access',
  payload: {
    sellerId: eventField.id(),
    ownerAccountId: eventField.optional(eventField.id()),
    origin: eventField.enumOf(SELLER_ORIGINS),
    accessState: eventField.enumOf(SELLER_ACCESS_STATES),
  },
});

/** Why an account's password was replaced (identity design 3.5, 3.7, 8.2; slice 4). */
export const PASSWORD_CHANGE_CAUSES = ['reset', 'change'] as const;

/**
 * The account's password was replaced (identity design 3.7, 6.5, 8.2; slice 4): through a reset
 * link (`reset`) or by the signed-in holder with the current password (`change`). In the same unit
 * the account's sessions were revoked (all of them on a reset, all but the rotated current one on
 * a change). Drives the "password changed" notice (`ux.md` E13). Ids and codes only.
 */
export const AccountPasswordChanged = defineEvent({
  type: 'identity.account-password-changed.v1',
  aggregateType: 'account',
  payload: {
    accountId: eventField.id(),
    cause: eventField.enumOf(PASSWORD_CHANGE_CAUSES),
  },
});

/** The kinds of an invitation (identity design 3.4): admin (slice 7), seller-owner (9), staff (11). */
export const INVITATION_KINDS = ['seller-owner', 'staff', 'admin'] as const;

/**
 * An invitation was issued (identity design 3.4, 8.2; slice 7b: the first-admin routine; a re-send
 * from slice 8b). The row exists without a token; identity's own mail handler mints the token,
 * sends the mail and stores the hash and the expiry (6.6). Ids and codes only: never the invited
 * address or a name.
 */
export const InvitationIssued = defineEvent({
  type: 'identity.invitation-issued.v1',
  aggregateType: 'invitation',
  payload: {
    invitationId: eventField.id(),
    kind: eventField.enumOf(INVITATION_KINDS),
    sellerId: eventField.optional(eventField.id()),
  },
});

/**
 * An invitation was accepted (identity design 3.4, 8.2; slice 7b): the account named here was
 * created, with its assignment (and, for an admin, its active second factor), in the same unit.
 */
export const InvitationAccepted = defineEvent({
  type: 'identity.invitation-accepted.v1',
  aggregateType: 'invitation',
  payload: {
    invitationId: eventField.id(),
    kind: eventField.enumOf(INVITATION_KINDS),
    sellerId: eventField.optional(eventField.id()),
    accountId: eventField.id(),
  },
});

/**
 * What happened to a second factor (identity design 3.6, 6.8, 8.2): `activated` (an enrolment
 * completed, inside an invitation's acceptance or from a link), `replaced` (a new device swapped
 * in), `recovery-codes-regenerated`, `reset` (the factor returned to `none`) and `locked` (HF2:
 * the `second-factor.account` counter reached its limit; the event sends the alert mail).
 */
export const SECOND_FACTOR_CHANGES = [
  'activated',
  'replaced',
  'recovery-codes-regenerated',
  'reset',
  'locked',
] as const;
export type SecondFactorChange = (typeof SECOND_FACTOR_CHANGES)[number];

/**
 * A second factor changed (identity design 3.6, 8.2; slice 7b). Ids and a code only: never the
 * secret, a code or a recovery code. Drives the mail of `replaced`, `reset` and `locked` (9).
 */
export const SecondFactorChanged = defineEvent({
  type: 'identity.second-factor-changed.v1',
  aggregateType: 'second-factor',
  payload: {
    accountId: eventField.id(),
    change: eventField.enumOf(SECOND_FACTOR_CHANGES),
  },
});

/**
 * An admin or customer account was disabled by an admin (identity design 3.1, 8.2; slice 8b). In
 * the same unit every session of the account was revoked and its open challenges voided. Ids and
 * a code only.
 */
export const AccountDisabled = defineEvent({
  type: 'identity.account-disabled.v1',
  aggregateType: 'account',
  payload: {
    accountId: eventField.id(),
    population: eventField.enumOf(POPULATIONS),
  },
});

/** A disabled account was enabled again by an admin (identity design 3.1, 8.2; slice 8b). */
export const AccountEnabled = defineEvent({
  type: 'identity.account-enabled.v1',
  aggregateType: 'account',
  payload: {
    accountId: eventField.id(),
    population: eventField.enumOf(POPULATIONS),
  },
});

/** The two scopes of a role (identity design 2.1, R2), as an event names them. */
export const ROLE_ASSIGNMENT_SCOPES = ['platform', 'seller'] as const;

/**
 * An account's role was changed by another account (identity design 8.2; slice 8a-2 for admins,
 * 11 for Staff). Not recorded for a founding assignment or for the assignment an invitation's
 * acceptance creates: `seller-registered` and `invitation-accepted` name those. Ids and codes
 * only, never a role's name (R5). `sellerId` is null in platform scope.
 */
export const AccountRoleChanged = defineEvent({
  type: 'identity.account-role-changed.v1',
  aggregateType: 'role-assignment',
  payload: {
    accountId: eventField.id(),
    scope: eventField.enumOf(ROLE_ASSIGNMENT_SCOPES),
    sellerId: eventField.optional(eventField.id()),
    previousRoleId: eventField.id(),
    roleId: eventField.id(),
  },
});

/**
 * A custom role was created, edited or deleted in the role editor (identity design 8.2, 5.4 R5;
 * slice 10). Ids, scope and permission keys only: the role's name is personal free text and has
 * no path into an event. `sellerId` is null in platform scope; `addedKeys` and `removedKeys` are
 * the keys the change put in and took out (a created role adds all its keys, a deleted one
 * removes all).
 */
const ROLE_CHANGE_PAYLOAD = {
  roleId: eventField.id(),
  scope: eventField.enumOf(ROLE_ASSIGNMENT_SCOPES),
  sellerId: eventField.optional(eventField.id()),
  addedKeys: eventField.listOf(eventField.permissionKey()),
  removedKeys: eventField.listOf(eventField.permissionKey()),
} as const;

export const RoleCreated = defineEvent({
  type: 'identity.role-created.v1',
  aggregateType: 'role',
  payload: ROLE_CHANGE_PAYLOAD,
});

export const RoleUpdated = defineEvent({
  type: 'identity.role-updated.v1',
  aggregateType: 'role',
  payload: ROLE_CHANGE_PAYLOAD,
});

export const RoleDeleted = defineEvent({
  type: 'identity.role-deleted.v1',
  aggregateType: 'role',
  payload: ROLE_CHANGE_PAYLOAD,
});

/**
 * A pending invitation was revoked by the inviter's side (identity design 3.4, 8.2; slice 8b), or
 * replaced by a new issue for the same address (item G). Ids and codes only.
 */
export const InvitationRevoked = defineEvent({
  type: 'identity.invitation-revoked.v1',
  aggregateType: 'invitation',
  payload: {
    invitationId: eventField.id(),
    kind: eventField.enumOf(INVITATION_KINDS),
    sellerId: eventField.optional(eventField.id()),
  },
});

/**
 * A pending seller was approved (identity design 3.3, 8.2; SEL-03, AC 4; slice 9). `decisionId`
 * names the `AccessDecision`; `basisId` is the `sellers` submission the approval rests on, once
 * `sellers` calls through its contract (ADR-0022 decision 4: carried in v1, null in Phase 2,
 * where an admin decides on name and email). `sellers.close-decision` and the result mail (`ux.md`
 * E4) consume it. Ids only: never a name, an email or a reason.
 */
export const SellerAccessApproved = defineEvent({
  type: 'identity.seller-access-approved.v1',
  aggregateType: 'seller-access',
  payload: {
    sellerId: eventField.id(),
    decisionId: eventField.id(),
    basisId: eventField.optional(eventField.id()),
  },
});

/**
 * A pending seller was rejected with a reason (3.3, 8.2; decision 9, AC 6; slice 9). The reason is
 * never in the event: the mail handler decrypts it from the decision named here (E5).
 */
export const SellerAccessRejected = defineEvent({
  type: 'identity.seller-access-rejected.v1',
  aggregateType: 'seller-access',
  payload: {
    sellerId: eventField.id(),
    decisionId: eventField.id(),
    basisId: eventField.optional(eventField.id()),
  },
});

/**
 * An approved seller was suspended with a reason (3.3, 8.2; SEL-07, AC 14; slice 9). In the same
 * unit every session of the seller's accounts was revoked (E6).
 */
export const SellerAccessSuspended = defineEvent({
  type: 'identity.seller-access-suspended.v1',
  aggregateType: 'seller-access',
  payload: {
    sellerId: eventField.id(),
    decisionId: eventField.id(),
  },
});

/** A suspended seller was reinstated (3.3, 8.2; AC 14; slice 9): E7. */
export const SellerAccessReinstated = defineEvent({
  type: 'identity.seller-access-reinstated.v1',
  aggregateType: 'seller-access',
  payload: {
    sellerId: eventField.id(),
    decisionId: eventField.id(),
  },
});

/**
 * A rejected seller applied again and is pending (3.3, 8.2; AC 6; slice 9): only through the
 * seller-access contract, which `sellers`' "submit again" calls. No decision is written; the
 * re-application is the seller's own act. `sellers.close-decision` clears its intent on it.
 */
export const SellerAccessReapplied = defineEvent({
  type: 'identity.seller-access-reapplied.v1',
  aggregateType: 'seller-access',
  payload: {
    sellerId: eventField.id(),
  },
});

/**
 * Every event identity publishes, declared with `defineEvent` (platform persistence design
 * 5.3; identity design 8.2) and registered with the event catalogue by `IdentityModule`. Each
 * new type changes the catalogue snapshot (`apps/api/test/contracts/event-catalogue.snapshot.json`).
 */
export const IDENTITY_EVENTS: readonly EventDefinition[] = [
  CustomerAccountRegistered,
  SignUpRepeated,
  OneTimeLinkRequested,
  AccountEmailVerified,
  SellerRegistered,
  AccountPasswordChanged,
  InvitationIssued,
  InvitationAccepted,
  SecondFactorChanged,
  AccountDisabled,
  AccountEnabled,
  AccountRoleChanged,
  RoleCreated,
  RoleUpdated,
  RoleDeleted,
  InvitationRevoked,
  SellerAccessApproved,
  SellerAccessRejected,
  SellerAccessSuspended,
  SellerAccessReinstated,
  SellerAccessReapplied,
];
