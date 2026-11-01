import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { ShippingFacade } from '../../shipping';
import type { DeliveryMethodPolicy } from '../application/ports/delivery-method-policy';
import type { DeliveryMethod, DeliveryWindow } from '../domain/delivery-method';

/**
 * The {@link DeliveryMethodPolicy} on shipping's `deliveryChoice`: shipping owns the delivery
 * settings, so it decides whether the Market has the method on, the seller supports it, and the
 * method's own rule holds (a pickup address, the same-day cut-off in the seller's zone, a
 * scheduled window within the days ahead and of the set length). A refusal, a failed read or an
 * unexpected answer is "no" (fail closed).
 */
export class ShippingDeliveryMethodPolicy implements DeliveryMethodPolicy {
  constructor(private readonly shipping: ShippingFacade) {}

  async allows(
    context: CallContext,
    sellerId: Id<'Seller'>,
    method: DeliveryMethod,
    window: DeliveryWindow | null = null,
  ): Promise<boolean> {
    const verdict = await this.#verdict(context, sellerId, method, window);
    return verdict !== null && verdict.allowed === true;
  }

  async readyPrepMinutes(
    context: CallContext,
    sellerId: Id<'Seller'>,
    method: DeliveryMethod,
    window: DeliveryWindow | null = null,
  ): Promise<number | null> {
    const verdict = await this.#verdict(context, sellerId, method, window);
    const minutes = verdict?.readyPrepMinutes;
    return typeof minutes === 'number' && Number.isInteger(minutes) ? minutes : null;
  }

  async #verdict(
    context: CallContext,
    sellerId: Id<'Seller'>,
    method: DeliveryMethod,
    window: DeliveryWindow | null,
  ) {
    try {
      const verdict = await this.shipping.deliveryChoice(context, {
        sellerId,
        method,
        window:
          window === null ? null : { start: window.start.toString(), end: window.end.toString() },
      });
      return verdict.ok ? verdict.value : null;
    } catch {
      return null;
    }
  }
}
