import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  sendOrderConfirmation,
  type OrderMailDependencies,
  type OrderMailFailure,
  type OrderMailInput,
  type OrderMailOutput,
} from '../order-mail-flow';

/**
 * The customer's "Order confirmation" mail (Q10), from the subscription
 * `notifications.order-confirmation-mail` on `ordering.order-paid.v1`. Rule `system`. The
 * address is read from identity at send time. A failure throws, so the outbox retries the
 * delivery; it never reaches the payment confirmation, which committed before.
 */
export class SendOrderConfirmationMail extends UseCase<
  OrderMailInput,
  OrderMailOutput,
  OrderMailFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'notifications.send-order-confirmation-mail',
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
    return sendOrderConfirmation(this.deps, context, input);
  }
}
