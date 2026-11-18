import { err } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { checkoutCustomerOf } from '../caller';
import type { PromotionsFailure } from '../failures';
import type { PromotionsDependencies } from '../promotions-dependencies';
import type { QuoteRequest, QuoteResult } from '../../contracts/promotions.facade';
import { quote } from '../quote-flow';

/**
 * `promotions.quote-own-discounts`: the discounts of the signed-in customer's own checkout, as
 * ordering asks for them under the customer's `CallContext` (rule `own-resources`, customers
 * only, never an acting-as session). The same calculation as `promotions.quote-discounts`, with
 * two things the caller cannot choose: the customer is the session's account (the request's
 * `customerAccountId` must be absent or that account) and the order is never a test order.
 *
 * In-process only, for ordering's checkout: `isFirstOrder` and `orderCommission` come from the
 * caller, so this use case must never get a controller or an AI tool.
 */
export class QuoteOwnDiscounts extends UseCase<QuoteRequest, QuoteResult, PromotionsFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'promotions.quote-own-discounts',
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
    input: QuoteRequest,
  ): Promise<Result<QuoteResult, PromotionsFailure>> {
    const customer = checkoutCustomerOf(context);
    if (customer === null) return Promise.resolve(err({ code: 'access.denied' }));
    const named = input?.customerAccountId;
    if (named !== undefined && named !== null && named !== customer) {
      return Promise.resolve(err({ code: 'access.denied' }));
    }
    if (input?.testMode !== false) {
      return Promise.resolve(
        err({ code: 'validation.failed', fields: [{ path: 'testMode', code: 'value' }] }),
      );
    }
    return quote(this.deps, context, { ...input, customerAccountId: customer }, false);
  }
}
