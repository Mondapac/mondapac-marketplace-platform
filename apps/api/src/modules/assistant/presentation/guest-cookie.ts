import type { MarketId } from '@mondapac/shared-kernel';
import { readCookie } from '../../../platform/call-context/session-cookie';

/** 30 days: the longest a guest's conversation is kept (plan section 11). */
export const GUEST_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/** Not a valid token, so the use case issues a new one. */
const MALFORMED = '!';

/**
 * The assistant's own guest cookie (plan section 4; not the behaviour or cart cookie):
 * `__Host-`, `Secure`, `HttpOnly`, `Path=/`, `SameSite=Lax`, one per Market. It holds the raw
 * token; the store holds only its hash.
 */
export const guestCookieName = (marketId: MarketId): string => `__Host-assistant-guest-${marketId}`;

export const guestCookie = (marketId: MarketId, token: string): string =>
  `${guestCookieName(marketId)}=${token}; Max-Age=${GUEST_COOKIE_MAX_AGE_SECONDS}; ` +
  'Path=/; Secure; HttpOnly; SameSite=Lax';

/** The raw token of the request, or null when there is none. */
export function guestTokenOf(
  cookieHeader: string | string[] | undefined,
  marketId: MarketId,
): string | null {
  const read = readCookie(cookieHeader, guestCookieName(marketId));
  if (read.kind === 'absent') return null;
  return read.kind === 'one' ? read.value : MALFORMED;
}
