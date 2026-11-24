import 'server-only';
import { REQUESTED_PATH_HEADER, withReturnTo } from '@mondapac/panel-server/return-to';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { cache } from 'react';
import { serverGet } from './server-fetch.ts';

export interface SellerSession {
  readonly accountId: string;
  readonly sellerId: string;
  readonly permissionKeys: readonly string[];
  readonly sellerAccessState: 'pending' | 'approved' | 'rejected';
  readonly email: string;
  readonly secondFactorActive: boolean;
  /** The previous successful sign-in (ISO 8601, UTC), or null when none is on record. */
  readonly lastSignInAt: string | null;
  readonly displayName: string;
  /** The holder's own IANA time zone, or null when none was chosen. */
  readonly timezone: string | null;
  /** The holder's panel language code, or null when none was chosen. */
  readonly locale: string | null;
  /**
   * The Market's IANA zone (ADR-0005): the zone the API counts report days in. Optional: an API
   * that does not send it yet leaves the dashboard on the seller's own zone.
   */
  readonly marketTimezone?: string;
  readonly csrfToken: string;
}

/**
 * The session read runs before anything of the panel is sent (the `(shell)` layout), so a slow API
 * would leave a blank tab. After this long the read counts as `unavailable` and the page shows its
 * error with a retry. The read is one indexed lookup; 5 s is far above its normal time.
 */
export const SESSION_READ_TIMEOUT_MS = 5_000;

export type SessionRead =
  | { readonly kind: 'signed-in'; readonly session: SellerSession }
  | { readonly kind: 'signed-out' }
  | { readonly kind: 'unavailable' };

/**
 * Reads the actor summary for the page being rendered, with the same mapping and header code as
 * the relay (ADR-0034 decision 4). It never sets a cookie: a rejected session is cleared through
 * the relay by `/session-ended`. One read per request: the `(shell)` layout and the page share it.
 */
export const readSession = cache(async (): Promise<SessionRead> => {
  const read = await serverGet<SellerSession>('identity/seller/session', {
    timeoutMs: SESSION_READ_TIMEOUT_MS,
  });
  if (read.kind === 'ok') return { kind: 'signed-in', session: read.body };
  return read.kind === 'signed-out' ? { kind: 'signed-out' } : { kind: 'unavailable' };
});

/**
 * The session for a page that needs one: signed-out visitors are sent to sign-in (through
 * `/session-ended` when the browser held a cookie the API rejected). `unavailable` is for the
 * page to show as an error.
 */
export async function requireSession(): Promise<
  { readonly kind: 'ok'; readonly session: SellerSession } | { readonly kind: 'unavailable' }
> {
  const read = await readSession();
  if (read.kind === 'signed-out') {
    const jar = await cookies();
    const hadSession = jar.getAll().some((c) => c.name.startsWith('__Host-session-seller-'));
    // Keeps the page asked for, so sign-in can open it again (checked again on the way back).
    const requested = (await headers()).get(REQUESTED_PATH_HEADER);
    redirect(withReturnTo(hadSession ? '/session-ended' : '/sign-in', requested));
  }
  return read.kind === 'signed-in'
    ? { kind: 'ok', session: read.session }
    : { kind: 'unavailable' };
}
