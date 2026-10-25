import type { DeliveryMethodPolicy } from '../application/ports/delivery-method-policy';

/** The default {@link DeliveryMethodPolicy}: every method is allowed for every seller. */
export class AllowAllDeliveryMethods implements DeliveryMethodPolicy {
  allows(): Promise<boolean> {
    return Promise.resolve(true);
  }
}
