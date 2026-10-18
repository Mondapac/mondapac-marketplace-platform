// Marketing consent (personalization package 1b; owner decision 3 of 2026-10-18): express opt-in.
// A customer receives marketing on a channel only after they ticked an unticked box (sign-up) or
// switched it on (account page); withdrawing is always possible and takes effect at once. Only the
// `email` channel exists so far.

/** The channels a marketing consent covers. */
export const MARKETING_CHANNELS = ['email'] as const;
export type MarketingChannel = (typeof MARKETING_CHANNELS)[number];

/**
 * Where a change came from, kept with every change as the proof of consent: the sign-up checkbox,
 * the account page, or the one-click unsubscribe link of a marketing mail.
 */
export const CONSENT_SOURCES = ['sign-up', 'account', 'unsubscribe-link'] as const;
export type ConsentSource = (typeof CONSENT_SOURCES)[number];

/** The sources a signed-in customer may name when they change their own consent. */
export const CUSTOMER_CONSENT_SOURCES: readonly ConsentSource[] = ['sign-up', 'account'];

export const isCustomerConsentSource = (value: unknown): value is ConsentSource =>
  typeof value === 'string' && (CUSTOMER_CONSENT_SOURCES as readonly string[]).includes(value);
