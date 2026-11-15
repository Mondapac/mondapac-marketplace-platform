import 'server-only';
import { redirect } from 'next/navigation';
import { VIEW_PERMISSION as OFFERS_VIEW, type OfferView, type Page } from '../catalog/types.ts';
import { EARNINGS_VIEW_PERMISSION, type Ledger } from '../earnings/types.ts';
import { ORDER_VIEW_PERMISSION, type SellerOrderPage } from '../orders/types.ts';
import { PAYOUT_VIEW_PERMISSION, type PayoutAccount } from '../payout/types.ts';
import { serverGet, type ServerGet } from '../server/server-fetch.ts';
import type { SellerSession } from '../server/session.ts';
import { STOCK_VIEW_PERMISSION, type SourcesView } from '../stock/types.ts';
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
): Promise<Widget<T> | null> | null {
  if (!allowed) return null;
  return read().then((answer) => {
    if (answer.kind === 'ok') return { kind: 'ok', value: answer.body };
    // A refusal means the session may not see this widget after all: hide it, no error card.
    if (answer.kind === 'forbidden') return null;
    if (answer.kind === 'signed-out') redirect('/session-ended');
    return { kind: 'error' };
  });
}

/**
 * Starts every read of the seller dashboard at once (one call each, no per-row calls) and does
 * not wait for them: each card streams in when its own read answers (panel loading L4), and a
 * widget that fails does not fail the others.
 */
export function startSellerDashboard(session: SellerSession): SellerDashboardSources {
  const keys = new Set(session.permissionKeys);
  return {
    orders: widget<SellerOrderPage>(keys.has(ORDER_VIEW_PERMISSION), () =>
      serverGet<SellerOrderPage>(`ordering/seller/orders?limit=${COUNT_LIMIT}`),
    ),
    offers: widget<Page<OfferView>>(keys.has(OFFERS_VIEW), () =>
      serverGet<Page<OfferView>>(`catalog/seller/offers?limit=${COUNT_LIMIT}`),
    ),
    ledger: widget<Ledger>(keys.has(EARNINGS_VIEW_PERMISSION), () =>
      serverGet<Ledger>(`commission-payouts/seller/ledger?limit=${RECENT}`),
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
