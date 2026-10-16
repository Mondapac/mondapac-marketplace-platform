// What the seller dashboard reads. Every widget needs the permission its API use case needs; the
// loader asks for a widget only when the session holds that key, so a staff member with a few
// keys gets a smaller dashboard and never a refused call.

import type { OfferView, Page } from '../catalog/types.ts';
import type { Ledger } from '../earnings/types.ts';
import type { SellerOrderPage } from '../orders/types.ts';
import type { PayoutAccount } from '../payout/types.ts';
import type { SourcesView } from '../stock/types.ts';

/** Rows asked for to count a list; a full page means "this many or more". */
export const COUNT_LIMIT = 50;
/** Rows listed in each recent-activity table. */
export const RECENT = 5;

export type Widget<T> =
  | { readonly kind: 'ok'; readonly value: T }
  /** The read failed: the widget says so in place and the rest of the page shows. */
  | { readonly kind: 'error' };

/** One sell unit running low or out (GET inventory/seller/low-stock). The API sends no threshold. */
export interface LowStockItem {
  readonly offerId: string;
  readonly variantId: string;
  readonly status: string;
  /** Set for `low` only. */
  readonly onlyLeft: number | null;
  readonly changedAt: string;
  /** Null when unpublished or the name lookup failed. */
  readonly productName: string | null;
  readonly variantLabel: string | null;
}

export interface LowStockPage {
  readonly items: readonly LowStockItem[];
  readonly nextCursor: string | null;
}

export interface SellerDashboardData {
  /** A widget is null when the session does not hold the permission its read needs. */
  readonly orders: Widget<SellerOrderPage> | null;
  readonly offers: Widget<Page<OfferView>> | null;
  readonly ledger: Widget<Ledger> | null;
  readonly payout: Widget<PayoutAccount> | null;
  readonly sources: Widget<SourcesView> | null;
  /** Needs the same key as `sources` (inventory.stock.view). */
  readonly lowStock: Widget<LowStockPage> | null;
}
