import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { ShipmentCarrierProgress } from '../../domain/admin-shipment-list';

/** The answer of {@link CarrierProgressReader.progressOf}. */
export interface CarrierProgressAnswer {
  /** False when the caller may not see carrier progress (no key): `progress` is then empty. */
  readonly available: boolean;
  /** Only seller orders that were asked for and have a carrier booking. */
  readonly progress: ReadonlyMap<Id<'SellerOrder'>, ShipmentCarrierProgress>;
}

/**
 * Where the real-time carrier deliveries of a page of seller orders stand, read through
 * shipping's facade with the caller's `CallContext` unchanged (the admin Shipments list). Called
 * once per page, after the list's read unit has closed. Advisory: the caller never fails the
 * list on it. An admin without shipping's key answers `available: false`; any other refusal or
 * failure throws.
 */
export interface CarrierProgressReader {
  progressOf(
    context: CallContext,
    sellerOrderIds: readonly Id<'SellerOrder'>[],
  ): Promise<CarrierProgressAnswer>;
}

export const CARRIER_PROGRESS_READER = Symbol('CARRIER_PROGRESS_READER');
