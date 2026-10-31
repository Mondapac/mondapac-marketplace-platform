import type { Id, Temporal } from '@mondapac/shared-kernel';

// Wallet credit from promotions (phase 3): the refer-a-friend program and cashback. Credit is a
// payment instrument, not a discount, so none of this is in the calculation. These are the pure
// rules: what is owed, whether it is real or only recorded, and the stored shapes. Pure: the
// Market's numbers and the clock come in as arguments.

export const CREDIT_KINDS = ['CASHBACK', 'REFERRER_REWARD', 'REFEREE_REWARD'] as const;
export type CreditKind = (typeof CREDIT_KINDS)[number];

/** PENDING: reserved, the wallet not yet confirmed. RECORDED: the intended credit of a test-mode promotion. */
export const CREDIT_STATUSES = ['PENDING', 'GRANTED', 'RECORDED', 'FAILED'] as const;
export type CreditStatus = (typeof CREDIT_STATUSES)[number];

export const CREDIT_SOURCE_KINDS = ['SELLER_ORDER', 'REFERRAL'] as const;
export type CreditSourceKind = (typeof CREDIT_SOURCE_KINDS)[number];

export const REFERRAL_STATUSES = ['PENDING', 'QUALIFIED', 'REJECTED', 'EXPIRED'] as const;
export type ReferralStatus = (typeof REFERRAL_STATUSES)[number];

export const REFERRAL_REJECT_REASONS = [
  'SAME_HOUSEHOLD',
  'SAME_PAYMENT',
  'CAP_REACHED',
  'BUDGET_EXHAUSTED',
] as const;
export type ReferralRejectReason = (typeof REFERRAL_REJECT_REASONS)[number];

/** One credit the platform owes or has paid. */
export interface CreditRecord {
  readonly id: Id<'PromotionCredit'>;
  readonly promotionId: Id<'Promotion'>;
  readonly kind: CreditKind;
  readonly recipientAccountId: Id<'Account'>;
  /** The order that earned it. */
  readonly orderId: Id<'Order'> | null;
  readonly sourceKind: CreditSourceKind;
  readonly sourceId: string;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly status: CreditStatus;
  readonly failureCode: string | null;
  readonly walletJournalId: string | null;
  readonly idempotencyKey: string;
  readonly createdAt: Temporal.Instant;
  readonly settledAt: Temporal.Instant | null;
}

export interface ReferralRecord {
  readonly id: Id<'Referral'>;
  readonly promotionId: Id<'Promotion'>;
  readonly referrerAccountId: Id<'Account'>;
  readonly refereeAccountId: Id<'Account'>;
  readonly status: ReferralStatus;
  readonly rejectReason: ReferralRejectReason | null;
  readonly createdAt: Temporal.Instant;
  readonly expiresAt: Temporal.Instant;
  readonly decidedAt: Temporal.Instant | null;
  readonly qualifyingOrderId: Id<'Order'> | null;
  readonly qualifyingSellerOrderId: Id<'SellerOrder'> | null;
}

/**
 * What a credit becomes for one promotion and one order:
 * - `REAL`: the wallet is credited.
 * - `RECORD`: only the intended credit is kept (a test-mode promotion, which never moves money).
 * - `SKIP`: nothing happens (platform money while the Market's tax ruling is not confirmed, or a
 *   test order, which never earns real credit).
 */
export type CreditMode = 'REAL' | 'RECORD' | 'SKIP';

export function creditModeFor(facts: {
  readonly promotionTestMode: boolean;
  readonly orderIsTest: boolean;
  readonly gstRulingConfirmed: boolean;
}): CreditMode {
  if (facts.promotionTestMode) return 'RECORD';
  if (!facts.gstRulingConfirmed) return 'SKIP';
  if (facts.orderIsTest) return 'SKIP';
  return 'REAL';
}

/** floor(amount x bps / 10000), never negative. */
export const shareOf = (amount: bigint, bps: number): bigint =>
  amount <= 0n ? 0n : (amount * BigInt(bps)) / 10000n;

/**
 * The cashback of one delivered order: the promotion's percent of the goods the customer paid
 * (floored), within what is left of the per-order cap (the order may have been credited already,
 * seller order by seller order) and of the promotion's budget. Zero when the goods are below the
 * minimum spend or any limit is used up.
 */
export function cashbackAmount(args: {
  readonly goodsPaid: bigint;
  readonly bps: number;
  readonly capMinor: bigint;
  readonly alreadyCreditedForOrder: bigint;
  readonly minSpendMinor: bigint | null;
  readonly budgetLeft: bigint | null;
}): bigint {
  if (args.minSpendMinor !== null && args.goodsPaid < args.minSpendMinor) return 0n;
  let amount = shareOf(args.goodsPaid, args.bps);
  const capLeft = args.capMinor - args.alreadyCreditedForOrder;
  if (amount > capLeft) amount = capLeft;
  if (args.budgetLeft !== null && amount > args.budgetLeft) amount = args.budgetLeft;
  return amount > 0n ? amount : 0n;
}

/** Whole days from `earlier` to `later` (floored; negative when `earlier` is in the future). */
export function wholeDaysBetween(earlier: Temporal.Instant, later: Temporal.Instant): number {
  const hours = later.since(earlier, { largestUnit: 'hour' }).hours;
  return Math.floor(hours / 24);
}

/** The idempotency key of a credit: stable per kind and source, within the wallet's key alphabet. */
export const creditKey = (kind: CreditKind, sourceId: string): string =>
  `promotions:${kind.toLowerCase().replaceAll('_', '-')}:${sourceId}`;
