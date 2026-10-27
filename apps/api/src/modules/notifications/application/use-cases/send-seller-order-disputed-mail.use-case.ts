import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  sendSellerOrderDisputed,
  type DisputedMailInput,
  type OrderMailDependencies,
  type OrderMailFailure,
  type OrderMailOutput,
} from '../order-mail-flow';

/**
 * The seller's "Payment dispute" mail (package 8b, D8), from the subscription
 * `notifications.seller-order-disputed-mail` on `commission-payouts.seller-order-disputed.v1`: one
 * mail to the Owner of the seller, with the order reference and no reason, amount, buyer or card
 * data. Rule `system`. Mail is at least once.
 */
export class SendSellerOrderDisputedMail extends UseCase<
  DisputedMailInput,
  OrderMailOutput,
  OrderMailFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'notifications.send-seller-order-disputed-mail',
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
    input: DisputedMailInput,
  ): Promise<Result<OrderMailOutput, OrderMailFailure>> {
    return sendSellerOrderDisputed(this.deps, context, input);
  }
}
