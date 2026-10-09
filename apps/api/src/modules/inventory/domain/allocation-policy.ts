import type { Id } from '@mondapac/shared-kernel';

// Source allocation for a reservation (inventory design 4.2 step 6, Q3, Q9): the first source in
// the seller's priority order that fits the whole line; a line is never split.

export interface AllocationCandidate {
  readonly stockItemId: Id<'StockItem'>;
  /** Sellable on this item now: on hand minus held, at least 0. */
  readonly sellable: number;
}

export interface AllocationRequest {
  readonly offerId: Id<'Offer'>;
  readonly variantId: Id<'Variant'>;
  readonly quantity: number;
  /** The sell unit's non-retired items in the seller's source priority order. */
  readonly candidates: readonly AllocationCandidate[];
}

export type LineFailureReason = 'out' | 'not-enough' | 'over-limit' | 'retired';

export interface LineFailure {
  readonly offerId: Id<'Offer'>;
  readonly variantId: Id<'Variant'>;
  readonly reason: LineFailureReason;
}

export interface Allocation {
  readonly offerId: Id<'Offer'>;
  readonly variantId: Id<'Variant'>;
  readonly quantity: number;
  readonly stockItemId: Id<'StockItem'>;
}

export type AllocationResult =
  | { readonly ok: true; readonly allocations: readonly Allocation[] }
  | { readonly ok: false; readonly failures: readonly LineFailure[] };

/**
 * Allocates every line in request order, deducting what earlier lines took from a shared item (two
 * lines never share a sell unit, but an item is only ever counted once). `out` when no source has
 * anything left, `not-enough` when some has, but too little. All lines fit or none is allocated.
 */
export const AllocationPolicy = {
  allocate(requests: readonly AllocationRequest[]): AllocationResult {
    const taken = new Map<Id<'StockItem'>, number>();
    const allocations: Allocation[] = [];
    const failures: LineFailure[] = [];
    for (const request of requests) {
      const left = request.candidates.map((candidate) => ({
        id: candidate.stockItemId,
        left: candidate.sellable - (taken.get(candidate.stockItemId) ?? 0),
      }));
      const chosen = left.find((candidate) => candidate.left >= request.quantity);
      if (chosen === undefined) {
        failures.push({
          offerId: request.offerId,
          variantId: request.variantId,
          reason: left.some((candidate) => candidate.left > 0) ? 'not-enough' : 'out',
        });
        continue;
      }
      taken.set(chosen.id, (taken.get(chosen.id) ?? 0) + request.quantity);
      allocations.push({
        offerId: request.offerId,
        variantId: request.variantId,
        quantity: request.quantity,
        stockItemId: chosen.id,
      });
    }
    return failures.length > 0 ? { ok: false, failures } : { ok: true, allocations };
  },
} as const;
