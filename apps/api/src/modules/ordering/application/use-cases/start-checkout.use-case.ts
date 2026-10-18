import { Logger } from '@nestjs/common';
import { err } from '@mondapac/shared-kernel';
import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  startCheckout,
  type CheckoutStarted,
  type OrderingDependencies,
  type StartCheckoutFailure,
  type StartCheckoutInput,
} from '../checkout-flow';
import { customerAccountId } from '../customer-caller';

/**
 * Turns the signed-in customer's cart into a pending order, with a fixed copy of the chosen
 * delivery address, and a hosted payment page.
 */
export class StartCheckout extends UseCase<
  StartCheckoutInput,
  CheckoutStarted,
  StartCheckoutFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.start-checkout',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  readonly #logger = new Logger('StartCheckout');

  constructor(
    gate: UseCaseGate,
    private readonly deps: OrderingDependencies,
  ) {
    super(gate);
  }

  protected async handle(context: CallContext, input: StartCheckoutInput) {
    const accountId = customerAccountId(context);
    if (accountId === null) return err({ code: 'access.denied' } as const);
    const result = await startCheckout(this.deps, context, accountId, input);
    if (!result.ok && result.error.code === 'ordering.shipping-unavailable') {
      // A seller has no flat shipping fee: an admin must set one before anything can be sold.
      this.#logger.warn({
        msg: 'ordering.shipping-fee-missing',
        marketId: context.market.marketId,
        correlationId: context.correlationId,
        sellerIds: result.error.sellerIds,
      });
    }
    return result;
  }
}
