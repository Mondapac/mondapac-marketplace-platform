import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { DeliveryMethod, DeliveryWindow } from '../../domain/delivery-method';

/**
 * Whether a delivery method may be used for a seller's part of an order: the one seam where the
 * platform-wide (per Market) switch and each seller's own capability plug in. Order placement
 * calls it for every seller order and refuses a method it does not allow. The provider is
 * shipping's delivery settings: allowed = the Market has the method on, an admin gave it to the
 * seller, and the method's rule holds now (pickup needs an approved pickup address, same day only
 * before the cut-off in the seller's zone, a scheduled `window` within the days ahead and of the
 * configured length). `window` is the buyer's window for `scheduled` and null for every other
 * method. A failed read must answer false (fail closed).
 */
export interface DeliveryMethodPolicy {
  allows(
    context: CallContext,
    sellerId: Id<'Seller'>,
    method: DeliveryMethod,
    window?: DeliveryWindow | null,
  ): Promise<boolean>;

  /**
   * The minutes the Market gives the seller to get this seller order ready (seller health, late
   * ready), asked once the method is allowed. Null when it cannot be read: the order is then
   * placed without a promise and is never counted late (fail to the seller's side, not closed).
   */
  readyPrepMinutes(
    context: CallContext,
    sellerId: Id<'Seller'>,
    method: DeliveryMethod,
    window?: DeliveryWindow | null,
  ): Promise<number | null>;
}

export const DELIVERY_METHOD_POLICY = Symbol('DELIVERY_METHOD_POLICY');
