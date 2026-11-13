import 'server-only';
import { redirect } from 'next/navigation';
import {
  ORDER_VIEW_PERMISSION,
  type SellerOrderPage,
  type SellerOrderView,
} from '../orders/types.ts';
import type { OwnDispute } from '../disputes/types.ts';
import { SETUP_ROOT } from '../setup/steps.ts';
import { loadOwnDisputes } from './own-disputes.ts';
import { serverGet } from './server-fetch.ts';
import { requireSession, type SellerSession } from './session.ts';
import { queryOf, type ListPaging } from '../orders/orders-query.ts';

export type OrdersPage =
  | {
      readonly kind: 'ok';
      readonly session: SellerSession;
      readonly page: SellerOrderPage;
      readonly paging: ListPaging;
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
  // List paging (settings): page numbers only when the Market says so. A value that cannot be
  // read means Previous and next, which works for any number of orders.
  const mode = await serverGet<{ readonly listPaging: string }>('settings/seller/list-paging');
  const paging: ListPaging =
    mode.kind === 'ok' && mode.body.listPaging === 'pages' ? 'pages' : 'prev-next';
  const orders = await serverGet<SellerOrderPage>(
    queryOf(
      'all',
      { from: '', to: '' },
      // No days on the first page, so the zone reads nothing yet.
      'UTC',
      paging === 'pages' ? { paging, page: 1, sort: 'newest' } : { paging, cursor: null },
    ),
  );
  if (orders.kind === 'signed-out') redirect('/session-ended');
  if (orders.kind !== 'ok') return { kind: 'unavailable' };
  return { kind: 'ok', session, page: orders.body, paging };
}

export type OrderDetailPage =
  | {
      readonly kind: 'ok';
      readonly session: SellerSession;
      readonly order: SellerOrderView;
      /** The dispute that holds or held this order, if any. */
      readonly dispute: OwnDispute | null;
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
  const [result, disputes] = await Promise.all([
    serverGet<SellerOrderView>(`ordering/seller/orders/${sellerOrderId}`),
    loadOwnDisputes(),
  ]);
  if (result.kind === 'signed-out') redirect('/session-ended');
  if (result.kind === 'not-found') return { kind: 'not-found', session };
  if (result.kind !== 'ok') return { kind: 'unavailable' };
  return {
    kind: 'ok',
    session,
    order: result.body,
    dispute: disputes.find((entry) => entry.sellerOrderId === sellerOrderId) ?? null,
  };
}
