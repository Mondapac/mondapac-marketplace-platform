import type { MarketId } from '@mondapac/shared-kernel';
import { readCookie } from '../../../platform/call-context/session-cookie';

/** Seven days, the life of a guest cart after its last change (cart design 3.1). */
export const GUEST_COOKIE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

/** Not a valid token, so the use case treats it as a stale cookie and clears it. */
const MALFORMED = '!';

/**
 * The guest cart cookie (cart design 4): `__Host-`, `Secure`, `HttpOnly`, `Path=/`, `SameSite=Lax`,
 * one per Market. It holds the raw token; the store holds only its hash.
 */
export const guestCookieName = (marketId: MarketId): string => `__Host-cart-guest-${marketId}`;

const ATTRIBUTES = 'Path=/; Secure; HttpOnly; SameSite=Lax';

export const guestCookie = (marketId: MarketId, token: string): string =>
  `${guestCookieName(marketId)}=${token}; Max-Age=${GUEST_COOKIE_MAX_AGE_SECONDS}; ${ATTRIBUTES}`;

export const clearedGuestCookie = (marketId: MarketId): string =>
  `${guestCookieName(marketId)}=; Max-Age=0; ${ATTRIBUTES}`;

/** The raw token of the request, or null when there is none. A repeated or malformed one is refused by the use case. */
export function guestTokenOf(
  cookieHeader: string | string[] | undefined,
  marketId: MarketId,
): string | null {
  const read = readCookie(cookieHeader, guestCookieName(marketId));
  if (read.kind === 'absent') return null;
  return read.kind === 'one' ? read.value : MALFORMED;
}
