// The seller's tasks (dashboards upgrade phase 2, design section 3): what the panel knows of each
// queue `GET dashboard/seller/tasks` may answer. The API decides which queues a member sees (each
// needs its owner's key) and always counts the session's own store; the panel only gives each key
// its words, its page and how it signals. A key the panel does not know yet is left out.

import type { WorkQueueAnswer, WorkQueueSignal } from '@mondapac/ui';

export const SELLER_TASKS_PATH = 'dashboard/seller/tasks';

export interface SellerQueue {
  readonly key: string;
  /** The key the API binds the queue to (dashboard.module.ts); the loader asks only with one. */
  readonly requires: string;
  readonly href: string;
  readonly signal: WorkQueueSignal;
}

/** In the API's order within a level (dashboard.module.ts `workQueueSources`, panel seller). */
export const SELLER_QUEUES: readonly SellerQueue[] = [
  // Critical.
  {
    key: 'ordering.late-orders',
    requires: 'ordering.seller-order.view',
    href: '/orders',
    signal: 'age',
  },
  {
    key: 'commission-payouts.dispute-reply-needed',
    requires: 'commission-payouts.earnings.view',
    href: '/earnings',
    signal: 'deadline',
  },
  {
    // 0 or 1: the payout account is restricted, or its setup is not finished (both count).
    key: 'payments.payouts-blocked',
    requires: 'payments.payout-account.view',
    href: '/accounting/payout-account',
    signal: 'fix',
  },
  // Today.
  {
    key: 'ordering.to-ship-today',
    requires: 'ordering.seller-order.view',
    href: '/orders',
    signal: 'age',
  },
  {
    key: 'ordering.pickups-uncollected',
    requires: 'ordering.seller-order.view',
    href: '/orders',
    signal: 'age',
  },
  {
    // Dispute holds are counted here too: a dispute shows in both queues.
    key: 'commission-payouts.payout-holds',
    requires: 'commission-payouts.earnings.view',
    href: '/earnings',
    signal: 'age',
  },
  // Review.
  { key: 'reviews.unanswered', requires: 'reviews.seller.view', href: '/reviews', signal: 'age' },
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
