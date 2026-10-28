import { err, ok } from '@mondapac/shared-kernel';
import type { Id, Result, Temporal } from '@mondapac/shared-kernel';
import type { ApprovalMode } from './payout-terms';

// The payout (Phase 5 package 6d; G2 3.6): one transfer of the money of several delivered seller
// orders to a seller's connected account. This file is the state machine and the rules of
// creating and approving one; it reads and writes nothing. The id is the instruction key sent to
// payments: stored before any call, never reused (a retry after a failure is a new payout).

export const PAYOUT_STATES = [
  'pending',
  'awaiting-approval',
  'approved',
  'instructing',
  'instructed',
  'paid',
  'failed',
  'not-sent',
  'voided',
  'settled-by-netting',
] as const;
export type PayoutState = (typeof PAYOUT_STATES)[number];

/** A seller has at most one payout in these states (the partial unique index). */
export const LIVE_STATES: readonly PayoutState[] = [
  'pending',
  'awaiting-approval',
  'approved',
  'instructing',
];

/** States whose money counts as paid out to the seller (for the receivable). */
export const COUNTED_STATES: readonly PayoutState[] = [
  'instructing',
  'instructed',
  'paid',
  'settled-by-netting',
];

/** A payout that ended here did not pay: its seller orders are proposed again. */
export const FREEING_STATES: readonly PayoutState[] = ['voided', 'not-sent', 'failed'];

const TRANSITIONS: Readonly<Record<PayoutState, readonly PayoutState[]>> = {
  pending: ['instructing', 'voided'],
  'awaiting-approval': ['approved', 'voided'],
  approved: ['instructing', 'voided'],
  instructing: ['instructed', 'not-sent'],
  instructed: ['paid', 'failed'],
  paid: [],
  failed: [],
  'not-sent': [],
  voided: [],
  'settled-by-netting': [],
};

export const canTransition = (from: PayoutState, to: PayoutState): boolean =>
  TRANSITIONS[from].includes(to);

export const isLive = (state: PayoutState): boolean => LIVE_STATES.includes(state);

export const isFinal = (state: PayoutState): boolean => TRANSITIONS[state].length === 0;

/** Why a MANUAL payout waits for an admin: the seller's first payout, or the terms say so. */
export type ApprovalReason = 'first-payout' | 'terms';

/** Our own outcome codes; payments' refusal codes are stored as given. */
export const OUTCOME_CODES = [
  'abandoned',
  'access-lost',
  'voided.hold',
  'voided.amount-changed',
  'voided.access',
  'voided.account-not-ready',
  'voided.zone',
] as const;
export type OutcomeCode = (typeof OUTCOME_CODES)[number];

export interface PayoutItem {
  readonly sellerOrderId: Id<'SellerOrder'>;
  /** The seller order's net amount when taken, minor units, at least 1. */
  readonly amount: bigint;
}

export interface PayoutApproval {
  readonly approvedBy: Id<'Account'>;
  readonly approvedAt: Temporal.Instant;
  /** The amount the admin saw and echoed: always the transfer. */
  readonly approvedTransfer: bigint;
}

export interface Payout {
  /** Also the instruction key. */
  readonly id: Id<'Payout'>;
  readonly sellerId: Id<'Seller'>;
  readonly currency: string;
  readonly gross: bigint;
  readonly netted: bigint;
  readonly transfer: bigint;
  readonly approvalMode: ApprovalMode;
  readonly approvalReason: ApprovalReason | null;
  readonly minimum: bigint;
  readonly slotAt: Temporal.Instant;
  readonly state: PayoutState;
  readonly approval: PayoutApproval | null;
  readonly transferExecutionId: string | null;
  readonly outcomeCode: string | null;
  readonly instructingAt: Temporal.Instant | null;
  readonly abandonedAt: Temporal.Instant | null;
  readonly createdAt: Temporal.Instant;
  readonly stateChangedAt: Temporal.Instant;
  readonly version: number;
}

export interface NewPayout {
  readonly id: Id<'Payout'>;
  readonly sellerId: Id<'Seller'>;
  readonly currency: string;
  readonly items: readonly PayoutItem[];
  readonly netted: bigint;
  readonly approvalMode: ApprovalMode;
  readonly firstPayout: boolean;
  readonly minimum: bigint;
  readonly slotAt: Temporal.Instant;
  readonly now: Temporal.Instant;
}

