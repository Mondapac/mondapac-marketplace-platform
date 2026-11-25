import { err, money, ok } from '@mondapac/shared-kernel';
import type { Money, Result } from '@mondapac/shared-kernel';

/** 2^53 - 1: the largest amount the database CHECK and every client can hold exactly (P1). */
export const MAX_COST_MINOR = 9_007_199_254_740_991n;

/** A Cost was about to be serialised (logged, stringified or put in JSON) by accident. */
export class CostSerializationError extends Error {
  override readonly name = 'CostSerializationError';
  constructor() {
    super('Cost is private to pricing and cannot be serialised (pricing design 6.5)');
  }
}

const VALUE = Symbol('pricing.cost-amount');

/**
 * A seller's Cost of one unit (pricing design 2.2, 6.5; brief s5, Q7): in the Market currency,
 * above zero, at most {@link MAX_COST_MINOR}. Opaque: the money sits behind a module-private
 * symbol, and `toJSON`, `toString`, `valueOf` and the inspection hook throw, so a log line, an
 * event payload, an audit row or a response that receives one fails loudly instead of leaking it.
 * The only readers are {@link revealCostMinor} (the presenter and the repository) and
 * {@link sameCost}.
 */
export class CostAmount {
  readonly [VALUE]: Money;

  private constructor(value: Money) {
    this[VALUE] = value;
    Object.freeze(this);
  }

  /** @internal Only {@link costAmount} and {@link restoreCostAmount} build one. */
  static of(value: Money): CostAmount {
    return new CostAmount(value);
  }

  toJSON(): never {
    throw new CostSerializationError();
  }

  toString(): never {
    throw new CostSerializationError();
  }

  valueOf(): never {
    throw new CostSerializationError();
  }

  [Symbol.toPrimitive](): never {
    throw new CostSerializationError();
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return 'CostAmount [private]';
  }
}

export type CostAmountError =
  { readonly code: 'pricing.currency-mismatch' } | { readonly code: 'pricing.amount-out-of-range' };

/** A Cost from a seller's input: the Market currency, 1 to {@link MAX_COST_MINOR} minor units. */
export function costAmount(
  amount: bigint,
  currency: string,
  marketCurrency: string,
): Result<CostAmount, CostAmountError> {
  if (currency !== marketCurrency) return err({ code: 'pricing.currency-mismatch' });
  if (amount < 1n || amount > MAX_COST_MINOR) return err({ code: 'pricing.amount-out-of-range' });
  return ok(CostAmount.of(money(amount, currency)));
}

/** A stored Cost, read back by the repository (the database CHECKs held it in range). */
export function restoreCostAmount(amount: bigint, currency: string): CostAmount {
  if (amount < 1n || amount > MAX_COST_MINOR) throw new Error('cost record: amount out of range');
  return CostAmount.of(money(amount, currency));
}

/**
 * The minor units and currency of a Cost. Only the Cost presenter (the seller's own Cost route)
 * and the Cost repository call it; `pnpm boundaries` keeps the Cost types inside pricing.
 */
export function revealCostMinor(cost: CostAmount): {
  readonly amount: bigint;
  readonly currency: string;
} {
  const value = cost[VALUE];
  return { amount: value.amount, currency: value.currency };
}

/** Whether two Costs (or "none") are the same: a write of the current Cost records nothing. */
export function sameCost(a: CostAmount | null, b: CostAmount | null): boolean {
  if (a === null || b === null) return a === b;
  return a[VALUE].amount === b[VALUE].amount && a[VALUE].currency === b[VALUE].currency;
}
