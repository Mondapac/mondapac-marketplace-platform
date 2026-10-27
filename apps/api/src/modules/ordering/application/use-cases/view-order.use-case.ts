import { err } from '@mondapac/shared-kernel';
import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { OrderingDependencies } from '../checkout-flow';
import { customerAccountId } from '../customer-caller';
import type { LabelledOwnOrderView } from '../../domain/order-views';
import { viewOwnOrder, type ReadFailure } from '../read-flow';

/** One of the signed-in customer's own orders, with its delivery address. */
export class ViewOrder extends UseCase<
  { readonly orderId: unknown },
  LabelledOwnOrderView,
  ReadFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.view-order',
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
    return viewOwnOrder(this.deps, context, accountId, input);
  }
}
