import { err, money, ok } from '@mondapac/shared-kernel';
import type { Money, Result } from '@mondapac/shared-kernel';

/**
 * The Market values a minimum order is checked against (sellers design 18 decision 3): the
 * Market currency and the largest amount, in minor units of that currency.
 */
export interface MinimumOrderRule {
  readonly currency: string;
  readonly max: bigint;
}

/** `minimum-order.currency`: not the Market's currency. `minimum-order.amount`: not 1..max. */
export type MinimumOrderRefusal =
  { readonly code: 'minimum-order.currency' } | { readonly code: 'minimum-order.amount' };

/**
 * Parses the `minimumOrder` of a request: `null` (or absent) clears it; otherwise `{ amount,
 * currency }` where the amount is a JSON integer (a string is refused), a safe integer, above
 * zero and at most the Market's upper bound, and the currency is the Market's. The currency is
 * compared with the actor's Market, never assumed. Nothing is echoed.
 */
export function parseMinimumOrder(
  value: unknown,
  rule: MinimumOrderRule,
): Result<Money | null, MinimumOrderRefusal> {
  if (value === null || value === undefined) return ok(null);
  if (typeof value !== 'object' || Array.isArray(value)) {
    return err({ code: 'minimum-order.amount' });
  }
  const { amount, currency } = value as { amount?: unknown; currency?: unknown };
  if (currency !== rule.currency) return err({ code: 'minimum-order.currency' });
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 1) {
    return err({ code: 'minimum-order.amount' });
  }
  if (BigInt(amount) > rule.max) return err({ code: 'minimum-order.amount' });
  return ok(money(BigInt(amount), rule.currency));
}
