import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { OfferListingsMap } from '../../contracts/catalog.facade';
import {
  readOfferListings,
  type OfferListingsDependencies,
  type OfferListingsInput,
} from '../offers/offer-listings-read';
import type { OfferSellUnitsFailure } from '../offers/offer-sell-units-request';

/**
 * `offerListings` for event handlers and jobs (catalog design 9.1): rule `system`. The same
 * published-only answer, plus `rechecking` and `suspended` tags with status and basis and no
 * badge data (Hassan L3).
 */
export class OfferListingsSystemQuery extends UseCase<
  OfferListingsInput,
  OfferListingsMap,
  OfferSellUnitsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.offer-listings-system',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OfferListingsDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: OfferListingsInput,
  ): Promise<Result<OfferListingsMap, OfferSellUnitsFailure>> {
    return readOfferListings(this.deps, context, input, 'live');
  }
}
