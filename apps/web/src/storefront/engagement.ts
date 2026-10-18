import type { Consent } from '../consent/consent.ts';

/** The header the engagement API needs before it records a guest or sets its cookie. */
export const ENGAGEMENT_CONSENT_HEADER = 'Engagement-Consent';

/**
 * The request that reports shopping behaviour to `POST /engagement/events` (personalization
 * 1a, PR #411), or null when the buyer has not accepted Personalization: then nothing is sent.
 * Not called yet; it is wired when #411 is on main and the storefront reads the API.
 */
export function engagementRequest(
  event: Readonly<Record<string, unknown>>,
  consent: Consent | null,
): RequestInit | null {
  if (consent?.personalization !== true) return null;
  return {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', [ENGAGEMENT_CONSENT_HEADER]: 'granted' },
    body: JSON.stringify(event),
  };
}
