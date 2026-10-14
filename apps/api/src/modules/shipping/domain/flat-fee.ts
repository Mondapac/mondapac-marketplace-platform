import { err, money, ok } from '@mondapac/shared-kernel';
import type { Money, Result } from '@mondapac/shared-kernel';

/** The most one flat fee may be, in minor units of the Market currency (A$1,000.00 in AU). */
export const MAX_FLAT_FEE_MINOR = 100_000n;

export type FlatFeeInvalid = { readonly code: 'validation.failed'; readonly path: 'amount' };

/**
 * A flat shipping fee from the wire: a whole number of minor units (a string of digits or a safe
 * integer), zero allowed on purpose (free shipping is a decision, not a gap), at most
 * {@link MAX_FLAT_FEE_MINOR}. The currency is always the Market's.
 */
export function parseFlatFee(amount: unknown, currency: string): Result<Money, FlatFeeInvalid> {
  let minor: bigint | null = null;
  if (typeof amount === 'number' && Number.isSafeInteger(amount) && amount >= 0) {
    minor = BigInt(amount);
  } else if (typeof amount === 'string' && /^(0|[1-9][0-9]{0,15})$/.test(amount)) {
    minor = BigInt(amount);
  }
  if (minor === null || minor > MAX_FLAT_FEE_MINOR) {
    return err({ code: 'validation.failed', path: 'amount' });
  }
  return ok(money(minor, currency));
}
