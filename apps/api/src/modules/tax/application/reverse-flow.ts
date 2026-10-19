import { err, ok } from '@mondapac/shared-kernel';
import type { Result } from '@mondapac/shared-kernel';
import type { RefundTaxAnswer, TaxFailure } from '../contracts/tax.facade';
import { cumulativeShare, unitShares } from '../domain/reversal';

// The tax a refund reverses (tax design 4.8): pure arithmetic on the values `ordering` froze at
// placement, so the answer never depends on a strategy, a rate or the time it is asked. Every
// input is checked and the whole call is refused on one bad value (fail closed).

const MAX_LINES = 200;
const MAX_CHARGES = 10;
const MAX_AMOUNT = 2n ** 53n - 1n;
/** The order line's own limit (ordering migration: quantity 1 to 999). */
const MAX_QUANTITY = 999;

const isAmount = (value: unknown): value is bigint =>
  typeof value === 'bigint' && value >= 0n && value <= MAX_AMOUNT;
const isCount = (value: unknown, min: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= MAX_QUANTITY;

export function reverseRefundTax(input: {
  readonly lines: unknown;
  readonly charges: unknown;
}): Result<RefundTaxAnswer, TaxFailure> {
  const { lines, charges } = input ?? {};
  if (!Array.isArray(lines) || lines.length > MAX_LINES) {
    return err({ code: 'validation.failed', fields: [{ path: 'lines', code: 'range' }] });
  }
  if (!Array.isArray(charges) || charges.length > MAX_CHARGES) {
    return err({ code: 'validation.failed', fields: [{ path: 'charges', code: 'range' }] });
  }
  const fields: { path: string; code: string }[] = [];
  const lineTax = lines.map((line: Record<string, unknown> | null, index) => {
    const { tax, quantity, unitsBefore, units } = line ?? {};
    if (
      !isAmount(tax) ||
      !isCount(quantity, 1) ||
      !isCount(unitsBefore, 0) ||
      !isCount(units, 1) ||
      unitsBefore + units > quantity
    ) {
      fields.push({ path: `lines.${index}`, code: 'range' });
      return 0n;
    }
    return unitShares(tax, quantity, unitsBefore, units);
  });
  const chargeTax = charges.map((charge: Record<string, unknown> | null, index) => {
    const { tax, gross, before, after } = charge ?? {};
    if (
      !isAmount(tax) ||
      !isAmount(gross) ||
      !isAmount(before) ||
      !isAmount(after) ||
      tax > gross ||
      before > after ||
      after > gross
    ) {
      fields.push({ path: `charges.${index}`, code: 'range' });
      return 0n;
    }
    return cumulativeShare(tax, gross, before, after);
  });
  if (fields.length > 0) return err({ code: 'validation.failed', fields });
  return ok({ lines: lineTax, charges: chargeTax });
}
