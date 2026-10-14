import 'server-only';
import { redirect } from 'next/navigation';
import {
  ORDER_VIEW_PERMISSION,
  OWN_FEE_PERMISSION,
  type OwnFee,
  type SellerOrderPage,
} from '../orders/types.ts';
import { SETUP_ROOT } from '../setup/steps.ts';
import { serverGet } from './server-fetch.ts';
import { requireSession, type SellerSession } from './session.ts';

export type OrdersPage =
  | {
      readonly kind: 'ok';
      readonly session: SellerSession;
      readonly page: SellerOrderPage;
      /** Null when the platform has not set a fee yet, or the role cannot see it. */
      readonly fee: OwnFee | null;
    }
  | { readonly kind: 'no-access'; readonly session: SellerSession }
  | { readonly kind: 'unavailable' };

/** The session, the first page of paid orders and the seller's delivery fee. */
export async function loadOrdersPage(): Promise<OrdersPage> {
  const gate = await requireSession();
  if (gate.kind === 'unavailable') return { kind: 'unavailable' };
  const { session } = gate;
  if (session.sellerAccessState !== 'approved') redirect(SETUP_ROOT);
  if (!session.permissionKeys.includes(ORDER_VIEW_PERMISSION)) {
    return { kind: 'no-access', session };
  }
  const canSeeFee = session.permissionKeys.includes(OWN_FEE_PERMISSION);
  const [orders, fee] = await Promise.all([
    serverGet<SellerOrderPage>('ordering/seller/orders?limit=20'),
    canSeeFee ? serverGet<OwnFee>('shipping/seller/flat-fee') : Promise.resolve(null),
  ]);
  if (orders.kind === 'signed-out' || fee?.kind === 'signed-out') redirect('/session-ended');
  if (orders.kind !== 'ok') return { kind: 'unavailable' };
  return {
    kind: 'ok',
    session,
    page: orders.body,
    fee: fee?.kind === 'ok' ? fee.body : null,
  };
}
