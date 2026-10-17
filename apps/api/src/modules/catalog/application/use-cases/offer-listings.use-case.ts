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
 * `offerListings` for request actors (catalog design 9.1; slice 11): rule `anonymous`, so a guest
 * cart can show what it holds. Published state only, and no tags (Hassan, certification revoke
 * review): catalog does not yet consume the revoke and expiry events (slice 12), so a stored
 * `active` tag can outlive its certificate and no buyer badge is built from it; no tag is even
 * read. Its pair is the `system` case. In-process.
 */
export class OfferListingsQuery extends UseCase<
  OfferListingsInput,
  OfferListingsMap,
  OfferSellUnitsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.offer-listings',
    rule: { kind: 'anonymous' },
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
    return readOfferListings(this.deps, context, input, 'none');
  }
}
