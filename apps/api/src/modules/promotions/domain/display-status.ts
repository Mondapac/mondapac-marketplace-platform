import type { Temporal } from '@mondapac/shared-kernel';
import { isCreditType, type PromotionStatus } from './promotion';

// What an admin sees as a promotion's state. The stored status (PENDING_APPROVAL, ACTIVE, PAUSED,
// REJECTED) says what a person decided; "scheduled", "ended" and "budget used up" are not stored,
// they follow from the dates and the usage, so they are derived here and never go stale.

export const DISPLAY_STATUSES = [
  'ACTIVE',
  'SCHEDULED',
  'PAUSED',
  'PENDING_APPROVAL',
  'REJECTED',
  'ENDED',
  'BUDGET_USED_UP',
] as const;
export type DisplayStatus = (typeof DISPLAY_STATUSES)[number];

/**
 * The tabs of the admin list. `NEEDS_REVIEW` is not a display status: it is every promotion with an
 * open entry in the review queue (a seller promotion waiting for approval, or a live one waiting
 * for its post-publication check).
 */
export const PROMOTION_VIEWS = [
  'ALL',
  'ACTIVE',
  'SCHEDULED',
  'PAUSED',
  'NEEDS_REVIEW',
  'ENDED',
] as const;
export type PromotionView = (typeof PROMOTION_VIEWS)[number];

/** What the display status is derived from. */
export interface DisplayFacts {
  readonly type: string;
  readonly status: PromotionStatus;
  readonly startsAt: Temporal.Instant;
  readonly endsAt: Temporal.Instant | null;
  readonly budgetMinor: bigint | null;
  readonly spentMinor: bigint;
}

/**
 * Whether the budget of a live promotion is spent. Only discount types have it: the wallet-credit
 * types (referral, cashback) keep their spend in the credits, not in the usage counters.
 */
export function budgetUsedUp(facts: Pick<DisplayFacts, 'type' | 'budgetMinor' | 'spentMinor'>) {
  return (
    !isCreditType(facts.type) && facts.budgetMinor !== null && facts.spentMinor >= facts.budgetMinor
  );
}

/**
 * A rejected or waiting promotion shows its stored status. Otherwise a promotion whose end has
 * passed is `ENDED` (live or paused), a paused one is `PAUSED`, and a live one is `SCHEDULED`
 * before its start, `BUDGET_USED_UP` once its budget is spent, and `ACTIVE` in between.
 */
export function displayStatusOf(facts: DisplayFacts, now: Temporal.Instant): DisplayStatus {
  if (facts.status === 'REJECTED' || facts.status === 'PENDING_APPROVAL') return facts.status;
  if (facts.endsAt !== null && facts.endsAt.epochMilliseconds <= now.epochMilliseconds) {
    return 'ENDED';
  }
  if (facts.status === 'PAUSED') return 'PAUSED';
  if (facts.startsAt.epochMilliseconds > now.epochMilliseconds) return 'SCHEDULED';
  return budgetUsedUp(facts) ? 'BUDGET_USED_UP' : 'ACTIVE';
}

/** The display status a tab shows, or null for the tabs that are not one (all, needs review). */
export function viewStatus(view: PromotionView): DisplayStatus | null {
  switch (view) {
    case 'ACTIVE':
    case 'SCHEDULED':
    case 'PAUSED':
    case 'ENDED':
      return view;
    default:
      return null;
  }
}
