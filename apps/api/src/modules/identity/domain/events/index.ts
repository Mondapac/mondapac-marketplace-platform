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
 * Consumers: the seller welcome mail and the reviewer notice (slices 5 and 9).
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
 * creation for an invitation (slice 8). `sellers` creates its record under the same id when it
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
];
