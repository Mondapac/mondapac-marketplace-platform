import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';

/** The codes of an admin flag (data design 3.13; `register-recheck` joins with slice 11). */
export const ADMIN_FLAG_CODES = ['identifier-claim-conflict'] as const;
export type AdminFlagCode = (typeof ADMIN_FLAG_CODES)[number];

/**
 * The store of flags for an admin (data design 3.13; D 14.4 Q-M20): one open flag per Market,
 * seller and code. Runs in the open unit of the use case.
 */
export interface AdminFlagRepository {
  /**
   * Raises the flag: `raised`, or `already-open` when the seller has an open flag of this code
   * (nothing is written then, and the unit stays usable).
   */
  raise(
    market: MarketContext,
    flag: {
      readonly id: Id;
      readonly sellerId: Id<'Seller'>;
      readonly code: AdminFlagCode;
      readonly now: Temporal.Instant;
    },
  ): Promise<'raised' | 'already-open'>;
}

export const ADMIN_FLAG_REPOSITORY = Symbol('ADMIN_FLAG_REPOSITORY');
