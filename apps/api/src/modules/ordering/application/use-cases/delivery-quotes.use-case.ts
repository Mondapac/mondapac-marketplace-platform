import { err } from '@mondapac/shared-kernel';
import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { customerAccountId } from '../customer-caller';
import type { OrderingDependencies } from '../checkout-flow';
import {
  deliveryQuotes,
  type DeliveryQuotesFailure,
  type DeliveryQuotesInput,
  type SellerDeliveryOptions,
} from '../delivery-quotes-flow';

export type { MethodPrice, SellerDeliveryOptions } from '../delivery-quotes-flow';

/**
 * The delivery methods and prices of the signed-in customer's basket for a saved address: each
 * seller's four methods (open or not, with the reason) and the quote of each delivering method.
 * The quotes are stored by shipping and bound to the order at checkout; no price comes from the
 * client.
 */
export class DeliveryQuotes extends UseCase<
  DeliveryQuotesInput,
  readonly SellerDeliveryOptions[],
  DeliveryQuotesFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.delivery-quotes',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OrderingDependencies,
  ) {
    super(gate);
  }

  protected async handle(context: CallContext, input: DeliveryQuotesInput) {
    const accountId = customerAccountId(context);
    if (accountId === null) return err({ code: 'access.denied' } as const);
    return deliveryQuotes(this.deps, context, input);
  }
}
