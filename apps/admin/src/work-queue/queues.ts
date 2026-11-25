// The admin's work queue (dashboards upgrade phase 2, design section 2): what the panel knows of
// each queue `GET dashboard/admin/work-queue` may answer. The API decides which queues an admin
// sees (each needs its owner's key); the panel only gives each key its words, its list and how it
// signals. A key the panel does not know yet is left out (packages/ui `workQueueRows`).

import type { WorkQueueAnswer, WorkQueueSignal } from '@mondapac/ui';
import { ordersHref } from '../orders/orders-link.ts';

export const WORK_QUEUE_PATH = 'dashboard/admin/work-queue';

/** The full page of every queue. */
export const WORK_QUEUE_PAGE = '/work-queue';

export interface AdminQueue {
  readonly key: string;
  /** The keys the API binds the queue to (dashboard.module.ts); the loader asks only with one. */
  readonly requires: string;
  /**
   * The queue's list. Null while the panel has no list for exactly these items (they are recorded
   * in the future-enhancements register): the row then shows without a link.
   */
  readonly href: string | null;
  readonly signal: WorkQueueSignal;
}

/** In the API's order within a level (dashboard.module.ts `workQueueSources`). */
export const ADMIN_QUEUES: readonly AdminQueue[] = [
  // Critical.
  {
    key: 'catalog.claims-without-certificate',
    requires: 'catalog.product.view',
    href: null,
    signal: 'incident',
  },
  {
    key: 'security.open-alerts',
    requires: 'security.centre.view',
    href: '/security/alerts',
    signal: 'age',
  },
  {
    key: 'commission-payouts.disputes-due',
    requires: 'commission-payouts.dispute.view',
    href: '/disputes?view=needs-response',
    signal: 'deadline',
  },
  {
    key: 'ordering.late-deliveries',
    requires: 'ordering.order.view',
    href: '/shipments',
    signal: 'age',
  },
  // Today.
  {
    key: 'ordering.failed-payments',
    requires: 'ordering.order.view',
    // Cancelled orders (drill-down): the list has no cancel-reason or cancelled-day filter yet,
    // so it shows every cancelled order, the failed payments among them.
    href: ordersHref({ status: 'cancelled' }),
    signal: 'age',
  },
  {
    key: 'payments.failed-webhooks',
    requires: 'payments.customer-payment.view',
    href: null,
    signal: 'age',
  },
  {
    key: 'commission-payouts.failed-payouts',
    requires: 'commission-payouts.payout.view',
    href: '/payouts?status=failed',
    signal: 'age',
  },
  {
    key: 'ordering.pending-refunds',
    requires: 'ordering.order.view',
    href: '/refunds',
    signal: 'age',
  },
  {
    key: 'sellers.applications',
    requires: 'sellers.seller.view',
    href: '/sellers?tab=awaiting-review',
    signal: 'age',
  },
  {
    key: 'catalog.pending-offers',
    requires: 'catalog.product.view',
    href: '/review?type=offer',
    signal: 'age',
  },
  {
    key: 'catalog.pending-revisions',
    requires: 'catalog.product.view',
    href: '/review',
    signal: 'age',
  },
  {
    key: 'pricing.price-holds',
    requires: 'pricing.price-hold.view',
    href: '/price-holds',
    signal: 'age',
  },
  {
    key: 'payments.restricted-accounts',
    requires: 'payments.connected-account.view',
    href: '/payout-accounts',
    signal: 'age',
  },
  {
    key: 'commission-payouts.payout-holds',
    requires: 'commission-payouts.settlement.view',
    href: null,
    signal: 'age',
  },
  {
    key: 'sellers.health-queue',
    requires: 'sellers.seller.view',
    href: '/sellers/needs-a-look',
    signal: 'age',
  },
  // Review.
  {
    key: 'catalog.brand-merges',
    requires: 'catalog.brand.read',
    href: '/catalog/brands',
    signal: 'age',
  },
  {
    key: 'catalog.category-proposals',
    requires: 'catalog.category-proposal.decide',
    href: '/catalog/categories?tab=proposals',
    signal: 'age',
  },
  {
    key: 'certification.seller-certificates',
    requires: 'certification.seller-certificate.view',
    href: '/certificates',
    signal: 'age',
  },
  {
    key: 'certification.product-certificates',
    requires: 'certification.product-certificate.view',
    href: null,
    signal: 'age',
  },
];

const BY_KEY = new Map(ADMIN_QUEUES.map((queue) => [queue.key, queue]));

export const adminQueue = (key: string): AdminQueue | null => BY_KEY.get(key) ?? null;

/** Whether the session holds the key of at least one queue (else the read is not made at all). */
export function mayHaveWorkQueue(permissionKeys: readonly string[]): boolean {
  const keys = new Set(permissionKeys);
  return ADMIN_QUEUES.some((queue) => keys.has(queue.requires));
}

/** The message key of a queue's label: its API key with the dot as a nesting level. */
export const labelKey = (key: string): string => `queue.${key}`;

export type { WorkQueueAnswer };
