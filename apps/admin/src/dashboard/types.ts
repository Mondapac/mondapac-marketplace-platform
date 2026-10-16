// What the admin dashboard reads. Every widget needs the permission its API use case needs; the
// loader asks for a widget only when the session holds that key, so a smaller role gets a smaller
// dashboard and never a refused call.

import type { ReviewPage } from '../catalog/types.ts';
import type { ConnectedAccountPage } from '../payments/types.ts';
import type { PriceHoldPage } from '../pricing/types.ts';
import type { SellerListPage } from '../sellers/types.ts';

/** `GET ordering/admin/orders` (apps/api AdminOrderPageBody); only the fields the dashboard shows. */
export interface DashboardOrder {
  readonly orderId: string;
  readonly status: string;
  readonly total: { readonly amount: string; readonly currency: string };
  readonly createdAt: string;
}

export interface DashboardOrderPage {
  readonly orders: readonly DashboardOrder[];
  readonly nextCursor: string | null;
}

export const ORDER_VIEW_PERMISSION = 'ordering.order.view';
export const ORDER_STATUSES = ['pending-payment', 'confirmed', 'cancelled'] as const;

/** Rows asked for to count a queue; a full page means "this many or more". */
export const COUNT_LIMIT = 50;
/** The accounts route has a fixed page of 25. */
export const ACCOUNTS_PAGE = 25;
/** Rows listed in each recent-activity table. */
export const RECENT = 5;

export type Widget<T> =
  | { readonly kind: 'ok'; readonly value: T }
  /** The read failed: the widget says so in place and the rest of the page shows. */
  | { readonly kind: 'error' };

export interface AdminDashboardData {
  /** A widget is null when the session does not hold the permission its read needs. */
  readonly sellers: Widget<SellerListPage> | null;
  readonly holds: Widget<PriceHoldPage> | null;
  readonly offers: Widget<ReviewPage> | null;
  readonly accounts: Widget<ConnectedAccountPage> | null;
  readonly orders: Widget<DashboardOrderPage> | null;
}
