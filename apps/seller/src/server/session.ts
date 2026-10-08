import 'server-only';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { serverGet } from './server-fetch.ts';

export interface SellerSession {
  readonly accountId: string;
  readonly sellerId: string;
  readonly permissionKeys: readonly string[];
  readonly sellerAccessState: 'pending' | 'approved' | 'rejected';
  readonly email: string;
  readonly displayName: string;
  readonly csrfToken: string;
}

export type SessionRead =
  | { readonly kind: 'signed-in'; readonly session: SellerSession }
  | { readonly kind: 'signed-out' }
  | { readonly kind: 'unavailable' };

/**
 * Reads the actor summary for the page being rendered, with the same mapping and header code as
 * the relay (ADR-0034 decision 4). It never sets a cookie: a rejected session is cleared through
 * the relay by `/session-ended`.
 */
export async function readSession(): Promise<SessionRead> {
  const read = await serverGet<SellerSession>('identity/seller/session');
  if (read.kind === 'ok') return { kind: 'signed-in', session: read.body };
  return read.kind === 'signed-out' ? { kind: 'signed-out' } : { kind: 'unavailable' };
}

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
    redirect(hadSession ? '/session-ended' : '/sign-in');
  }
  return read.kind === 'signed-in'
    ? { kind: 'ok', session: read.session }
    : { kind: 'unavailable' };
}
