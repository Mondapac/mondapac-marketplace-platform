import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { DeliveryMethod } from '../../domain/delivery-method';

/**
 * Whether a delivery method may be used for a seller's part of an order: the one seam where the
 * platform-wide (per Market) switch and each seller's own capability (for example a seller
 * without instant capacity) will plug in. Order placement calls it for every seller order and
 * refuses a method it does not allow. Today every method is allowed for everyone; the admin
 * settings that make it real come later and replace the provider without touching ordering.
 * A failed read must answer false (fail closed).
 */
export interface DeliveryMethodPolicy {
  allows(context: CallContext, sellerId: Id<'Seller'>, method: DeliveryMethod): Promise<boolean>;
}

export const DELIVERY_METHOD_POLICY = Symbol('DELIVERY_METHOD_POLICY');
