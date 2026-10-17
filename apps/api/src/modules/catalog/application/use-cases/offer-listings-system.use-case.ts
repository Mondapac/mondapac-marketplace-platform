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
 * published-only answer, plus the `active`, `rechecking` and `suspended` tags with status and
 * basis (Hassan L3). Badge data is answered again from slice 12 (Hassan L-1 decided at slice 12,
 * recorded in the data design's as-built note of migration 10): catalog now consumes the revoke and
 * expiry events, so a stored `active` tag follows its certificate within the fan-out job's run; only
 * an `active` tag carries a badge (`rechecking` and `suspended` never do), and a copy whose
 * `validUntil` has passed answers no badge even before the expiry event is handled. Display only:
 * `ordering` asks `evaluateClaims` itself (ADR-0028 d4).
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
