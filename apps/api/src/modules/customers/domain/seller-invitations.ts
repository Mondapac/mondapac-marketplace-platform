import { err, ok } from '@mondapac/shared-kernel';
import type { Id, Result, Temporal } from '@mondapac/shared-kernel';
import { CUSTOMER_CODE_ALPHABET } from './seller-customers';

// A seller's invite link and the seller a customer signed up through (customers management
// phase 4a; plan sections 7 and 7b). "Exclusive" is an attribution, not a lock: the customer stays
// free to buy anywhere, keeps one seller for good, and only new sign-ups are attributed (john,
// 13 Nov 2026). Pure: no I/O.

/** 26 symbols of Crockford base32 (130 random bits): the public part of the invite link. */
export const INVITE_TOKEN_LENGTH = 26;
export const INVITE_TOKEN_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** A token as it arrives in a link: upper-cased; null when it cannot be a token. */
export function normalizeInviteToken(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 64) return null;
  const token = raw.trim().toUpperCase();
  return INVITE_TOKEN_PATTERN.test(token) ? token : null;
}

/** Whether every symbol is of the alphabet (a guard on what the generator produced). */
export function isInviteToken(token: string): boolean {
  return (
    token.length === INVITE_TOKEN_LENGTH &&
    [...token].every((symbol) => CUSTOMER_CODE_ALPHABET.includes(symbol))
  );
}

export interface InviteLink {
  readonly id: Id<'SellerInviteLink'>;
  readonly sellerId: Id<'Seller'>;
  readonly token: string;
  readonly createdByAccountId: Id<'Account'>;
  readonly createdAt: Temporal.Instant;
  readonly revokedAt: Temporal.Instant | null;
}

export const ATTRIBUTION_STATUSES = ['active', 'rejected'] as const;
export type AttributionStatus = (typeof ATTRIBUTION_STATUSES)[number];

export const ATTRIBUTION_REJECT_REASONS = ['seller-team', 'admin'] as const;
export type AttributionRejectReason = (typeof ATTRIBUTION_REJECT_REASONS)[number];

export const ATTRIBUTION_FLAGS = ['link-burst'] as const;
export type AttributionFlag = (typeof ATTRIBUTION_FLAGS)[number];

export interface SellerAttribution {
  readonly accountId: Id<'Account'>;
  readonly sellerId: Id<'Seller'>;
  readonly linkId: Id<'SellerInviteLink'>;
  readonly attributedAt: Temporal.Instant;
  readonly status: AttributionStatus;
  readonly rejectReason: AttributionRejectReason | null;
  readonly flags: readonly AttributionFlag[];
  readonly decidedByAccountId: Id<'Account'> | null;
  readonly decidedAt: Temporal.Instant | null;
  readonly version: number;
}

/** The Market's rules for invite links (Market config `customers.invitations`). */
export interface InvitationRules {
  /** How long after sign-up an account may still join a store through its link (days). */
  readonly signUpWindowDays: number;
  /** Attributions through one link in 24 hours above which a new one is flagged `link-burst`. */
  readonly burstPerDay: number;
}

/** What the claim knows about the customer when it decides. */
export interface ClaimFacts {
  readonly now: Temporal.Instant;
  /** From the directory; null when the directory has no row yet (a sign-up minutes old). */
  readonly signedUpAt: Temporal.Instant | null;
  /** Confirmed orders the customer has placed (the stats read model; 0 without a row). */
  readonly orderCount: number;
  /** The customer already has an attribution (any status, any seller). */
  readonly attributed: boolean;
  /** The customer's sign-in address is also a member's of the seller's team. */
  readonly sellerTeam: boolean;
  /** Attributions through the same link in the last 24 hours. */
  readonly linkLastDay: number;
}

export type ClaimDecision =
  | { readonly kind: 'refuse' }
  | {
      readonly kind: 'record';
      readonly status: AttributionStatus;
      readonly rejectReason: AttributionRejectReason | null;
      readonly flags: readonly AttributionFlag[];
    };

/**
 * Decides a customer's claim of an invite link (plan 7, "sign-up with seller link"):
 * - refused, with nothing recorded, for an account already attributed (one seller for good), one
 *   that signed up longer ago than the window, and one that has ordered (new sign-ups only);
 * - recorded as `rejected` (`seller-team`) when the customer is on the seller's own team, so the
 *   admin sees the attempt in the suspicious list while it gives no perk;
 * - otherwise recorded `active`, flagged `link-burst` when the link brought more than the Market's
 *   limit in the last day (shown to the admin; the attribution still stands until an admin decides).
 */
export function decideClaim(facts: ClaimFacts, rules: InvitationRules): ClaimDecision {
  if (facts.attributed || facts.orderCount > 0) return { kind: 'refuse' };
  if (facts.signedUpAt !== null) {
    const limit = facts.signedUpAt.add({ hours: rules.signUpWindowDays * 24 });
    if (facts.now.epochMilliseconds > limit.epochMilliseconds) return { kind: 'refuse' };
  }
  const flags: AttributionFlag[] = facts.linkLastDay >= rules.burstPerDay ? ['link-burst'] : [];
  if (facts.sellerTeam) {
    return { kind: 'record', status: 'rejected', rejectReason: 'seller-team', flags };
  }
  return { kind: 'record', status: 'active', rejectReason: null, flags };
}

/** An admin's decision on an attribution. */
export type AttributionDecision = 'reject' | 'restore';

/**
 * Applies an admin's decision. Rejecting an active one sets `admin`; restoring a rejected one makes
 * it active again, except one rejected because the customer is on the seller's team (that rule is
 * not the admin's to waive). A decision that changes nothing is `unchanged`.
 */
export function decideAttribution(
  current: SellerAttribution,
  decision: AttributionDecision,
  by: Id<'Account'>,
  at: Temporal.Instant,
): Result<SellerAttribution | 'unchanged', 'seller-team'> {
  if (decision === 'reject') {
    if (current.status === 'rejected') return ok('unchanged');
    return ok({
      ...current,
      status: 'rejected',
      rejectReason: 'admin',
      decidedByAccountId: by,
      decidedAt: at,
      version: current.version + 1,
    });
  }
  if (current.status === 'active') return ok('unchanged');
  if (current.rejectReason === 'seller-team') return err('seller-team');
  return ok({
    ...current,
    status: 'active',
    rejectReason: null,
    decidedByAccountId: by,
    decidedAt: at,
    version: current.version + 1,
  });
}

/** Whether the attribution is suspicious: rejected, or flagged when it was recorded. */
export const isSuspicious = (attribution: Pick<SellerAttribution, 'status' | 'flags'>): boolean =>
  attribution.status === 'rejected' || attribution.flags.length > 0;
