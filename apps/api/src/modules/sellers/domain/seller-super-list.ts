import { isStateTab, type ListTab } from './seller-list';

// The admin Sellers list as a super list (phase 3, list 15; CLAUDE.md rule 14): the seven tabs of
// the older list (sellers design 7.8) with page numbers or Previous/Next, a sort, the row Actions
// menu and the export. Pure rules; no Market, no I/O.

/**
 * `queue` is the tab's own order: awaiting review by submission (oldest first), incomplete by the
 * latest change (newest first), all and the state tabs by the seller id (a UUID v7, so newest
 * first). `name` is the store-name key (A to Z), on the tabs read from the seller files only. The
 * seller id breaks every tie, in the same direction.
 */
export const SELLER_LIST_SORT_KEYS = ['queue', 'name'] as const;
export type SellerListSortKey = (typeof SELLER_LIST_SORT_KEYS)[number];

export interface SellerListOrder {
  readonly key: SellerListSortKey;
  readonly direction: 'asc' | 'desc';
}

/** The direction of a tab's own order when none is asked for. */
export function queueDirectionOf(tab: ListTab): 'asc' | 'desc' {
  return tab === 'awaiting-review' ? 'asc' : 'desc';
}

/** Whether a tab takes this order: a state tab is paged by `identity`, newest first only. */
export function orderProblem(tab: ListTab, order: SellerListOrder): 'sort' | 'direction' | null {
  if (!isStateTab(tab)) return null;
  if (order.key !== 'queue') return 'sort';
  return order.direction === 'desc' ? null : 'direction';
}

/** The row actions of the list. Open (the seller's file) always; nothing else in this list yet. */
export const SELLER_LIST_ROW_ACTIONS = ['open'] as const;
export type SellerListRowAction = (typeof SELLER_LIST_ROW_ACTIONS)[number];

/** The columns an export may add, in the order the panel's column picker lists them. */
export const SELLER_LIST_EXPORT_COLUMNS = ['seller-id'] as const;
export type SellerListExportColumn = (typeof SELLER_LIST_EXPORT_COLUMNS)[number];

/** The ids `identity` pages per call (its contract's maximum). */
export const STATE_TAB_CALL_SIZE = 100;
/** A state tab page is reached by walking `identity`'s pages: at most this many calls. */
export const STATE_TAB_MAX_CALLS = 20;
/** The deepest row of a state tab a page can show (20 calls of 100). */
export const STATE_TAB_MAX_ROWS = STATE_TAB_CALL_SIZE * STATE_TAB_MAX_CALLS;
