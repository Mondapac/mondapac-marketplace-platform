import { ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { parseOfferIds, type OfferSellUnitsFailure } from '../offers/offer-sell-units-request';
import type { OfferTaxCategoriesReader } from '../ports/offer-tax-categories.reader';

export interface OfferTaxCategoriesInput {
  readonly offerIds: readonly string[];
}

export interface OfferTaxCategoriesDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly taxCategoriesReader: OfferTaxCategoriesReader;
}

/**
 * `offerTaxCategories`: the tax category code of the PUBLISHED revision of each requested
 * Offer's product, at most 200 ids, duplicates collapsed. Rule `anonymous`: a category code is
 * public content and the answer carries no price, stock, Cost or seller data. The request is
 * checked whole before any read. The Market comes from the context only; an unknown id and
 * another Market's id are both absent.
 */
export class OfferTaxCategoriesQuery extends UseCase<
  OfferTaxCategoriesInput,
  ReadonlyMap<Id<'Offer'>, string>,
  OfferSellUnitsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.offer-tax-categories',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OfferTaxCategoriesDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: OfferTaxCategoriesInput,
  ): Promise<Result<ReadonlyMap<Id<'Offer'>, string>, OfferSellUnitsFailure>> {
    const ids = parseOfferIds(input.offerIds);
    if (!ids.ok) return ids;
    if (ids.value.size === 0) return ok(new Map());
    const requested = [...ids.value];
    return this.deps.unitOfWork.run<ReadonlyMap<Id<'Offer'>, string>, OfferSellUnitsFailure>(
      context.market,
      async () => ok(await this.deps.taxCategoriesReader.read(context.market, requested)),
      { readOnly: true },
    );
  }
}
