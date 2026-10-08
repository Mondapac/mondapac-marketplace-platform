import type { CallContext, Result } from '@mondapac/shared-kernel';
import { ok } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { OfferSellUnitsMap } from '../../contracts/catalog.facade';
import type { OfferSellUnitsInput } from './offer-sell-units.use-case';
import {
  absentForEveryKey,
  parseOfferIds,
  type OfferSellUnitsFailure,
} from '../offers/offer-sell-units-placeholder';

/** `offerSellUnits` for event handlers and jobs: rule `system`, the same answer. */
export class OfferSellUnitsSystemQuery extends UseCase<
  OfferSellUnitsInput,
  OfferSellUnitsMap,
  OfferSellUnitsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.offer-sell-units-system',
    rule: { kind: 'system' },
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
