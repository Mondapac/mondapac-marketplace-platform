import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { DeliveryArea } from '../application/use-cases/delivery-area.use-case';
import type { FlatFees } from '../application/use-cases/flat-fees.use-case';
import type { ShippingFacade } from '../contracts';

/** Passes the caller's `CallContext` unchanged to one use case each, so the gate runs. */
export class ShippingFacadeImplementation implements ShippingFacade {
  constructor(
    private readonly fees: FlatFees,
    private readonly area: DeliveryArea,
  ) {}

  flatFees(context: CallContext, sellerIds: readonly Id<'Seller'>[]) {
    return this.fees.execute(context, { sellerIds });
  }

  async deliversTo(context: CallContext, postcode: string) {
    const result = await this.area.execute(context, { postcode });
    return result.ok
      ? ({ ok: true, value: result.value.delivers } as const)
      : ({
          ok: false,
          error: {
            code:
              result.error.code === 'validation.failed'
                ? 'validation.failed'
                : 'shipping.unavailable',
          },
        } as const);
  }
}
