import type { SellerAffinity } from '../application/ports/seller-affinity';

/**
 * Identity keeps one population per account for life (ADR-0018): a member of a seller's team has
 * a seller-population account and cannot sign in to a customer route, so a customer session is
 * never a team member by account. This binding answers "not tied" for that reason. It does NOT
 * see a person who holds a customer account and a seller account with the same email; that
 * needs an identity query that does not exist yet (docs/modules/reviews/notes.md, open
 * question 2, and the same-address signal of package 5). Swap the binding (SELLER_AFFINITY) when
 * identity offers it.
 */
export class StructuralSellerAffinity implements SellerAffinity {
  isTiedToSeller(): Promise<boolean> {
    return Promise.resolve(false);
  }
}
