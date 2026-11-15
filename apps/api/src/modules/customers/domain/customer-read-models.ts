import type { Id, Temporal } from '@mondapac/shared-kernel';

/**
 * One customer as the admin Customers pages list them: the `customers.customer_directory` row.
 * PERSONAL DATA (the sign-in address and the display name): never logged, never in an event, an
 * audit row or an error.
 */
export interface CustomerDirectoryEntry {
  readonly accountId: Id<'Account'>;
  readonly email: string;
  readonly displayName: string | null;
  readonly status: 'active' | 'disabled';
  readonly emailVerified: boolean;
  readonly signedUpAt: Temporal.Instant;
}

/** What one customer's orders add up to: the `customers.customer_stats` row. No personal data. */
export interface CustomerStatsEntry {
  readonly accountId: Id<'Account'>;
  readonly firstOrderAt: Temporal.Instant | null;
  readonly lastOrderAt: Temporal.Instant | null;
  readonly orderCount: number;
  /** Minor units of `currency`. */
  readonly spentMinor: bigint;
  readonly currency: string | null;
  readonly refundCount: number;
  readonly refundedMinor: bigint;
}

/** The lower-cased, trimmed sign-in address: the prefix-search key. */
export function emailSearchKey(email: string): string {
  return email.trim().toLowerCase();
}

/** True when a stats row carries nothing (no confirmed order and no refund). */
export function isEmptyStats(stats: CustomerStatsEntry): boolean {
  return stats.orderCount === 0 && stats.refundCount === 0;
}
