import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { ORDERING_SELLER_ORDER_VIEW } from '../../contracts/permissions';
import type { OrderingDependencies } from '../checkout-flow';
import { viewSellerOrder, type FulfilmentFailure } from '../fulfilment-flow';
import type { LabelledSellerOrderDetailView } from '../../domain/order-views';

/** One of the seller's own paid seller orders. */
export class SellerViewOrder extends UseCase<
  { readonly sellerOrderId: unknown },
  LabelledSellerOrderDetailView,
  FulfilmentFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.seller-view-order',
    rule: { kind: 'permissions', allOf: [ORDERING_SELLER_ORDER_VIEW.key] },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OrderingDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: { readonly sellerOrderId: unknown }) {
    return viewSellerOrder(this.deps, context, input);
  }
}
