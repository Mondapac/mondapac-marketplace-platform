import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  sendItemUnavailableRefund,
  type OrderMailDependencies,
  type OrderMailFailure,
  type OrderMailOutput,
  type RefundMailInput,
} from '../order-mail-flow';

/**
 * The customer's "Part of your order is unavailable" mail, from the subscription
 * `notifications.item-unavailable-refund-mail` on `ordering.refund-succeeded.v1` (order detail
 * decision 6). Rule `system`. Only a refund of units a seller marked unavailable sends a mail; the
 * refund is read from ordering and the address from identity at send time. A failure throws, so
 * the outbox retries the delivery; it never reaches the refund, which committed before.
 */
export class SendItemUnavailableRefundMail extends UseCase<
  RefundMailInput,
  OrderMailOutput,
  OrderMailFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'notifications.send-item-unavailable-refund-mail',
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
    input: RefundMailInput,
  ): Promise<Result<OrderMailOutput, OrderMailFailure>> {
    return sendItemUnavailableRefund(this.deps, context, input);
  }
}
