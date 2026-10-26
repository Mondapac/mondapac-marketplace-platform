import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { ORDERING_SELLER_ORDER_MARK_READY } from '../../contracts/permissions';
import type { OrderingDependencies } from '../checkout-flow';
import { markSellerOrderReady, type FulfilmentFailure } from '../fulfilment-flow';
import type { LabelledSellerOrderShipView } from '../../domain/order-views';

/**
 * The seller tells the platform that one of its paid seller orders is ready. The seller chooses
 * no delivery method or provider and never delivers; the platform books the delivery from the
 * buyer's method. Idempotent. The seller comes from the session and the order must be its own.
 */
export class SellerMarkOrderReady extends UseCase<
  { readonly sellerOrderId: unknown },
  LabelledSellerOrderShipView,
  FulfilmentFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.seller-mark-order-ready',
    rule: { kind: 'permissions', allOf: [ORDERING_SELLER_ORDER_MARK_READY.key] },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OrderingDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: { readonly sellerOrderId: unknown }) {
    return markSellerOrderReady(this.deps, context, input);
  }
}
