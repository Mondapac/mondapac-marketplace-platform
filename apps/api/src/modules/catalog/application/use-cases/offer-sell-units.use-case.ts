import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { OfferSellUnitsMap } from '../../contracts/catalog.facade';
import type { OfferSellUnitsFailure } from '../offers/offer-sell-units-request';
import { readSellUnits, type OfferSellUnitsDependencies } from '../offers/offer-sell-units-read';

export interface OfferSellUnitsInput {
  readonly offerIds: readonly string[];
}

/** `offerSellUnits` for request actors: rule `anonymous`; its pair is the `system` case. */
export class OfferSellUnitsQuery extends UseCase<
  OfferSellUnitsInput,
  OfferSellUnitsMap,
  OfferSellUnitsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.offer-sell-units',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OfferSellUnitsDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: OfferSellUnitsInput,
  ): Promise<Result<OfferSellUnitsMap, OfferSellUnitsFailure>> {
    return readSellUnits(this.deps, context, input.offerIds);
  }
}
