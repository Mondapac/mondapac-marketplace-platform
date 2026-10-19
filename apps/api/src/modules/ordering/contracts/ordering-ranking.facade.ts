import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';

/** The window the best sellers are counted over, ending now (storefront reads package). */
export const BESTSELLER_WINDOW_DAYS = 30;
/** The most Offers one ranking call answers; a larger `limit` is refused. */
export const MAX_RANKED_OFFERS = 200;

export type RankingFailure =
  | AccessDenied
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    };

/**
 * What a storefront shelf may know of sales (storefront reads package). Ids in rank order only:
 * no count, amount, customer or seller figure leaves ordering. Advisory: the caller re-checks
 * that each Offer is still sellable before showing it. Not exposed over HTTP.
 */
export interface OrderingRankingFacade {
  /**
   * The Offers of the context's Market with the most paid order lines in the last
   * {@link BESTSELLER_WINDOW_DAYS} days (an order counts once it is confirmed, by its
   * confirmation time), most first, ties by Offer id; at most `limit` (1 to
   * {@link MAX_RANKED_OFFERS}). Rule `anonymous`.
   */
  bestSellingOffers(
    context: CallContext,
    request: { readonly limit: number },
  ): Promise<Result<readonly Id<'Offer'>[], RankingFailure>>;
}

/** Nest token of the {@link OrderingRankingFacade}, provided and exported by `OrderingModule`. */
export const ORDERING_RANKING_FACADE = Symbol('ORDERING_RANKING_FACADE');
