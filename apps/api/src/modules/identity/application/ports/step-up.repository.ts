import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';

/** A seller's stored rule for one action. */
export interface StepUpPolicyRow {
  readonly actionKey: string;
  readonly required: boolean;
  readonly updatedAt: Temporal.Instant;
}

/**
 * The seller's per-action rules and the fresh-code proofs of sessions (seller OTP policy). Every
 * method runs in the caller's open unit and takes the `MarketContext` only.
 */
export interface StepUpRepository {
  /** The seller's stored rules; an action without a row has its default. */
  policiesOf(market: MarketContext, sellerId: Id<'Seller'>): Promise<readonly StepUpPolicyRow[]>;

  /** The stored value for one action, or null when the seller never set one. */
  policyOf(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    actionKey: string,
  ): Promise<boolean | null>;

  /** Stores the rule (insert, or update with the version bumped). */
  savePolicy(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    actionKey: string,
    required: boolean,
    updatedBy: Id<'Account'>,
    now: Temporal.Instant,
  ): Promise<void>;

  /** When a code last covered this action in this session, or null. */
  proofOf(
    market: MarketContext,
    sessionId: Id<'Session'>,
    actionKey: string,
  ): Promise<Temporal.Instant | null>;

  /** Records that a code was verified now for this action in this session. */
  recordProof(
    market: MarketContext,
    sessionId: Id<'Session'>,
    actionKey: string,
    now: Temporal.Instant,
  ): Promise<void>;
}

export const STEP_UP_REPOSITORY = Symbol('STEP_UP_REPOSITORY');
