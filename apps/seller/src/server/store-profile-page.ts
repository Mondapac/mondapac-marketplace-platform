import 'server-only';
import { redirect } from 'next/navigation';
import { SETUP_ROOT } from '../setup/steps.ts';
import { STORE_PROFILE_VIEW_PERMISSION, type StoreProfileView } from '../store-profile/types.ts';
import { serverGet } from './server-fetch.ts';
import { requireSession, type SellerSession } from './session.ts';

export type StoreProfilePage =
  | { readonly kind: 'ok'; readonly session: SellerSession; readonly view: StoreProfileView }
  | { readonly kind: 'no-access'; readonly session: SellerSession }
  /** `session` is set when only the profile failed to load: the page then keeps its settings shell. */
  | { readonly kind: 'unavailable'; readonly session?: SellerSession };

/** The session and the store profile for the Store profile settings page. */
export async function loadStoreProfilePage(): Promise<StoreProfilePage> {
  const gate = await requireSession();
  if (gate.kind === 'unavailable') return { kind: 'unavailable' };
  const { session } = gate;
  if (session.sellerAccessState !== 'approved') redirect(SETUP_ROOT);
  if (!session.permissionKeys.includes(STORE_PROFILE_VIEW_PERMISSION)) {
    return { kind: 'no-access', session };
  }
  const profile = await serverGet<StoreProfileView>('sellers/store-profile');
  if (profile.kind === 'signed-out') redirect('/session-ended');
  if (profile.kind !== 'ok') return { kind: 'unavailable', session };
  return { kind: 'ok', session, view: profile.body };
}
