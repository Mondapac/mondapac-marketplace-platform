import type { MarketId } from '@mondapac/shared-kernel';
import { readCookie } from '../../../platform/call-context/session-cookie';

/** Thirty days, the retention of a guest's behaviour (owner decision 4); never extended. */
export const ENGAGEMENT_GUEST_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/**
 * The engagement guest cookie: `__Host-`, `Secure`, `HttpOnly`, `Path=/`, `SameSite=Lax`, one per
 * Market, separate from the cart's. It holds the raw token; the store holds only its hash.
 */
export const engagementGuestCookieName = (marketId: MarketId): string =>
  `__Host-engagement-guest-${marketId}`;

const ATTRIBUTES = 'Path=/; Secure; HttpOnly; SameSite=Lax';

export const engagementGuestCookie = (marketId: MarketId, token: string): string =>
  `${engagementGuestCookieName(marketId)}=${token}; Max-Age=${ENGAGEMENT_GUEST_COOKIE_MAX_AGE_SECONDS}; ${ATTRIBUTES}`;

export const clearedEngagementGuestCookie = (marketId: MarketId): string =>
  `${engagementGuestCookieName(marketId)}=; Max-Age=0; ${ATTRIBUTES}`;

/** The raw token of the request, or null when there is none or it cannot be read (a new one is issued). */
export function engagementGuestTokenOf(
  cookieHeader: string | string[] | undefined,
  marketId: MarketId,
): string | null {
  const read = readCookie(cookieHeader, engagementGuestCookieName(marketId));
  return read.kind === 'one' ? read.value : null;
}

/** Whether the browser asks not to be tracked: Global Privacy Control, `Sec-GPC: 1`. */
export const globalPrivacyControlOf = (header: string | string[] | undefined): boolean =>
  header === '1';

/** Whether the storefront says the guest accepted the behaviour cookie (`Engagement-Consent`). */
export const engagementConsentOf = (header: string | string[] | undefined): boolean =>
  header === 'granted';
