import { err } from '@mondapac/shared-kernel';
import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { OrderingDependencies } from '../checkout-flow';
import { customerAccountId } from '../customer-caller';
import type { OrderPageView, OrderView } from '../../domain/order-views';
import { listOwnOrders, type ListInput, type ReadFailure } from '../read-flow';

/** The signed-in customer's own orders, newest first, keyset-paged. */
export class ListOrders extends UseCase<ListInput, OrderPageView<OrderView>, ReadFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.list-orders',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OrderingDependencies,
  ) {
    super(gate);
  }

  protected async handle(context: CallContext, input: ListInput) {
    const accountId = customerAccountId(context);
    if (accountId === null) return err({ code: 'access.denied' } as const);
    return listOwnOrders(this.deps, context, accountId, input);
  }
}
