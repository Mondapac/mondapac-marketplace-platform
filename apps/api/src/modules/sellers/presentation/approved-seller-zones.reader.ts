import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';
import type { ApprovedSellerZonesSystem } from '../application/use-cases/approved-seller-zones-system.use-case';
import type { ApprovedSellerZones } from '../application/use-cases/approved-seller-zones.use-case';
import type {
  ApprovedSellerZonesMap,
  ApprovedSellerZonesReader,
} from '../contracts/approved-seller-zones.contract';
import type { SellersUnavailable, SellersValidationFailed } from '../contracts/sellers.facade';

/** The use cases behind the reader: the `anonymous` case and its `system` pair. */
export interface ApprovedSellerZonesUseCases {
  readonly approvedSellerZones: ApprovedSellerZones;
  readonly approvedSellerZonesSystem: ApprovedSellerZonesSystem;
}

/**
 * The implementation of {@link ApprovedSellerZonesReader} (sellers design 7.1a): passes the
 * caller's `CallContext` unchanged to one use case of the pair, so the gate runs.
 */
export class ApprovedSellerZonesReaderImplementation implements ApprovedSellerZonesReader {
  constructor(private readonly useCases: ApprovedSellerZonesUseCases) {}

  approvedSellerZones(
    context: CallContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<
    Result<ApprovedSellerZonesMap, AccessDenied | SellersValidationFailed | SellersUnavailable>
  > {
    // The one decision: which of the pair. The gate still checks the rule.
    const useCase =
      context.actor.kind === 'system'
        ? this.useCases.approvedSellerZonesSystem
        : this.useCases.approvedSellerZones;
    return useCase.execute(context, { sellerIds });
  }
}