/**
 * A new payout, in the state the run creates it in (4.7 step 4): nothing to transfer settles by
 * netting at once; the seller's first payout, or any payout of a MANUAL seller, waits for an admin;
 * every other payout is instructed in the same unit.
 */
export function openPayout(input: NewPayout): Payout {
  const gross = input.items.reduce((sum, item) => sum + item.amount, 0n);
  const transfer = gross - input.netted;
  if (gross < 1n || input.netted < 0n || transfer < 0n || input.items.some((i) => i.amount < 1n)) {
    throw new RangeError('openPayout: the amounts do not add up');
  }
  const settled = transfer === 0n;
  const manual = !settled && (input.firstPayout || input.approvalMode === 'MANUAL');
  const state: PayoutState = settled
    ? 'settled-by-netting'
    : manual
      ? 'awaiting-approval'
      : 'instructing';
  return {
    id: input.id,
    sellerId: input.sellerId,
    currency: input.currency,
    gross,
    netted: input.netted,
    transfer,
    approvalMode: manual ? 'MANUAL' : 'AUTO',
    approvalReason: manual ? (input.firstPayout ? 'first-payout' : 'terms') : null,
    minimum: input.minimum,
    slotAt: input.slotAt,
    state,
    approval: null,
    transferExecutionId: null,
    outcomeCode: null,
    instructingAt: state === 'instructing' ? input.now : null,
    abandonedAt: null,
    createdAt: input.now,
    stateChangedAt: input.now,
    version: 1,
  };
}

export type ApproveRefusal =
  | { readonly code: 'commission-payouts.payout.not-awaiting-approval' }
  | { readonly code: 'commission-payouts.payout.amount-changed' };

/**
 * An admin approves a waiting payout with the transfer amount they saw (approval binds the
 * amount). Marks only: no money moves in the admin's request; the worker instructs it.
 */
export function approve(
  payout: Payout,
  echoed: bigint,
  admin: Id<'Account'>,
  now: Temporal.Instant,
): Result<Payout, ApproveRefusal> {
  if (payout.state !== 'awaiting-approval') {
    return err({ code: 'commission-payouts.payout.not-awaiting-approval' });
  }
  if (echoed !== payout.transfer) return err({ code: 'commission-payouts.payout.amount-changed' });
  return ok({
    ...payout,
    state: 'approved',
    approval: { approvedBy: admin, approvedAt: now, approvedTransfer: payout.transfer },
    stateChangedAt: now,
    version: payout.version + 1,
  });
}

/** The payout in `to`, with `patch` applied; throws on a transition the machine does not have. */
export function moveTo(
  payout: Payout,
  to: PayoutState,
  now: Temporal.Instant,
  patch: Partial<
    Pick<Payout, 'transferExecutionId' | 'outcomeCode' | 'instructingAt' | 'abandonedAt'>
  > = {},
): Payout {
  if (!canTransition(payout.state, to)) {
    throw new RangeError(`moveTo: ${payout.state} -> ${to} is not a transition of a payout`);
  }
  return { ...payout, ...patch, state: to, stateChangedAt: now, version: payout.version + 1 };
}

// ---------------------------------------------------------------------------------------------
// What a seller is told

/** The reasons the seller view gives for a payout that is not on its way (design 5.4). */
export const BLOCK_REASONS = [
  'below-minimum',
  'awaiting-approval',
  'account-not-ready',
  'cooling-off',
  'payouts-paused',
  'zone-missing',
  'second-factor-required',
] as const;
export type BlockReason = (typeof BLOCK_REASONS)[number];

export const isBlockReason = (value: unknown): value is BlockReason =>
  typeof value === 'string' && (BLOCK_REASONS as readonly string[]).includes(value);

/**
 * What a seller is shown for a definite refusal of payments (the codes as given, Ali PC). Only the
 * two the seller can act on are specific; every other refusal is the platform's to sort out and
 * reads as a pause.
 */
export function blockReasonOfRefusal(code: string): BlockReason {
  switch (code) {
    case 'payments.transfer.account-not-ready':
      return 'account-not-ready';
    case 'payments.transfer.cooling-off':
      return 'cooling-off';
    default:
      return 'payouts-paused';
  }
}
