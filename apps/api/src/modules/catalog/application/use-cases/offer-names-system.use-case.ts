import { ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { parseOfferIds, type OfferSellUnitsFailure } from '../offers/offer-sell-units-request';
import type { OfferNamesReader } from '../ports/offer-names.reader';

export interface OfferNamesInput {
  readonly offerIds: readonly string[];
  /** The locale to prefer, such as the Market's default locale. */
  readonly locale: string;
}

export interface OfferNamesDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly namesReader: OfferNamesReader;
}

/**
 * `offerNames` for event handlers (the order emails): the published product name of each
 * requested Offer, at most 200 ids. Rule `system`. An unknown id, an id of another Market and
 * an Offer without a published name are absent. Names are the seller's text: callers escape or
 * neutralise them for their output.
 */
export class OfferNamesSystemQuery extends UseCase<
  OfferNamesInput,
  ReadonlyMap<Id<'Offer'>, string>,
  OfferSellUnitsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.offer-names-system',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OfferNamesDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: OfferNamesInput,
  ): Promise<Result<ReadonlyMap<Id<'Offer'>, string>, OfferSellUnitsFailure>> {
    const ids = parseOfferIds(input.offerIds);
    if (!ids.ok) return ids;
    if (ids.value.size === 0) return ok(new Map());
    const requested = [...ids.value];
    return this.deps.unitOfWork.run<ReadonlyMap<Id<'Offer'>, string>, OfferSellUnitsFailure>(
      context.market,
      async () => ok(await this.deps.namesReader.read(context.market, requested, input.locale)),
      { readOnly: true },
    );
  }
}
