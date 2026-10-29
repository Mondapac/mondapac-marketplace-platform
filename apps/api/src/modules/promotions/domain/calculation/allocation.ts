// Integer arithmetic of the discount calculation: floor shares of a basis-point ratio and the
// split of one amount over lines. No floating point and no banker's rounding anywhere: every
// share is floored and the remainder goes to the largest line.

/** `floor(amount * bps / 10000)` for a non-negative amount. */
export function floorShare(amount: bigint, bps: number): bigint {
  return (amount * BigInt(bps)) / 10000n;
}

export interface Distributable {
  readonly id: string;
  /** The line's value: shares follow the weights. */
  readonly weight: bigint;
  /** The most the line can take. */
  readonly cap: bigint;
}

/** Larger weight first; equal weights by the smaller id, so the order never depends on input order. */
function byWeightThenId(a: Distributable, b: Distributable): number {
  if (a.weight !== b.weight) return a.weight > b.weight ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Splits `total` over the items in proportion to their weights. Each item gets the floor of its
 * share, clamped to its cap; what is left (the rounding remainder, and anything a cap pushed
 * back) goes to the largest item that still has room, then to the next largest, and so on. The
 * total handed out is `min(total, sum of caps)`. Deterministic: ties are broken by id.
 */
export function distribute(total: bigint, items: readonly Distributable[]): Map<string, bigint> {
  const result = new Map<string, bigint>();
  const live = items.filter((item) => item.cap > 0n && item.weight > 0n).sort(byWeightThenId);
  for (const item of items) result.set(item.id, 0n);
  if (total <= 0n || live.length === 0) return result;

  const capacity = live.reduce((sum, item) => sum + item.cap, 0n);
  const target = total < capacity ? total : capacity;
  const weights = live.reduce((sum, item) => sum + item.weight, 0n);

  let given = 0n;
  for (const item of live) {
    const share = (target * item.weight) / weights;
    const take = share < item.cap ? share : item.cap;
    result.set(item.id, take);
    given += take;
  }
  let leftover = target - given;
  for (const item of live) {
    if (leftover === 0n) break;
    const room = item.cap - (result.get(item.id) ?? 0n);
    const take = room < leftover ? room : leftover;
    result.set(item.id, (result.get(item.id) ?? 0n) + take);
    leftover -= take;
  }
  return result;
}
