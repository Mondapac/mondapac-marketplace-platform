import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';
import type { OfferSearchFactsQuery } from '../application/use-cases/offer-search-facts.use-case';
import type { PublishedOfferIdsQuery } from '../application/use-cases/published-offer-ids.use-case';
import type {
  CatalogBatchTooLarge,
  CatalogIndexFacade,
  CatalogValidationFailed,
  OfferSearchFactsMap,
  PublishedOfferIdsInput,
} from '../contracts';

/** {@link CatalogIndexFacade}: each method passes the caller's context unchanged to one use case. */
export class CatalogIndexFacadeImplementation implements CatalogIndexFacade {
  constructor(
    private readonly facts: OfferSearchFactsQuery,
    private readonly published: PublishedOfferIdsQuery,
  ) {}

  offerSearchFacts(
    context: CallContext,
    offerIds: readonly Id<'Offer'>[],
    locale: string,
  ): Promise<
    Result<OfferSearchFactsMap, AccessDenied | CatalogValidationFailed | CatalogBatchTooLarge>
  > {
    return this.facts.execute(context, { offerIds, locale });
  }

  publishedOfferIds(
    context: CallContext,
    input: PublishedOfferIdsInput,
  ): Promise<Result<readonly Id<'Offer'>[], AccessDenied | CatalogValidationFailed>> {
    return this.published.execute(context, input);
  }
}
