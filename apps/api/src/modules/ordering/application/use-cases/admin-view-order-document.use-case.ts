import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { ORDERING_ORDER_VIEW } from '../../contracts/permissions';
import type { OrderingDependencies } from '../checkout-flow';
import { anyOrderDocument, type DocumentFailure } from '../document-flow';
import type { OrderDocumentView } from '../../domain/order-document';

/** The document of any paid order of the Market (tax step 4; `permissions [ordering.order.view]`). */
export class AdminViewOrderDocument extends UseCase<
  { readonly orderId: unknown },
  OrderDocumentView,
  DocumentFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.admin-view-order-document',
    rule: { kind: 'permissions', allOf: [ORDERING_ORDER_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OrderingDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: { readonly orderId: unknown }) {
    return anyOrderDocument(this.deps, context, input);
  }
}
