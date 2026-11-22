import { ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { parseOfferIds, type OfferSellUnitsFailure } from '../offers/offer-sell-units-request';
import type { OfferPrimaryCategoriesReader } from '../ports/offer-primary-categories.reader';

export interface OfferPrimaryCategoriesInput {
  readonly offerIds: readonly string[];
}

export interface OfferPrimaryCategoriesDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly primaryCategoriesReader: OfferPrimaryCategoriesReader;
}

/**
 * `offerPrimaryCategories`: the primary platform category of the PUBLISHED revision of each
 * requested Offer's product, at most 200 ids, duplicates collapsed, for reporting's sales by
 * category (dashboards upgrade phase 3). Rule `system`: only the reporting worker asks. The answer
 * is category ids only: no price, stock, Cost or seller data. The Market comes from the context;
 * an unknown id and another Market's id are both absent.
 */
export class OfferPrimaryCategoriesQuery extends UseCase<
  OfferPrimaryCategoriesInput,
  ReadonlyMap<Id<'Offer'>, Id<'Category'>>,
  OfferSellUnitsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.offer-primary-categories',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OfferPrimaryCategoriesDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: OfferPrimaryCategoriesInput,
  ): Promise<Result<ReadonlyMap<Id<'Offer'>, Id<'Category'>>, OfferSellUnitsFailure>> {
    const ids = parseOfferIds(input.offerIds);
    if (!ids.ok) return ids;
    if (ids.value.size === 0) return ok(new Map());
    const requested = [...ids.value];
    return this.deps.unitOfWork.run<
      ReadonlyMap<Id<'Offer'>, Id<'Category'>>,
      OfferSellUnitsFailure
    >(
      context.market,
      async () => ok(await this.deps.primaryCategoriesReader.read(context.market, requested)),
      { readOnly: true },
    );
  }
}
