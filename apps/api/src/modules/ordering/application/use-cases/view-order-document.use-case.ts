import { err } from '@mondapac/shared-kernel';
import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { OrderingDependencies } from '../checkout-flow';
import { customerAccountId } from '../customer-caller';
import { ownOrderDocument, type DocumentFailure } from '../document-flow';
import type { OrderDocumentView } from '../../domain/order-document';

export type { OrderDocumentView };

/** The document of one of the signed-in customer's own paid orders (tax step 4). */
export class ViewOrderDocument extends UseCase<
  { readonly orderId: unknown },
  OrderDocumentView,
  DocumentFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.view-order-document',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OrderingDependencies,
  ) {
    super(gate);
  }

  protected async handle(context: CallContext, input: { readonly orderId: unknown }) {
    const accountId = customerAccountId(context);
    if (accountId === null) return err({ code: 'access.denied' } as const);
    return ownOrderDocument(this.deps, context, accountId, input);
  }
}
