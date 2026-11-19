import 'server-only';
import { redirect } from 'next/navigation';
import {
  ORDER_VIEW_PERMISSION,
  type ActivityEvent,
  type SellerNote,
  type SellerOrderPage,
  type SellerOrderView,
  packingSlipAvailable,
} from '../orders/types.ts';
import type { OwnDispute } from '../disputes/types.ts';
import { SETUP_ROOT } from '../setup/steps.ts';
import { loadOwnDisputes } from './own-disputes.ts';
import { serverGet } from './server-fetch.ts';
import { requireSession, type SellerSession } from './session.ts';
import { firstPagePath, type ListPaging } from '../orders/orders-query.ts';

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
  const orders = await serverGet<SellerOrderPage>(firstPagePath(paging));
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
      /** The shop's notes on the order; null when the list did not load. */
      readonly notes: readonly SellerNote[] | null;
      /** The order timeline, oldest first; null when it did not load. */
      readonly activity: readonly ActivityEvent[] | null;
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
  const [result, disputes, notes, activity] = await Promise.all([
    serverGet<SellerOrderView>(`ordering/seller/orders/${sellerOrderId}`),
    loadOwnDisputes(),
    serverGet<{ readonly notes: readonly SellerNote[] }>(
      `ordering/seller/orders/${sellerOrderId}/notes`,
    ),
    serverGet<{ readonly events: readonly ActivityEvent[] }>(
      `ordering/seller/orders/${sellerOrderId}/activity`,
    ),
  ]);
  if (result.kind === 'signed-out') redirect('/session-ended');
  if (result.kind === 'not-found') return { kind: 'not-found', session };
  if (result.kind !== 'ok') return { kind: 'unavailable' };
  return {
    kind: 'ok',
    session,
    order: result.body,
    dispute: disputes.find((entry) => entry.sellerOrderId === sellerOrderId) ?? null,
    // The notes and the timeline are extras: when they cannot be read the order still shows.
    notes: notes.kind === 'ok' ? notes.body.notes : null,
    activity: activity.kind === 'ok' ? activity.body.events : null,
  };
}

/** At most this many orders on one printed set of slips (the list's selection limit). */
export const SLIPS_MAX = 50;

export type PackingSlipsPage =
  | {
      readonly kind: 'ok';
      readonly session: SellerSession;
      /** The orders that have a slip to print, in the order they were asked for. */
      readonly orders: readonly SellerOrderView[];
      /** How many of the asked orders have none (sent, refunded in full, not the shop's). */
      readonly skipped: number;
      /** How many could not be read now (a failed read, not a missing slip): reload to try again. */
      readonly unreadable: number;
    }
  | { readonly kind: 'no-access'; readonly session: SellerSession }
  | { readonly kind: 'unavailable' };

/**
 * The orders of a selection, each read like the single order page (so ownership and the paid
 * rule are that route's): the address and phone of an order already sent never reach the browser.
 * An id that cannot be read counts as skipped, whatever the reason, so a foreign id learns nothing.
 */
export async function loadPackingSlips(ids: readonly string[]): Promise<PackingSlipsPage> {
  const gate = await requireSession();
  if (gate.kind === 'unavailable') return { kind: 'unavailable' };
  const { session } = gate;
  if (session.sellerAccessState !== 'approved') redirect(SETUP_ROOT);
  if (!session.permissionKeys.includes(ORDER_VIEW_PERMISSION)) {
    return { kind: 'no-access', session };
  }
  const unique = [...new Set(ids)].slice(0, SLIPS_MAX);
  const results = await Promise.all(
    unique.map((id) => serverGet<SellerOrderView>(`ordering/seller/orders/${id}`)),
  );
  if (results.some((result) => result.kind === 'signed-out')) redirect('/session-ended');
  const orders = results.flatMap((result) =>
    result.kind === 'ok' && packingSlipAvailable(result.body) ? [result.body] : [],
  );
  // A read that failed says nothing about the order: it is counted apart from "no slip".
  const unreadable = results.filter((result) => result.kind === 'unavailable').length;
  return {
    kind: 'ok',
    session,
    orders,
    skipped: unique.length - orders.length - unreadable,
    unreadable,
  };
}
