// The buyer's cookie choice (john, 18 Oct 2026: ask first). Necessary cookies are always on;
// Personalization, the behaviour cookie of the engagement module, waits for Accept. The choice
// is kept per browser in the necessary cookie `sf-consent`; a signed-in customer's choice moves
// to their account when the personalization API offers it.

export const CONSENT_COOKIE = 'sf-consent';

/** Raise when the cookie categories change, so every buyer is asked again. */
export const CONSENT_VERSION = 1;

export const CONSENT_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

/** The behaviour cookie the engagement API sets, one per Market (`__Host-engagement-guest-AU`). */
export const ENGAGEMENT_COOKIE_PREFIX = '__Host-engagement-guest-';

export type Consent = { readonly personalization: boolean };

/** `v1.p1` (accepted) or `v1.p0` (rejected). */
export const consentValue = (consent: Consent): string =>
  `v${CONSENT_VERSION}.p${consent.personalization ? 1 : 0}`;

/** The saved choice, or null when the buyer has not chosen under the current categories. */
export function consentOf(value: string | undefined): Consent | null {
  const match = /^v(\d+)\.p([01])$/.exec(value ?? '');
  if (match === null || Number(match[1]) !== CONSENT_VERSION) return null;
  return { personalization: match[2] === '1' };
}
