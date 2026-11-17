import { err } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { checkoutCustomerOf } from '../caller';
import type { PromotionsDependencies } from '../promotions-dependencies';
import {
  redeem,
  type RedeemFailure,
  type RedeemInput,
  type RedeemOutput,
} from '../redemption-flow';

/**
 * `promotions.redeem-own-discounts`: the checkout saga's redemption under the signed-in
 * customer's `CallContext` (rule `own-resources`, customers only, never an acting-as session).
 * The same redemption as `promotions.redeem-discounts`; the customer named must be the session's
 * account, and the quote it repeats is never a test order's.
 *
 * In-process only, for ordering's checkout: `isFirstOrder` and `orderCommission` come from the
 * caller, so this use case must never get a controller or an AI tool.
 */
export class RedeemOwnDiscounts extends UseCase<RedeemInput, RedeemOutput, RedeemFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'promotions.redeem-own-discounts',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PromotionsDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: RedeemInput,
  ): Promise<Result<RedeemOutput, RedeemFailure>> {
    const customer = checkoutCustomerOf(context);
    if (customer === null || input?.customerAccountId !== customer) {
      return Promise.resolve(err({ code: 'access.denied' }));
    }
    const named = input.request?.customerAccountId;
    if (named !== undefined && named !== null && named !== customer) {
      return Promise.resolve(err({ code: 'access.denied' }));
    }
    if (input.request?.testMode !== false) {
      return Promise.resolve(
        err({ code: 'validation.failed', fields: [{ path: 'request.testMode', code: 'value' }] }),
      );
    }
    return redeem(this.deps, context, {
      ...input,
      request: { ...input.request, customerAccountId: customer },
    });
  }
}
