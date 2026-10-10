import type { CallContext, Id } from '@mondapac/shared-kernel';

/** What `identity` answered to a decision (sellers design 7.3): the decision id, or its refusal code. */
export type AccessDecisionAnswer =
  | { readonly kind: 'decided'; readonly decisionId: Id<'AccessDecision'> }
  | { readonly kind: 'refused'; readonly code: string };

/** A decision `identity` recorded for a `{ sellerId, basisId }` pair (request R-5). */
export interface DecisionByBasis {
  readonly sellerId: Id<'Seller'>;
  readonly basisId: Id<'BusinessFileRevision'>;
  readonly decisionId: Id<'AccessDecision'>;
  readonly kind: 'approved' | 'rejected' | 'suspended' | 'reinstated';
}

/**
 * The decision calls of `identity`'s seller-access contract (sellers design 7.3; ADR-0022
 * decision 4; R-1), always outside any unit of work (PP 3.1 row 5), with the caller's
 * `CallContext` unchanged so `identity`'s gate checks the reviewer again (double gate).
 *
 * `approve` and `reject` are bounded by the 30-second deadline of design 7.3 (Hassan M3). A
 * timeout, an error or an answer that is neither a decision nor a refusal throws: the caller
 * cannot tell whether `identity` decided, so it leaves the intent for the event handler or the
 * reconciliation job. `reason` is personal data: never logged or stored by `sellers`.
 */
export interface SellerAccessDecider {
  approve(
    context: CallContext,
    sellerId: Id<'Seller'>,
    basisId: Id<'BusinessFileRevision'>,
  ): Promise<AccessDecisionAnswer>;

  reject(
    context: CallContext,
    sellerId: Id<'Seller'>,
    reason: string,
    basisId: Id<'BusinessFileRevision'>,
  ): Promise<AccessDecisionAnswer>;

  /**
   * The decisions recorded for these pairs (the reconciliation job, rule `system`). A pair with no
   * decision is absent. Throws when `identity` refuses or cannot answer: then nothing may be
   * concluded, and the caller leaves the intent and the claim untouched (Hassan C6).
   */
  decisionsByBasis(
    context: CallContext,
    items: readonly {
      readonly sellerId: Id<'Seller'>;
      readonly basisId: Id<'BusinessFileRevision'>;
    }[],
  ): Promise<readonly DecisionByBasis[]>;
}

export const SELLER_ACCESS_DECIDER = Symbol('SELLER_ACCESS_DECIDER');
