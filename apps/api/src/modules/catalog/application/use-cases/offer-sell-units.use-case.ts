import type { CallContext, Result } from '@mondapac/shared-kernel';
import { ok } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { OfferSellUnitsMap } from '../../contracts/catalog.facade';
import {
  absentForEveryKey,
  parseOfferIds,
  type OfferSellUnitsFailure,
} from '../offers/offer-sell-units-placeholder';

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

  constructor(gate: UseCaseGate) {
    super(gate);
  }

  protected handle(
    _context: CallContext,
    input: OfferSellUnitsInput,
  ): Promise<Result<OfferSellUnitsMap, OfferSellUnitsFailure>> {
    const ids = parseOfferIds(input.offerIds);
    return Promise.resolve(ids.ok ? ok(absentForEveryKey()) : ids);
  }
}
