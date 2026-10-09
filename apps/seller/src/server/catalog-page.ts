import 'server-only';
import { redirect } from 'next/navigation';
import { VIEW_PERMISSION } from '../catalog/types.ts';
import { SETUP_ROOT } from '../setup/steps.ts';
import { serverGet } from './server-fetch.ts';
import { requireSession, type SellerSession } from './session.ts';

export type CatalogPage<T> =
  | { readonly kind: 'ok'; readonly session: SellerSession; readonly body: T }
  | { readonly kind: 'no-access'; readonly session: SellerSession }
  | { readonly kind: 'not-found'; readonly session: SellerSession }
  | { readonly kind: 'unavailable' };

/**
 * The session and one catalog read for a seller catalog page: sellers who are not approved go to
 * the account setup, and a session without the view permission gets the no-access state. The API
 * enforces the same rules; the checks here only spare it a refused call.
 */
export async function loadCatalogPage<T>(path: string): Promise<CatalogPage<T>> {
  const gate = await requireSession();
  if (gate.kind === 'unavailable') return { kind: 'unavailable' };
  const { session } = gate;
  if (session.sellerAccessState !== 'approved') redirect(SETUP_ROOT);
  if (!session.permissionKeys.includes(VIEW_PERMISSION)) return { kind: 'no-access', session };
  const result = await serverGet<T>(path);
  if (result.kind === 'signed-out') redirect('/session-ended');
  if (result.kind === 'ok') return { kind: 'ok', session, body: result.body };
  return result.kind === 'not-found' ? { kind: 'not-found', session } : { kind: 'unavailable' };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

/** A page cursor from the query string; anything but a UUID is ignored. */
export function afterIdParam(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' && isUuid(value) ? value : undefined;
}
