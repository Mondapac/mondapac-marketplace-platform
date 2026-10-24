import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import {
  MAX_INDEX_PAGE,
  type CatalogValidationFailed,
  type PublishedOfferIdsInput,
} from '../../contracts';
import type { OfferSearchFactsReader } from '../ports/offer-search-facts.reader';

export interface PublishedOfferIdsDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly searchReader: OfferSearchFactsReader;
}

const invalid = (path: string, code: string): CatalogValidationFailed => ({
  code: 'validation.failed',
  fields: [{ path, code }],
});

/**
 * `publishedOfferIds` of the index facade: rule `system`. Keyset pages of the ids of Offers
 * with `status = 'published'`, for a read model's backfill, or all of one product's or one seller's Offers.
 */
export class PublishedOfferIdsQuery extends UseCase<
  PublishedOfferIdsInput,
  readonly Id<'Offer'>[],
  CatalogValidationFailed
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.published-offer-ids',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PublishedOfferIdsDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: PublishedOfferIdsInput,
  ): Promise<Result<readonly Id<'Offer'>[], CatalogValidationFailed>> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > MAX_INDEX_PAGE) {
      return err(invalid('limit', 'range'));
    }
    for (const [path, value] of [
      ['productId', input.productId],
      ['sellerId', input.sellerId],
      ['after', input.after],
    ] as const) {
      if (value !== undefined && (typeof value !== 'string' || !parseId(value).ok)) {
        return err(invalid(path, 'format'));
      }
    }
    return this.deps.unitOfWork.run<readonly Id<'Offer'>[], CatalogValidationFailed>(
      context.market,
      async () => ok(await this.deps.searchReader.publishedOfferIds(context.market, input)),
      { readOnly: true },
    );
  }
}
