import 'server-only';
import { redirect } from 'next/navigation';
import { PAYOUT_VIEW_PERMISSION, type PayoutAccount } from '../payout/types.ts';
import { SETUP_ROOT } from '../setup/steps.ts';
import { serverGet } from './server-fetch.ts';
import { requireSession, type SellerSession } from './session.ts';

export type PayoutPage =
  | { readonly kind: 'ok'; readonly session: SellerSession; readonly account: PayoutAccount }
  | { readonly kind: 'no-access'; readonly session: SellerSession }
  /** `session` is set when only the data failed to load: the page then keeps its settings shell. */
  | { readonly kind: 'unavailable'; readonly session?: SellerSession };

/** The session and the seller's payout account. Only the Seller Owner holds the view key. */
export async function loadPayoutPage(): Promise<PayoutPage> {
  const gate = await requireSession();
  if (gate.kind === 'unavailable') return { kind: 'unavailable' };
  const { session } = gate;
  if (session.sellerAccessState !== 'approved') redirect(SETUP_ROOT);
  if (!session.permissionKeys.includes(PAYOUT_VIEW_PERMISSION)) {
    return { kind: 'no-access', session };
  }
  const read = await serverGet<PayoutAccount>('payments/seller/payout-account');
  if (read.kind === 'signed-out') redirect('/session-ended');
  if (read.kind !== 'ok') return { kind: 'unavailable', session };
  return { kind: 'ok', session, account: read.body };
}
