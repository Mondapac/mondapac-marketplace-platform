import { callApi } from '../api/client.ts';
import { priceProblemOf } from '../price/errors.ts';
import type { PriceWritten, SpecialWritten } from '../price/types.ts';
import { levelsProblemOf } from '../stock/levels-errors.ts';
import type { StockSet } from '../stock/levels-types.ts';
import { isStepUpCancelled, type GuardedCall } from '../step-up/step-up.tsx';
import { specialKey, stockKey, type TableRow, type Write } from './variants-table-logic.ts';

/** What one save of an offer's price and stock cells did. */
export interface SizeWritesOutcome {
  /** The message of each cell the server refused, by its key (variant id or stock key). */
  readonly found: Record<string, string>;
  /** How many writes the server took. */
  readonly done: number;
  /** The two-step code was cancelled or the server asked to slow down: the rest was not sent. */
  readonly stopped: boolean;
  /** Seconds to wait after "too many requests", else null. */
  readonly waitSeconds: number | null;
  /** The session ended: the caller leaves for the session-ended page. */
  readonly signedOut: boolean;
  /** The variant ids whose price was saved and the stock keys whose stock was saved. */
  readonly savedPrices: readonly string[];
  readonly savedStocks: readonly string[];
  /** The variant ids whose new special price was saved, and those that wait for review. */
  readonly savedSpecials: readonly string[];
  readonly heldSpecials: readonly string[];
  /** The newest version of each written series (`price:<variant>`, `stock:<key>`). */
  readonly seen: Record<string, number | null>;
}

/** The messages a refused cell shows, in the caller's language. */
export interface SizeWriteMessages {
  readonly throttledCell: string;
  readonly price: (problem: string) => string;
  readonly stock: (problem: string) => string;
}

/**
 * Sends the price, special price and stock writes of one offer, one request per cell, through the same pricing
 * and inventory routes as the price and stock pages (Offer page and its quick entry table). The
 * server decides every write: a refused cell gets its message and the rest go on; "too many
 * requests" or a cancelled two-step code stops here and leaves the rest as drafts.
 */
export async function sendSizeWrites({
  offerId,
  rows,
  writes,
  currency,
  versions,
  csrfToken,
  guarded,
  messages,
}: {
  readonly offerId: string;
  readonly rows: readonly TableRow[];
  readonly writes: readonly Write[];
  readonly currency: string;
  /** Versions already seen by earlier saves without a refresh in between. */
  readonly versions: Readonly<Record<string, number | null>>;
  readonly csrfToken: string;
  readonly guarded: GuardedCall;
  readonly messages: SizeWriteMessages;
}): Promise<SizeWritesOutcome> {
  const found: Record<string, string> = {};
  const seen = { ...versions };
  const savedPrices: string[] = [];
  const savedStocks: string[] = [];
  const savedSpecials: string[] = [];
  const heldSpecials: string[] = [];
  let done = 0;
  let stopped = false;
  let waitSeconds: number | null = null;
  const outcome = (signedOut: boolean): SizeWritesOutcome => ({
    found,
    done,
    stopped,
    waitSeconds,
    signedOut,
    savedPrices,
    savedStocks,
    savedSpecials,
    heldSpecials,
    seen,
  });
  for (const write of writes) {
    const row = rows.find((item) => item.variantId === write.variantId);
    if (row === undefined) continue;
    if (write.kind === 'special') {
      // The special shares the size's price series: the version a price write just moved is used.
      const key = `price:${write.variantId}`;
      const expectedVersion =
        key in seen ? (seen[key] ?? null) : (row.price?.seriesVersion ?? null);
      // Its regular price was refused in this save, or the size has no price series yet: the
      // special stays a draft, unsent, and the price cell says why.
      if (found[write.variantId] !== undefined || expectedVersion === null) continue;
      const result = await guarded<SpecialWritten>(
        'PUT',
        `pricing/seller/offers/${offerId}/variants/${write.variantId}/special-price`,
        {
          amount: write.amount,
          currency,
          startsAt: write.startsAt,
          endsAt: write.endsAt,
          expectedVersion,
        },
        csrfToken,
      );
      if (isStepUpCancelled(result)) {
        stopped = true;
        break;
      }
      if (!result.ok) {
        if (result.failure.status === 401) return outcome(true);
        if (result.failure.code === 'request.throttled') {
          waitSeconds = result.failure.details?.retryAfterSeconds ?? 60;
          found[specialKey.amount(write.variantId)] = messages.throttledCell;
          stopped = true;
          break;
        }
        const problem = priceProblemOf(result.failure);
        // A start in the past is the start's fault, a bad window the end's; the rest the amount's.
        const where =
          problem === 'past'
            ? specialKey.start(write.variantId)
            : problem === 'window'
              ? specialKey.end(write.variantId)
              : specialKey.amount(write.variantId);
        found[where] = messages.price(problem);
        continue;
      }
      seen[key] = result.body.seriesVersion;
      savedSpecials.push(write.variantId);
      if (result.body.status === 'pending-review') heldSpecials.push(write.variantId);
      done += 1;
    } else if (write.kind === 'price') {
      const key = `price:${write.variantId}`;
      const expectedVersion =
        key in seen ? (seen[key] ?? null) : (row.price?.seriesVersion ?? null);
      const result = await guarded<PriceWritten>(
        'PUT',
        `pricing/seller/offers/${offerId}/variants/${write.variantId}/regular-price`,
        { amount: write.amount, currency, expectedVersion },
        csrfToken,
      );
      if (isStepUpCancelled(result)) {
        stopped = true;
        break;
      }
      if (!result.ok) {
        if (result.failure.status === 401) return outcome(true);
        if (result.failure.code === 'request.throttled') {
          // Stop here: this cell and every one after it stay drafts, nothing is retried.
          waitSeconds = result.failure.details?.retryAfterSeconds ?? 60;
          found[write.variantId] = messages.throttledCell;
          stopped = true;
          break;
        }
        found[write.variantId] = messages.price(priceProblemOf(result.failure));
        continue;
      }
      seen[key] = result.body.seriesVersion;
      savedPrices.push(write.variantId);
      done += 1;
    } else {
      const key = stockKey(write.variantId, write.sourceId);
      const vkey = `stock:${key}`;
      const expectedVersion =
        vkey in seen ? (seen[vkey] ?? null) : (row.stock[write.sourceId]?.version ?? null);
      const result = await callApi<StockSet>(
        'PUT',
        `inventory/seller/offers/${offerId}/variants/${write.variantId}/sources/${write.sourceId}/stock`,
        { onHand: write.onHand, expectedVersion },
        csrfToken,
      );
      if (!result.ok) {
        if (result.failure.status === 401) return outcome(true);
        if (result.failure.code === 'request.throttled') {
          waitSeconds = result.failure.details?.retryAfterSeconds ?? 60;
          found[key] = messages.throttledCell;
          stopped = true;
          break;
        }
        found[key] = messages.stock(levelsProblemOf(result.failure));
        continue;
      }
      seen[vkey] = result.body.version;
      savedStocks.push(key);
      done += 1;
    }
  }
  return outcome(false);
}
