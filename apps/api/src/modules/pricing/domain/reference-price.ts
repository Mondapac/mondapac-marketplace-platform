import type { Id } from '@mondapac/shared-kernel';

/**
 * R4 of the risk-based Offer approval (design section 6, "قیمت مرجع"; ADR-0051): a seller's first
 * regular price on a Variant is measured against the reference price of that Variant, the median of
 * the regular prices (never the specials) of the other live Offers on it. Pure: the use case reads
 * the prices, the businesses and the Market's settings; this decides. Exact integer arithmetic only
 * (ADR-0007 decision 2): the median of an even count is kept as a half, never rounded before the
 * comparison.
 */

/** One reference candidate: the regular price in force of another live Offer on the Variant. */
export interface ReferenceCandidate {
  /**
   * The business behind the Offer. One approved seller is one business: `sellers` lets only one
   * approved seller hold a business identifier (ABN) per Market, and a seller whose claim is in
   * conflict is not eligible to sell (sellers design 3.6; `sellingEligibility`).
   */
  readonly sellerId: Id<'Seller'>;
  /** Minor units of the Market currency, 1 or more. */
  readonly amountMinor: bigint;
}

/**
 * The reference price: the median of one price per business, as an exact fraction of minor units
 * (`doubledMinor / 2`), and how many distinct businesses formed it.
 */
export interface ReferencePrice {
  readonly doubledMinor: bigint;
  readonly businesses: number;
}

export type ReferenceAnswer =
  /** Fewer distinct businesses than the Market needs: the first price is not measured. */
  | { readonly kind: 'no-reference'; readonly businesses: number }
  | { readonly kind: 'reference'; readonly reference: ReferencePrice };

/** Lower median of a non-empty sorted list, as `doubled` minor units (exact). */
function doubledMedian(sorted: readonly bigint[]): bigint {
  const n = sorted.length;
  const mid = Math.floor(n / 2);
  if (n % 2 === 1) return (sorted[mid] as bigint) * 2n;
  return (sorted[mid - 1] as bigint) + (sorted[mid] as bigint);
}

const ascending = (a: bigint, b: bigint): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The reference price of a Variant from the candidates, or `no-reference` when fewer than
 * `neededBusinesses` distinct businesses price it. A business with several Offers on the Variant
 * counts once, with the lower median of its own prices, so one business cannot move the median by
 * listing the same thing many times (design 9, "دستکاری قیمت مرجع").
 */
export function referencePrice(
  candidates: readonly ReferenceCandidate[],
  neededBusinesses: number,
): ReferenceAnswer {
  if (!Number.isSafeInteger(neededBusinesses) || neededBusinesses < 1) {
    throw new RangeError('reference price: the number of businesses must be a positive integer');
  }
  const byBusiness = new Map<string, bigint[]>();
  for (const candidate of candidates) {
    if (candidate.amountMinor < 1n)
      throw new RangeError('reference price: a price is not positive');
    const list = byBusiness.get(candidate.sellerId) ?? [];
    list.push(candidate.amountMinor);
    byBusiness.set(candidate.sellerId, list);
  }
  const businesses = byBusiness.size;
  if (businesses < neededBusinesses) return { kind: 'no-reference', businesses };
  const perBusiness = [...byBusiness.values()].map((prices) => {
    const sorted = [...prices].sort(ascending);
    return sorted[Math.floor((sorted.length - 1) / 2)] as bigint;
  });
  return {
    kind: 'reference',
    reference: { doubledMinor: doubledMedian(perBusiness.sort(ascending)), businesses },
  };
}

/** The reference rounded half up to whole minor units, for display and the stored copy. */
export function referenceAmountMinor(reference: ReferencePrice): bigint {
  return (reference.doubledMinor + 1n) / 2n;
}

export type ReferenceVerdict =
  { readonly kind: 'within' } | { readonly kind: 'outside'; readonly direction: 'up' | 'down' };

/**
 * Whether a price is more than `bandPercent` above or below the reference. "More than" is strict,
 * so exactly the band edge is within (as the jump policy). Cross-multiplied: up when
 * `c * 200 > doubled * (100 + X)`, down when `c * 200 < doubled * (100 - X)`; a band of 100 or
 * more never holds a fall.
 */
export function measureAgainstReference(
  candidateMinor: bigint,
  reference: ReferencePrice,
  bandPercent: number,
): ReferenceVerdict {
  if (!Number.isSafeInteger(bandPercent) || bandPercent < 1) {
    throw new RangeError('reference price: the band must be a positive whole percent');
  }
  const band = BigInt(bandPercent);
  const scaled = candidateMinor * 200n;
  if (scaled > reference.doubledMinor * (100n + band)) return { kind: 'outside', direction: 'up' };
  if (scaled < reference.doubledMinor * (100n - band)) {
    return { kind: 'outside', direction: 'down' };
  }
  return { kind: 'within' };
}
