import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  sendSellerNewOrders,
  type OrderMailDependencies,
  type OrderMailFailure,
  type OrderMailInput,
  type OrderMailOutput,
} from '../order-mail-flow';

/**
 * The sellers' "New order" mail (Q10), from the subscription
 * `notifications.seller-new-order-mail` on `ordering.order-paid.v1`: one mail to the Owner of
 * each seller order, with the order reference and that seller's own lines, and no customer data.
 * Rule `system`. Mail is at least once: after a failed send the retry may repeat the mail to a
 * seller that already got it.
 */
export class SendSellerNewOrderMail extends UseCase<
  OrderMailInput,
  OrderMailOutput,
  OrderMailFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'notifications.send-seller-new-order-mail',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OrderMailDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: OrderMailInput,
  ): Promise<Result<OrderMailOutput, OrderMailFailure>> {
    return sendSellerNewOrders(this.deps, context, input);
  }
}
