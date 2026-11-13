import type { CallContext, Id, MarketContext } from '@mondapac/shared-kernel';

/**
 * Whether a seller may propose categories now (SEL-26 through `sellers.mayProposeCategories`;
 * CAT-51). Asked at every proposal command and again at approval (Hassan M1 on PR #705). Only an
 * `ok(true)` answer is yes: a refusal, an error or a throw is no.
 */
export interface CategoryProposalCapability {
  allows(context: CallContext, sellerId: Id<'Seller'>): Promise<boolean>;
}

export const CATEGORY_PROPOSAL_CAPABILITY = Symbol('CATEGORY_PROPOSAL_CAPABILITY');

/** The Market's pending cap of category proposals per seller (CAT-54). */
export interface CategoryProposalPolicy {
  maxPending(market: MarketContext): number;
}

export const CATEGORY_PROPOSAL_POLICY = Symbol('CATEGORY_PROPOSAL_POLICY');
