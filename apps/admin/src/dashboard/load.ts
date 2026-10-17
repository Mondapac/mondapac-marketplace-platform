import 'server-only';
import { redirect } from 'next/navigation';
import { VIEW_PERMISSION as OFFERS_VIEW } from '../catalog/types.ts';
import { VIEW_PERMISSION as ACCOUNTS_VIEW } from '../payments/types.ts';
import { VIEW_PERMISSION as HOLDS_VIEW } from '../pricing/types.ts';
import { serverGet, type ServerGet } from '../server/server-fetch.ts';
import type { AdminSession } from '../server/session.ts';
import { LIST_PERMISSION as SELLERS_VIEW, type SellerListPage } from '../sellers/types.ts';
import {
  COUNT_LIMIT,
  ORDER_VIEW_PERMISSION,
  RECENT,
  type AdminDashboardData,
  type DashboardOrderPage,
  type Widget,
} from './types.ts';
import type { ReviewPage } from '../catalog/types.ts';
import type { ConnectedAccountPage } from '../payments/types.ts';
import type { PriceHoldPage } from '../pricing/types.ts';

/**
 * One widget: not asked for without its key, hidden when the API still says forbidden, an
 * in-place error for any other failure. A rejected session sends the whole page to sign-in.
 */
async function widget<T>(
  allowed: boolean,
  read: () => Promise<ServerGet<T>>,
): Promise<{ readonly widget: Widget<T> | null; readonly signedOut: boolean }> {
  if (!allowed) return { widget: null, signedOut: false };
  const answer = await read();
  if (answer.kind === 'ok') return { widget: { kind: 'ok', value: answer.body }, signedOut: false };
  if (answer.kind === 'signed-out') return { widget: null, signedOut: true };
  if (answer.kind === 'forbidden') return { widget: null, signedOut: false };
  return { widget: { kind: 'error' }, signedOut: false };
}

/**
 * Every widget of the admin dashboard, read in parallel (one call each, no per-row calls). A
 * widget that fails does not fail the others.
 */
export async function loadAdminDashboard(session: AdminSession): Promise<AdminDashboardData> {
  const keys = new Set(session.permissionKeys);
  const [sellers, holds, offers, accounts, orders] = await Promise.all([
    widget<SellerListPage>(keys.has(SELLERS_VIEW), () =>
      serverGet<SellerListPage>('sellers/admin/list', {
        post: {
          body: { tab: 'awaiting-review', limit: RECENT },
          csrfToken: session.csrfToken,
        },
      }),
    ),
    widget<PriceHoldPage>(keys.has(HOLDS_VIEW), () =>
      serverGet<PriceHoldPage>(`pricing/admin/price-holds?limit=${COUNT_LIMIT}`),
    ),
    widget<ReviewPage>(keys.has(OFFERS_VIEW), () =>
      serverGet<ReviewPage>(`catalog/admin/review-queue?limit=${COUNT_LIMIT}`),
    ),
    widget<ConnectedAccountPage>(keys.has(ACCOUNTS_VIEW), () =>
      serverGet<ConnectedAccountPage>('payments/admin/connected-accounts?status=restricted'),
    ),
    widget<DashboardOrderPage>(keys.has(ORDER_VIEW_PERMISSION), () =>
      serverGet<DashboardOrderPage>(`ordering/admin/orders?limit=${RECENT}`),
    ),
  ]);
  const all = [sellers, holds, offers, accounts, orders];
  if (all.some((item) => item.signedOut)) redirect('/session-ended');
  return {
    sellers: sellers.widget,
    holds: holds.widget,
    offers: offers.widget,
    accounts: accounts.widget,
    orders: orders.widget,
  };
}
