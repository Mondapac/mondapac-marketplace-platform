import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { ShippingFacade } from '../../shipping';
import type { ShipmentCarrierProgress } from '../domain/admin-shipment-list';
import type {
  CarrierProgressAnswer,
  CarrierProgressReader,
} from '../application/ports/carrier-progress.reader';

/** A new answer each time: a shared Map could be changed by one caller for every other. */
const notAvailable = (): CarrierProgressAnswer => ({ available: false, progress: new Map() });

/**
 * {@link CarrierProgressReader} over shipping's `carrierProgressOf`: ONE call with the distinct
 * ids of the page (a page holds at most 100, shipping's cap). shipping's `access.denied` is the
 * expected answer for an admin without `shipping.carrier-delivery.view` (an empty answer, not
 * available); `validation.failed` and `shipping.unavailable` throw, and the caller shows no
 * progress. Only the ids asked for are kept; an extra id in the answer is ignored.
 */
export class FacadeCarrierProgressReader implements CarrierProgressReader {
  constructor(private readonly shipping: ShippingFacade) {}

  async progressOf(
    context: CallContext,
    sellerOrderIds: readonly Id<'SellerOrder'>[],
  ): Promise<CarrierProgressAnswer> {
    const requested = new Set(sellerOrderIds);
    if (requested.size === 0) return { available: true, progress: new Map() };
    const answer = await this.shipping.carrierProgressOf(context, [...requested]);
    if (!answer.ok) {
      if (answer.error.code === 'access.denied') return notAvailable();
      throw new Error(`shipping.carrierProgressOf: ${answer.error.code}`);
    }
    const progress = new Map<Id<'SellerOrder'>, ShipmentCarrierProgress>();
    for (const [sellerOrderId, value] of answer.value) {
      if (!requested.has(sellerOrderId)) continue;
      progress.set(sellerOrderId, {
        progress: value.progress,
        carrierStatus: value.carrierStatus,
        updatedAt: value.updatedAt,
        proofOfDelivery: value.proofOfDelivery,
        fleet: value.fleet,
      });
    }
    return { available: true, progress };
  }
}
