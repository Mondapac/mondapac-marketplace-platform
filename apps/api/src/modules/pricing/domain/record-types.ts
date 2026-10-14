import type { Id } from '@mondapac/shared-kernel';
import type { PriceAmount } from './price-amount';

// Types shared by the regular and special records of a price series, kept apart so that
// `price-series.ts` and `special-price.ts` do not import each other.

/** Why a series stopped taking prices (pricing design 6.4). */
export type RetireCause = 'offer-removed' | 'variant-removed';

/**
 * Why a pending record was superseded (pricing design 3.1 row 5; pricing-data 3.3, M6): a new
 * seller write replaced it, a write equal to the price in force cancelled it, or the series was
 * retired.
 */
export type SupersedeCause = 'replaced' | 'cancelled' | RetireCause;

/**
 * The reasons an admin may give for rejecting a held price (pricing design 3.1 row 4, J1). A
 * closed list: the wording shown to the seller is the UX writer's (J1); the code is stored on the
 * record and in the audit row. Free text goes only into the optional note, which stays on the
 * record (never in an audit row, an event or a log; design 8).
 */
export const HOLD_REJECTION_REASONS = [
  'price-implausible',
  'price-unverified',
  'policy-breach',
  'entered-in-error',
  'other',
] as const;
export type HoldRejectionReason = (typeof HOLD_REJECTION_REASONS)[number];

/** The record a held price was measured against (design 2.4), copied so it never changes. */
export interface JumpAnchor {
  readonly recordId: Id<'RegularPriceRecord'>;
  readonly amount: PriceAmount;
}
