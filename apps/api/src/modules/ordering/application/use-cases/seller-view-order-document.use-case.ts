import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { ORDERING_SELLER_ORDER_VIEW } from '../../contracts/permissions';
import type { OrderingDependencies } from '../checkout-flow';
import { ownSellerOrderDocument, type DocumentFailure } from '../document-flow';
import type { OrderDocumentView } from '../../domain/order-document';

/** The document of the seller's own part of a paid order (tax step 4). */
export class SellerViewOrderDocument extends UseCase<
  { readonly sellerOrderId: unknown },
  OrderDocumentView,
  DocumentFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.seller-view-order-document',
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
    return ownSellerOrderDocument(this.deps, context, input);
  }
}
