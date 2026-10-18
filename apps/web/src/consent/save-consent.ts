'use server';

import { cookies } from 'next/headers';
import {
  CONSENT_COOKIE,
  CONSENT_MAX_AGE_SECONDS,
  ENGAGEMENT_COOKIE_PREFIX,
  consentValue,
} from './consent.ts';

/**
 * Keeps the buyer's choice. Without Personalization the behaviour cookie goes too: it is
 * HttpOnly, so only a response can remove it, and the engagement API sets it only on a call
 * that carries the consent header (src/storefront/engagement.ts).
 */
export async function saveConsent(personalization: boolean): Promise<void> {
  if (typeof personalization !== 'boolean') throw new TypeError('personalization');
  const jar = await cookies();
  jar.set(CONSENT_COOKIE, consentValue({ personalization }), {
    path: '/',
    maxAge: CONSENT_MAX_AGE_SECONDS,
    sameSite: 'lax',
    secure: true,
  });
  if (personalization) return;
  for (const { name } of jar.getAll()) {
    if (!name.startsWith(ENGAGEMENT_COOKIE_PREFIX)) continue;
    jar.set(name, '', { path: '/', maxAge: 0, sameSite: 'lax', secure: true, httpOnly: true });
  }
}
