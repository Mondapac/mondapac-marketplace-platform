import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  sendOrderReadyForPickup,
  type OrderMailDependencies,
  type OrderMailFailure,
  type ReadyMailInput,
  type OrderMailOutput,
} from '../order-mail-flow';

/**
 * The customer's "Ready for pickup" mail, from the subscription `notifications.order-ready-mail` on
 * `ordering.seller-order-ready.v1`. Rule `system`. The delivery method is read from
 * ordering and the address from identity at send time. A failure throws, so the outbox retries
 * the delivery; it never reaches the ready mark, which committed before.
 */
export class SendOrderReadyMail extends UseCase<ReadyMailInput, OrderMailOutput, OrderMailFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'notifications.send-order-ready-mail',
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
    input: ReadyMailInput,
  ): Promise<Result<OrderMailOutput, OrderMailFailure>> {
    return sendOrderReadyForPickup(this.deps, context, input);
  }
}
