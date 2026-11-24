import 'server-only';
import { workQueueRows } from '@mondapac/ui';
import { redirect } from 'next/navigation';
import { ORDER_VIEW_PERMISSION, type SellerOrderCursorPage } from '../orders/types.ts';
import { PAYOUT_VIEW_PERMISSION, type PayoutAccount } from '../payout/types.ts';
import { serverGet, type ServerGet } from '../server/server-fetch.ts';
import type { SellerSession } from '../server/session.ts';
import { STOCK_VIEW_PERMISSION, type SourcesView } from '../stock/types.ts';
import {
  mayHaveTasks,
  SELLER_TASKS_PATH,
  sellerQueue,
  type WorkQueueAnswer,
} from '../work-queue/queues.ts';
import {
  COUNT_LIMIT,
  RECENT,
  type LowStockPage,
  type SellerDashboardSources,
  type Widget,
} from './types.ts';

/**
 * One widget: not asked for without its key (null), else a read that answers on its own. Hidden
 * when the API still says forbidden, an in-place error for any other failure. A rejected session
 * sends the whole page to sign-in.
 */
function widget<T>(
  allowed: boolean,
  read: () => Promise<ServerGet<T>>,
  shown: (value: T) => boolean = () => true,
): Promise<Widget<T> | null> | null {
  if (!allowed) return null;
  const answer = read().then((answer): Widget<T> | null => {
    if (answer.kind === 'ok') return shown(answer.body) ? { kind: 'ok', value: answer.body } : null;
    // A refusal means the session may not see this widget after all: hide it, no error card.
    if (answer.kind === 'forbidden') return null;
    if (answer.kind === 'signed-out') redirect('/session-ended');
    return { kind: 'error' };
  });
  // The page reads it while it streams; until a card does, a rejection (the redirect) is not unhandled.
  answer.catch(() => undefined);
  return answer;
}

/**
 * Starts every read of the seller dashboard at once (one call each, no per-row calls) and does
 * not wait for them: each card streams in when its own read answers (panel loading L4), and a
 * widget that fails does not fail the others.
 */
export function startSellerDashboard(session: SellerSession): SellerDashboardSources {
  const keys = new Set(session.permissionKeys);
  return {
    // No key of its own: asked when the member holds a key of one task, and absent when the API
    // shows no task the panel knows. Always the session's own store (the API reads it).
    tasks: widget<WorkQueueAnswer>(
      mayHaveTasks(session.permissionKeys),
      () => serverGet<WorkQueueAnswer>(SELLER_TASKS_PATH),
      (answer) =>
        workQueueRows(answer, (key) =>
          sellerQueue(key) === null ? null : { label: key, href: null, signal: 'age' },
        ).length > 0,
    ),
    orders: widget<SellerOrderCursorPage>(keys.has(ORDER_VIEW_PERMISSION), () =>
      serverGet<SellerOrderCursorPage>(`ordering/seller/orders?limit=${RECENT}`),
    ),
    payout: widget<PayoutAccount>(keys.has(PAYOUT_VIEW_PERMISSION), () =>
      serverGet<PayoutAccount>('payments/seller/payout-account'),
    ),
    sources: widget<SourcesView>(keys.has(STOCK_VIEW_PERMISSION), () =>
      serverGet<SourcesView>('inventory/seller/sources'),
    ),
    // A full page of signals, so the few shown are the latest ones.
    lowStock: widget<LowStockPage>(keys.has(STOCK_VIEW_PERMISSION), () =>
      serverGet<LowStockPage>(`inventory/seller/low-stock?limit=${COUNT_LIMIT}`),
    ),
  };
}
