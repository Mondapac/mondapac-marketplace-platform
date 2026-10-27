import type { Temporal } from '@mondapac/shared-kernel';

// Dispute intake (Phase 5 package 8a). A dispute is what Stripe reports about a charge of an
// order: an inquiry (no money moves) or a chargeback (the disputed amount is taken from the
// platform and may come back). Pure rules over the state Stripe returns; no money is moved here.

/** The dispute events the receiver keeps (platform endpoint). */
export const DISPUTE_EVENT_TYPES = [
  'charge.dispute.created',
  'charge.dispute.updated',
  'charge.dispute.funds_withdrawn',
  'charge.dispute.funds_reinstated',
  'charge.dispute.closed',
] as const;
export type DisputeEventType = (typeof DISPUTE_EVENT_TYPES)[number];

export const isDisputeEventType = (type: string): type is DisputeEventType =>
  (DISPUTE_EVENT_TYPES as readonly string[]).includes(type);

/** Stripe's dispute statuses; `warning_*` is an inquiry. */
export const DISPUTE_STATUSES = [
  'warning_needs_response',
  'warning_under_review',
  'warning_closed',
  'needs_response',
  'under_review',
  'won',
  'lost',
  'prevented',
] as const;
export type DisputeStatus = (typeof DISPUTE_STATUSES)[number];

/**
 * Stripe's dispute reasons. A reason Stripe adds later is stored as `other`, so the dispute is
 * still recorded; no free text is kept.
 */
export const DISPUTE_REASONS = [
  'bank_cannot_process',
  'check_returned',
  'credit_not_processed',
  'customer_initiated',
  'debit_not_authorized',
  'duplicate',
  'fraudulent',
  'general',
  'incorrect_account_details',
  'insufficient_funds',
  'noncompliant',
  'product_not_received',
  'product_unacceptable',
  'subscription_canceled',
  'unrecognized',
  'other',
] as const;
export type DisputeReason = (typeof DISPUTE_REASONS)[number];

export type DisputeOutcome = 'won' | 'lost';

export const isDisputeStatus = (value: string): value is DisputeStatus =>
  (DISPUTE_STATUSES as readonly string[]).includes(value);

export const reasonOf = (value: string): DisputeReason =>
  (DISPUTE_REASONS as readonly string[]).includes(value) ? (value as DisputeReason) : 'other';

/** An inquiry: the bank asks a question, no money is withdrawn. */
export const isInquiry = (status: DisputeStatus): boolean => status.startsWith('warning_');

/** Won or lost, for a chargeback that Stripe closed; null otherwise. */
export const outcomeOf = (status: DisputeStatus): DisputeOutcome | null =>
  status === 'won' || status === 'lost' ? status : null;

/** What payments keeps of a dispute's changing state. */
export interface DisputeState {
  readonly status: DisputeStatus;
  readonly reason: DisputeReason;
  readonly evidenceDueBy: Temporal.Instant | null;
  readonly fundsWithdrawn: boolean;
  readonly fundsWithdrawnAt: Temporal.Instant | null;
  readonly fundsReinstated: boolean;
  readonly fundsReinstatedAt: Temporal.Instant | null;
  readonly outcome: DisputeOutcome | null;
}

/** The state Stripe returned now, before it is merged with what is stored. */
export interface ReadDisputeState {
  readonly status: DisputeStatus;
  readonly reason: DisputeReason;
  readonly evidenceDueBy: Temporal.Instant | null;
  readonly fundsWithdrawn: boolean;
  readonly fundsReinstated: boolean;
}

/**
 * The state to store after a read at `readAt`. The money flags only move from false to true (a
 * reinstatement implies the withdrawal), their instants are the first read that saw them, and a
 * won or lost dispute keeps its status and outcome: a late or overlapping read never takes back
 * what was recorded.
 */
export function mergeDisputeState(
  stored: DisputeState | null,
  read: ReadDisputeState,
  readAt: Temporal.Instant,
): DisputeState {
  const fundsReinstated = (stored?.fundsReinstated ?? false) || read.fundsReinstated;
  const fundsWithdrawn =
    (stored?.fundsWithdrawn ?? false) || read.fundsWithdrawn || fundsReinstated;
  const closed = stored !== null && stored.outcome !== null;
  const status = closed ? stored.status : read.status;
  return {
    status,
    reason: read.reason,
    evidenceDueBy: read.evidenceDueBy,
    fundsWithdrawn,
    fundsWithdrawnAt: fundsWithdrawn ? (stored?.fundsWithdrawnAt ?? readAt) : null,
    fundsReinstated,
    fundsReinstatedAt: fundsReinstated ? (stored?.fundsReinstatedAt ?? readAt) : null,
    outcome: closed ? stored.outcome : outcomeOf(status),
  };
}

const sameInstant = (a: Temporal.Instant | null, b: Temporal.Instant | null): boolean =>
  a === null || b === null ? a === b : a.epochMilliseconds === b.epochMilliseconds;

/** Whether two states differ in anything payments keeps. */
export function disputeStateChanged(a: DisputeState, b: DisputeState): boolean {
  return (
    a.status !== b.status ||
    a.reason !== b.reason ||
    !sameInstant(a.evidenceDueBy, b.evidenceDueBy) ||
    a.fundsWithdrawn !== b.fundsWithdrawn ||
    a.fundsReinstated !== b.fundsReinstated ||
    a.outcome !== b.outcome
  );
}
