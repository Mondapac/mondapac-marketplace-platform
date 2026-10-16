import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  sendOrderShipped,
  type OrderMailDependencies,
  type OrderMailFailure,
  type ShippedMailInput,
  type OrderMailOutput,
} from '../order-mail-flow';

/**
 * The customer's "Shipped" mail, from the subscription `notifications.order-shipped-mail` on
 * `ordering.order-shipped.v1`. Rule `system`. The carrier and tracking number are read from
 * ordering and the address from identity at send time. A failure throws, so the outbox retries
 * the delivery; it never reaches the shipment, which committed before.
 */
export class SendOrderShippedMail extends UseCase<
  ShippedMailInput,
  OrderMailOutput,
  OrderMailFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'notifications.send-order-shipped-mail',
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
    input: ShippedMailInput,
  ): Promise<Result<OrderMailOutput, OrderMailFailure>> {
    return sendOrderShipped(this.deps, context, input);
  }
}
