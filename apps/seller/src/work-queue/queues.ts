// The seller's tasks (dashboards upgrade phase 2, design section 3): what the panel knows of each
// queue `GET dashboard/seller/tasks` may answer. The API decides which queues a member sees (each
// needs its owner's key) and always counts the session's own store; the panel only gives each key
// its words, its page and how it signals. A key the panel does not know yet is left out.

import type { WorkQueueAnswer, WorkQueueSignal } from '@mondapac/ui';
import { EARNINGS_VIEW_PERMISSION } from '../earnings/types.ts';
import { ORDER_VIEW_PERMISSION } from '../orders/types.ts';
import { PAYOUT_VIEW_PERMISSION } from '../payout/types.ts';
import { REVIEWS_VIEW_PERMISSION } from '../reviews/types.ts';

export const SELLER_TASKS_PATH = 'dashboard/seller/tasks';

export interface SellerQueue {
  readonly key: string;
  /** The key the API binds the queue to (dashboard.module.ts); the loader asks only with one. */
  readonly requires: string;
  readonly href: string;
  readonly signal: WorkQueueSignal;
  /**
   * Whether the row says how long its oldest item has waited ("Oldest 3h"). Off where that age is
   * not what the seller acts on: an order to ship today is paid at some time, and only its
   * ready-by time matters, which the API does not give yet (FE-123).
   */
  readonly showsAge: boolean;
}

/** In the API's order within a level (dashboard.module.ts `workQueueSources`, panel seller). */
export const SELLER_QUEUES: readonly SellerQueue[] = [
  // Critical.
  {
    key: 'ordering.late-orders',
    requires: ORDER_VIEW_PERMISSION,
    href: '/orders',
    signal: 'age',
    showsAge: true,
  },
  {
    key: 'commission-payouts.dispute-reply-needed',
    requires: EARNINGS_VIEW_PERMISSION,
    href: '/earnings',
    signal: 'deadline',
    showsAge: true,
  },
  {
    // 0 or 1: the payout account is restricted, or its setup is not finished (both count).
    key: 'payments.payouts-blocked',
    requires: PAYOUT_VIEW_PERMISSION,
    href: '/accounting/payout-account',
    signal: 'fix',
    showsAge: true,
  },
  // Today.
  {
    key: 'ordering.to-ship-today',
    requires: ORDER_VIEW_PERMISSION,
    href: '/orders',
    signal: 'age',
    showsAge: false,
  },
  {
    key: 'ordering.pickups-uncollected',
    requires: ORDER_VIEW_PERMISSION,
    href: '/orders',
    signal: 'age',
    showsAge: true,
  },
  {
    // Dispute holds are counted here too: a dispute shows in both queues.
    key: 'commission-payouts.payout-holds',
    requires: EARNINGS_VIEW_PERMISSION,
    href: '/earnings',
    signal: 'age',
    showsAge: true,
  },
  // Review.
  {
    // The Reviews page opens on every review: it does not read a view from the address (FE-124).
    key: 'reviews.unanswered',
    requires: REVIEWS_VIEW_PERMISSION,
    href: '/reviews',
    signal: 'age',
    showsAge: true,
  },
];

const BY_KEY = new Map(SELLER_QUEUES.map((queue) => [queue.key, queue]));

export const sellerQueue = (key: string): SellerQueue | null => BY_KEY.get(key) ?? null;

/** Whether the session holds the key of at least one queue (else the read is not made at all). */
export function mayHaveTasks(permissionKeys: readonly string[]): boolean {
  const keys = new Set(permissionKeys);
  return SELLER_QUEUES.some((queue) => keys.has(queue.requires));
}

/** The message key of a queue's label: its API key with the dot as a nesting level. */
export const labelKey = (key: string): string => `queue.${key}`;

export type { WorkQueueAnswer };
