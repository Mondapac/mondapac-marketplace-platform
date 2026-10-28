import type { CallContext, Id, Money } from '@mondapac/shared-kernel';
import type { CheckWasPrice } from '../application/use-cases/check-was-price.use-case';
import type { QuoteDiscounts } from '../application/use-cases/quote-discounts.use-case';
import type { Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';
import type { PromotionsFailure } from '../application/use-cases/quote-discounts.use-case';
import type { PromotionsFacade, PromotionsFacadeFailure, QuoteRequest } from '../contracts';

/** What other modules see: anything a caller cannot act on is "unavailable", and callers fail closed. */
function outward<T>(
  result: Result<T, AccessDenied | PromotionsFailure>,
): Result<T, PromotionsFacadeFailure> {
  if (result.ok) return result;
  const error = result.error;
  if (error.code === 'validation.failed' || error.code === 'promotions.disabled') {
    return { ok: false, error };
  }
  if (error.code.startsWith('access.') && error.code !== 'access.unavailable') {
    return { ok: false, error: error as AccessDenied };
  }
  return { ok: false, error: { code: 'promotions.unavailable' } };
}

/** Passes the caller's `CallContext` unchanged to one use case, so the gate runs. */
export class PromotionsFacadeImplementation implements PromotionsFacade {
  constructor(
    private readonly quoteDiscounts: QuoteDiscounts,
    private readonly wasPrice: CheckWasPrice,
  ) {}

  quote(context: CallContext, request: QuoteRequest) {
    return this.quoteDiscounts.execute(context, request).then(outward);
  }

  wasPriceEligible(context: CallContext, productId: Id<'Product'>, price: Money) {
    return this.wasPrice
      .execute(context, {
        productId,
        price: { amountMinor: price.amount, currency: price.currency },
      })
      .then(outward);
  }
}
