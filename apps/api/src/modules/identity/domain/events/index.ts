import { defineEvent, eventField } from '@mondapac/shared-kernel';
import type { EventDefinition } from '@mondapac/shared-kernel';

/**
 * A customer account was created by sign-up (identity design 8.2; slice 1d). Ids only: the
 * email and the password never reach an event. Its first consumer is identity's own
 * verification mail (slice 3).
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

/**
 * Every event identity publishes, declared with `defineEvent` (platform persistence design
 * 5.3; identity design 8.2) and registered with the event catalogue by `IdentityModule`. Each
 * new type changes the catalogue snapshot (`apps/api/test/contracts/event-catalogue.snapshot.json`).
 */
export const IDENTITY_EVENTS: readonly EventDefinition[] = [
  CustomerAccountRegistered,
  SignUpRepeated,
];
