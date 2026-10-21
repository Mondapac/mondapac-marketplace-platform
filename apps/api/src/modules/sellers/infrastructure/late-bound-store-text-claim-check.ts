import { err } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import type {
  ClaimCheckUnavailable,
  StoreTextClaimCheck,
} from '../application/ports/store-text-claim-check';

/**
 * The claim check as `SellersModule` provides it: it answers `claim-text.check-unavailable`
 * until `SellerStoreProfileModule` binds the real check (over `certification.matchClaimTerms`)
 * at start. Sellers cannot import certification (certification imports sellers), so the binding
 * is made from outside; until it is made, a text save is refused, never let through (fail closed).
 */
export class LateBoundStoreTextClaimCheck implements StoreTextClaimCheck {
  #bound: StoreTextClaimCheck | null = null;

  /** Binds the real check once; a second bind is a wiring fault and throws (Hassan H3). */
  bind(check: StoreTextClaimCheck): void {
    if (this.#bound !== null) {
      throw new Error('LateBoundStoreTextClaimCheck is already bound');
    }
    this.#bound = check;
  }

  flagged(
    context: CallContext,
    texts: readonly { readonly locale: string; readonly text: string }[],
  ): Promise<Result<readonly boolean[], ClaimCheckUnavailable>> {
    if (this.#bound === null) {
      return Promise.resolve(err({ code: 'claim-text.check-unavailable' } as const));
    }
    return this.#bound.flagged(context, texts);
  }
}
