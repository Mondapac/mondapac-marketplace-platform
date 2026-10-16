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
  type SellerDashboardData,
  type Widget,
} from './types.ts';

/**
 * One widget: not asked for without its key, hidden when the API still says forbidden, an
 * in-place error for any other failure. A rejected
 * session sends the whole page to sign-in.
 */
async function widget<T>(
  allowed: boolean,
  read: () => Promise<ServerGet<T>>,
): Promise<{ readonly widget: Widget<T> | null; readonly signedOut: boolean }> {
  if (!allowed) return { widget: null, signedOut: false };
  const answer = await read();
  if (answer.kind === 'ok') return { widget: { kind: 'ok', value: answer.body }, signedOut: false };
  // A refusal means the session may not see this widget after all: hide it, no error card.
  if (answer.kind === 'forbidden') return { widget: null, signedOut: false };
  return { widget: { kind: 'error' }, signedOut: answer.kind === 'signed-out' };
}

/**
 * Every widget of the seller dashboard, read in parallel (one call each, no per-row calls). A
 * widget that fails does not fail the others.
 */
export async function loadSellerDashboard(session: SellerSession): Promise<SellerDashboardData> {
  const keys = new Set(session.permissionKeys);
  const [orders, offers, ledger, payout, sources, lowStock] = await Promise.all([
    widget<SellerOrderPage>(keys.has(ORDER_VIEW_PERMISSION), () =>
      serverGet<SellerOrderPage>(`ordering/seller/orders?limit=${COUNT_LIMIT}`),
    ),
    widget<Page<OfferView>>(keys.has(OFFERS_VIEW), () =>
      serverGet<Page<OfferView>>(`catalog/seller/offers?limit=${COUNT_LIMIT}`),
    ),
    widget<Ledger>(keys.has(EARNINGS_VIEW_PERMISSION), () =>
      serverGet<Ledger>(`commission-payouts/seller/ledger?limit=${RECENT}`),
    ),
    widget<PayoutAccount>(keys.has(PAYOUT_VIEW_PERMISSION), () =>
      serverGet<PayoutAccount>('payments/seller/payout-account'),
    ),
    widget<SourcesView>(keys.has(STOCK_VIEW_PERMISSION), () =>
      serverGet<SourcesView>('inventory/seller/sources'),
    ),
    // A full page of signals, so the few shown are the latest ones.
    widget<LowStockPage>(keys.has(STOCK_VIEW_PERMISSION), () =>
      serverGet<LowStockPage>(`inventory/seller/low-stock?limit=${COUNT_LIMIT}`),
    ),
  ]);
  if ([orders, offers, ledger, payout, sources, lowStock].some((item) => item.signedOut)) {
    redirect('/session-ended');
  }
  return {
    orders: orders.widget,
    offers: offers.widget,
    ledger: ledger.widget,
    payout: payout.widget,
    sources: sources.widget,
    lowStock: lowStock.widget,
  };
}
