import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { ORDERING_SELLER_ORDER_SHIP } from '../../contracts/permissions';
import type { OrderingDependencies } from '../checkout-flow';
import { shipSellerOrder, type FulfilmentFailure } from '../fulfilment-flow';
import type { SellerOrderDetailView } from '../../domain/order-views';

/** The seller records the shipment of one of its paid seller orders: carrier and an optional tracking reference (SHP-01). */
export class SellerShipOrder extends UseCase<
  { readonly sellerOrderId: unknown; readonly carrier: unknown; readonly trackingRef: unknown },
  SellerOrderDetailView,
  FulfilmentFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.seller-ship-order',
    rule: { kind: 'permissions', allOf: [ORDERING_SELLER_ORDER_SHIP.key] },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OrderingDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: {
      readonly sellerOrderId: unknown;
      readonly carrier: unknown;
      readonly trackingRef: unknown;
    },
  ) {
    return shipSellerOrder(this.deps, context, input);
  }
}
