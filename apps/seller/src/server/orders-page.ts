import 'server-only';
import { redirect } from 'next/navigation';
import {
  ORDER_VIEW_PERMISSION,
  type SellerOrderPage,
  type SellerOrderView,
} from '../orders/types.ts';
import { SETUP_ROOT } from '../setup/steps.ts';
import { serverGet } from './server-fetch.ts';
import { requireSession, type SellerSession } from './session.ts';

export type OrdersPage =
  | {
      readonly kind: 'ok';
      readonly session: SellerSession;
      readonly page: SellerOrderPage;
    }
  | { readonly kind: 'no-access'; readonly session: SellerSession }
  | { readonly kind: 'unavailable' };

/** The session and the first page of paid orders. */
export async function loadOrdersPage(): Promise<OrdersPage> {
  const gate = await requireSession();
  if (gate.kind === 'unavailable') return { kind: 'unavailable' };
  const { session } = gate;
  if (session.sellerAccessState !== 'approved') redirect(SETUP_ROOT);
  if (!session.permissionKeys.includes(ORDER_VIEW_PERMISSION)) {
    return { kind: 'no-access', session };
  }
  const orders = await serverGet<SellerOrderPage>('ordering/seller/orders?limit=20');
  if (orders.kind === 'signed-out') redirect('/session-ended');
  if (orders.kind !== 'ok') return { kind: 'unavailable' };
  return { kind: 'ok', session, page: orders.body };
}

export type OrderDetailPage =
  | {
      readonly kind: 'ok';
      readonly session: SellerSession;
      readonly order: SellerOrderView;
    }
  | { readonly kind: 'no-access'; readonly session: SellerSession }
  | { readonly kind: 'not-found'; readonly session: SellerSession }
  | { readonly kind: 'unavailable' };

/** The session and one paid order; the API names each line (product and variant). */
export async function loadOrderDetailPage(sellerOrderId: string): Promise<OrderDetailPage> {
  const gate = await requireSession();
  if (gate.kind === 'unavailable') return { kind: 'unavailable' };
  const { session } = gate;
  if (session.sellerAccessState !== 'approved') redirect(SETUP_ROOT);
  if (!session.permissionKeys.includes(ORDER_VIEW_PERMISSION)) {
    return { kind: 'no-access', session };
  }
  const result = await serverGet<SellerOrderView>(`ordering/seller/orders/${sellerOrderId}`);
  if (result.kind === 'signed-out') redirect('/session-ended');
  if (result.kind === 'not-found') return { kind: 'not-found', session };
  if (result.kind !== 'ok') return { kind: 'unavailable' };
  return { kind: 'ok', session, order: result.body };
}
