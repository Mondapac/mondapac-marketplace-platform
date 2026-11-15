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
  type AdminDashboardSources,
  type DashboardOrderPage,
  type Widget,
} from './types.ts';
import type { ReviewPage } from '../catalog/types.ts';
import type { ConnectedAccountPage } from '../payments/types.ts';
import type { PriceHoldPage } from '../pricing/types.ts';

/**
 * One widget: not asked for without its key (null), else a read that answers on its own. Hidden
 * when the API still says forbidden, an in-place error for any other failure. A rejected session
 * sends the whole page to sign-in.
 */
function widget<T>(
  allowed: boolean,
  read: () => Promise<ServerGet<T>>,
): Promise<Widget<T> | null> | null {
  if (!allowed) return null;
  return read().then((answer) => {
    if (answer.kind === 'ok') return { kind: 'ok', value: answer.body };
    if (answer.kind === 'signed-out') redirect('/session-ended');
    if (answer.kind === 'forbidden') return null;
    return { kind: 'error' };
  });
}

/**
 * Starts every read of the admin dashboard at once (one call each, no per-row calls) and does
 * not wait for them: each card streams in when its own read answers (panel loading L4), and a
 * widget that fails does not fail the others.
 */
export function startAdminDashboard(session: AdminSession): AdminDashboardSources {
  const keys = new Set(session.permissionKeys);
  return {
    sellers: widget<SellerListPage>(keys.has(SELLERS_VIEW), () =>
      serverGet<SellerListPage>('sellers/admin/list', {
        post: {
          body: { tab: 'awaiting-review', limit: RECENT },
          csrfToken: session.csrfToken,
        },
      }),
    ),
    holds: widget<PriceHoldPage>(keys.has(HOLDS_VIEW), () =>
      serverGet<PriceHoldPage>(`pricing/admin/price-holds?limit=${COUNT_LIMIT}`),
    ),
    offers: widget<ReviewPage>(keys.has(OFFERS_VIEW), () =>
      serverGet<ReviewPage>(`catalog/admin/review-queue?limit=${COUNT_LIMIT}`),
    ),
    accounts: widget<ConnectedAccountPage>(keys.has(ACCOUNTS_VIEW), () =>
      serverGet<ConnectedAccountPage>('payments/admin/connected-accounts?status=restricted'),
    ),
    orders: widget<DashboardOrderPage>(keys.has(ORDER_VIEW_PERMISSION), () =>
      serverGet<DashboardOrderPage>(`ordering/admin/orders?limit=${RECENT}`),
    ),
  };
}
