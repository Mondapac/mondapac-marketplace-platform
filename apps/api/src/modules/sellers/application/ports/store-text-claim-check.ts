import type { CallContext, Result } from '@mondapac/shared-kernel';

/** The check could not be made: there is no partial answer and the caller refuses the save (M8). */
export interface ClaimCheckUnavailable {
  readonly code: 'claim-text.check-unavailable';
}

/**
 * Whether a store text asserts a certification (catalog design 6.1, certification design 8.1):
 * the store profile never claims "halal certified" or any other type's term; the structured badge
 * built from the seller's certificates is the only place a claim shows. Bound to
 * `certification.matchClaimTerms` by `SellerStoreProfileModule`. The facade opens a read-only unit
 * of its own, so the caller holds no unit open. One flag per text, in order: true when a claim
 * term of any type occurs in it. Nothing of the vocabulary is returned.
 */
export interface StoreTextClaimCheck {
  flagged(
    context: CallContext,
    texts: readonly { readonly locale: string; readonly text: string }[],
  ): Promise<Result<readonly boolean[], ClaimCheckUnavailable>>;

  /**
   * The Market's claim terms as plain phrases, for the panel's live warning only (the seller
   * sees what wording is refused while typing). Read from certification; sellers keeps no copy.
   * Not a decision: `flagged` on save is the authority. Unavailable is never an empty list.
   */
  terms(context: CallContext): Promise<Result<readonly string[], ClaimCheckUnavailable>>;
}

export const STORE_TEXT_CLAIM_CHECK = Symbol('STORE_TEXT_CLAIM_CHECK');
