import type { BadgeTone } from '@mondapac/ui';
import type { ApiFailure } from '../api/client.ts';

/** What the exclusive perks cards share: the promotion shape, its API error words and status badges. */
export const PROMOTIONS_BASE_PATH = 'promotions/seller/promotions';

export interface OwnPromotion {
  readonly id: string;
  readonly type: string;
  readonly status: 'PENDING_APPROVAL' | 'ACTIVE' | 'PAUSED' | 'REJECTED';
  readonly name: string;
  readonly funding: string;
  readonly startsAt: string;
  readonly endsAt: string | null;
  readonly currency: string;
  readonly reward: {
    readonly kind: 'PERCENT' | 'FIXED';
    readonly bps: number | null;
    readonly amountMinor: string | null;
  };
  readonly segment: { readonly kind: string } | null;
  readonly pausedBy: 'ADMIN' | 'SELLER' | null;
  /** CASHBACK: the most one order is credited, minor units (digits). */
  readonly capMinor?: string | null;
}

const PROBLEM_BY_CODE: Readonly<Record<string, string>> = {
  'promotions.code-taken': 'taken',
  'promotions.too-many-active': 'too-many',
  'promotions.not-editable': 'not-editable',
  'promotions.invalid-state': 'invalid-state',
  'promotions.not-found': 'not-found',
  'access.denied': 'denied',
  'request.csrf': 'csrf',
};

/** The message key (under `customers.perks.error`) of a failed promotion call. */
export function problemOf(failure: ApiFailure): string {
  if (failure.status === 429) return 'throttled';
  const named = PROBLEM_BY_CODE[failure.code];
  if (named !== undefined) return named;
  if (failure.code === 'validation.failed') return 'invalid';
  return failure.status === 0 || failure.status >= 500 ? 'unavailable' : 'unknown';
}

export const STATUS_TONE: Record<string, BadgeTone> = {
  ACTIVE: 'success',
  PAUSED: 'attention',
  PENDING_APPROVAL: 'info',
  REJECTED: 'critical',
  ENDED: 'neutral',
};

/** What the card calls a promotion: its status, or Ended once an active one passed its end. */
export function displayStatus(promotion: OwnPromotion, now: Date): string {
  if (
    promotion.status === 'ACTIVE' &&
    promotion.endsAt !== null &&
    new Date(promotion.endsAt).getTime() < now.getTime()
  ) {
    return 'ENDED';
  }
  return promotion.status;
}
