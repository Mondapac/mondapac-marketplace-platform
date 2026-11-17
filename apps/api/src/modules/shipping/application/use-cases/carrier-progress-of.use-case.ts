import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SHIPPING_CARRIER_DELIVERY_VIEW } from '../../contracts/permissions';
import type { CarrierProgressView } from '../../domain/carrier-progress';
import { readCarrierProgress, type CarrierProgressFailure } from '../carrier-progress-flow';
import type { ShippingDependencies } from '../shipping-dependencies';

type Input = { readonly sellerOrderIds: unknown };

/**
 * `shipping.carrier-progress-of`: where the carrier deliveries of some seller orders stand, for
 * the admin Shipments list. Rule `permissions [shipping.carrier-delivery.view]` under the admin's
 * own context (never `system`, never `own-resources`): a platform key, so a seller or customer
 * actor is always refused. Not exposed over HTTP; `ordering` calls it through the facade.
 */
export class CarrierProgressOf extends UseCase<
  Input,
  ReadonlyMap<Id<'SellerOrder'>, CarrierProgressView>,
  CarrierProgressFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'shipping.carrier-progress-of',
    rule: { kind: 'permissions', allOf: [SHIPPING_CARRIER_DELIVERY_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ShippingDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: Input,
  ): Promise<Result<ReadonlyMap<Id<'SellerOrder'>, CarrierProgressView>, CarrierProgressFailure>> {
    return readCarrierProgress(this.deps, context, input);
  }
}
