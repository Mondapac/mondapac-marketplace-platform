'use server';

import { cookies, headers } from 'next/headers';
import { ga4IdFor } from '../analytics/ga4-config.ts';
import {
  CONSENT_COOKIE,
  CONSENT_MAX_AGE_SECONDS,
  ENGAGEMENT_COOKIE_PREFIX,
  consentValue,
  isAnalyticsCookie,
} from './consent.ts';

/**
 * Keeps the buyer's choice. Without Personalization the behaviour cookie goes too: it is
 * HttpOnly, so only a response can remove it, and the engagement API sets it only on a call
 * that carries the consent header (src/storefront/engagement.ts). Without Analytics the Google
 * cookies (`_ga`, `_ga_*`) go in the same response; the tag sets them host-only
 * (src/analytics/ga4.tsx), so expiring them here removes them. Analytics is kept off where the
 * Market has no measurement ID: there is nothing to agree to.
 */
export async function saveConsent(personalization: boolean, analytics: boolean): Promise<void> {
  if (typeof personalization !== 'boolean' || typeof analytics !== 'boolean') {
    throw new TypeError('consent');
  }
  const [jar, incoming] = await Promise.all([cookies(), headers()]);
  const analyticsOn = analytics && ga4IdFor(incoming.get('host')) !== null;
  jar.set(CONSENT_COOKIE, consentValue({ personalization, analytics: analyticsOn }), {
    path: '/',
    maxAge: CONSENT_MAX_AGE_SECONDS,
    sameSite: 'lax',
    secure: true,
    httpOnly: true,
  });
  for (const { name } of jar.getAll()) {
    const goes =
      (!personalization && name.startsWith(ENGAGEMENT_COOKIE_PREFIX)) ||
      (!analyticsOn && isAnalyticsCookie(name));
    if (goes)
      jar.set(name, '', { path: '/', maxAge: 0, sameSite: 'lax', secure: true, httpOnly: true });
  }
}
