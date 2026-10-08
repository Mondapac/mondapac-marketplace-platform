import { compareMoney, err, ok } from '@mondapac/shared-kernel';
import type { Money, Result } from '@mondapac/shared-kernel';
import type { PricingPolicy } from './pricing-policy';

/**
 * A `Money` that passed `PriceLimits` (pricing design 2.2, 4.4): in the Market currency, above
 * zero, at most the Market maximum. Its only factory takes the policy, so no record holds an
 * amount that was not checked.
 */
export type PriceAmount = Money & { readonly __priceAmount: true };

export type PriceAmountError =
  { readonly code: 'pricing.currency-mismatch' } | { readonly code: 'pricing.amount-out-of-range' };

export function priceAmount(
  value: Money,
  policy: PricingPolicy,
): Result<PriceAmount, PriceAmountError> {
  if (value.currency !== policy.currency) return err({ code: 'pricing.currency-mismatch' });
  if (value.amount < 1n || compareMoney(value, policy.maxUnitPrice) > 0) {
    return err({ code: 'pricing.amount-out-of-range' });
  }
  return ok(Object.freeze({ ...value }) as PriceAmount);
}
