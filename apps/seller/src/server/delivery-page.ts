import 'server-only';
import { redirect } from 'next/navigation';
import { STORE_SETTINGS_EDIT_PERMISSION, type DeliverySettingsView } from '../delivery/types.ts';
import { SETUP_ROOT } from '../setup/steps.ts';
import { serverGet } from './server-fetch.ts';
import { requireSession, type SellerSession } from './session.ts';

export type DeliveryPage =
  | { readonly kind: 'ok'; readonly session: SellerSession; readonly view: DeliverySettingsView }
  | { readonly kind: 'no-access'; readonly session: SellerSession }
  | { readonly kind: 'unavailable' };

/** The session and the saved delivery terms for the Delivery settings page. */
export async function loadDeliveryPage(): Promise<DeliveryPage> {
  const gate = await requireSession();
  if (gate.kind === 'unavailable') return { kind: 'unavailable' };
  const { session } = gate;
  if (session.sellerAccessState !== 'approved') redirect(SETUP_ROOT);
  if (!session.permissionKeys.includes(STORE_SETTINGS_EDIT_PERMISSION)) {
    return { kind: 'no-access', session };
  }
  const settings = await serverGet<DeliverySettingsView>('sellers/store-settings');
  if (settings.kind === 'signed-out') redirect('/session-ended');
  if (settings.kind === 'forbidden') return { kind: 'no-access', session };
  if (settings.kind !== 'ok') return { kind: 'unavailable' };
  return {
    kind: 'ok',
    session,
    view: { version: settings.body.version, delivery: settings.body.delivery },
  };
}
