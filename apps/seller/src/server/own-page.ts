import 'server-only';
import { redirect } from 'next/navigation';
import { SETUP_ROOT } from '../setup/steps.ts';
import { serverGet } from './server-fetch.ts';
import { requireSession, type SellerSession } from './session.ts';

export type OwnPage<T> =
  | { readonly kind: 'ok'; readonly session: SellerSession; readonly body: T }
  | { readonly kind: 'not-found'; readonly session: SellerSession }
  | { readonly kind: 'unavailable' };

/**
 * The session and one read of the seller's own data (a route with no permission key: the API
 * answers for the seller of the session). Sellers who are not approved go to the account setup.
 */
export async function loadOwnPage<T>(path: string): Promise<OwnPage<T>> {
  const gate = await requireSession();
  if (gate.kind === 'unavailable') return { kind: 'unavailable' };
  const { session } = gate;
  if (session.sellerAccessState !== 'approved') redirect(SETUP_ROOT);
  const result = await serverGet<T>(path);
  if (result.kind === 'signed-out') redirect('/session-ended');
  if (result.kind === 'ok') return { kind: 'ok', session, body: result.body };
  return result.kind === 'not-found' ? { kind: 'not-found', session } : { kind: 'unavailable' };
}
