import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';
import type { CatalogBatchTooLarge, CatalogValidationFailed } from './catalog.facade';

/** The most Offer ids one {@link CatalogIndexFacade.publishedOfferIds} call returns. */
export const MAX_INDEX_PAGE = 200;

/** The name and short text of a published revision in one locale. */
export interface OfferSearchText {
  readonly locale: string;
  readonly name: string;
  readonly shortDescription: string | null;
}

/**
 * What a read model (`search`) may know of one Offer: ids, the sellable flag, the text of the
 * product's published revision in the asked locale and its platform categories. No price, stock,
 * Cost or certification: a certification claim never comes from text (CERT rules).
 */
export interface OfferSearchFacts {
  readonly sellerId: Id<'Seller'>;
  readonly productId: Id<'Product'>;
  /** `status = 'published'` and no off-sale cause: exactly the Offer's `listed` flag. */
  readonly sellable: boolean;
  /** Null when the product has no published revision or none in the asked locale. */
  readonly text: OfferSearchText | null;
  readonly categoryIds: readonly Id<'Category'>[];
}

/**
 * Per distinct requested Offer id found in the context's Market; an unknown id and an id of
 * another Market are byte-identical: both absent. A deleted Offer is present with
 * `sellable: false`.
 */
export type OfferSearchFactsMap = ReadonlyMap<Id<'Offer'>, OfferSearchFacts>;

export interface PublishedOfferIdsInput {
  /** Only the Offers of this product (a new revision of it changes all of them). */
  readonly productId?: Id<'Product'>;
  /** Keyset: only ids after this one, in id order. */
  readonly after?: Id<'Offer'>;
  /** 1 to {@link MAX_INDEX_PAGE}. */
  readonly limit: number;
}

/**
 * The feed of catalog for read models (speed mode, search). Both methods are `system` only:
 * a request actor gets `access.denied`. Not exposed over HTTP. Runs in read-only units.
 */
export interface CatalogIndexFacade {
  /** The facts of each requested Offer (at most 200 ids) with the text in `locale`. */
  offerSearchFacts(
    context: CallContext,
    offerIds: readonly Id<'Offer'>[],
    locale: string,
  ): Promise<
    Result<OfferSearchFactsMap, AccessDenied | CatalogValidationFailed | CatalogBatchTooLarge>
  >;

  /** Ids of Offers with `status = 'published'` (listed or not), ascending, for a backfill. */
  publishedOfferIds(
    context: CallContext,
    input: PublishedOfferIdsInput,
  ): Promise<Result<readonly Id<'Offer'>[], AccessDenied | CatalogValidationFailed>>;
}

/** Nest token of the {@link CatalogIndexFacade}, provided and exported by `CatalogModule`. */
export const CATALOG_INDEX_FACADE = Symbol('CATALOG_INDEX_FACADE');
