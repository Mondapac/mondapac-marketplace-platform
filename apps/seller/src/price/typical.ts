'use client';

import { useEffect, useState } from 'react';
import { callApi } from '../api/client.ts';
import { minorOf } from './money.ts';

/** The answer of `GET pricing/seller/offers/:offerId/typical-prices` (Offer page PR 9). */
export interface TypicalPricesBody {
  readonly offerId: string;
  readonly variants: readonly {
    readonly variantId: string;
    readonly range: { readonly lowMinor: string; readonly highMinor: string } | null;
  }[];
}

/** The span other businesses sell a size in, in minor units of the Market currency. */
export interface TypicalRange {
  readonly lowMinor: string;
  readonly highMinor: string;
}

/** Where a price sits against the typical range; `null` is inside it or not known. */
export type Unusual = 'below' | 'above' | null;

/** The ranges by variant id; a size with no entry has no range (too few sellers, or none read). */
export type TypicalState = ReadonlyMap<string, TypicalRange>;

/** Minor units as the API writes them: digits only, so `BigInt` never throws on one. */
const MINOR = /^\d{1,19}$/;

const NONE: TypicalState = new Map();

/** The ranges the API gave, by size. A size without a range is left out: no reason is shown. */
export function typicalOf(body: TypicalPricesBody): TypicalState {
  const found = new Map<string, TypicalRange>();
  // An answer that is not the documented shape shows no range, as a failed read does.
  const lines: readonly unknown[] = Array.isArray(body?.variants) ? body.variants : [];
  for (const line of lines as readonly Partial<TypicalPricesBody['variants'][number]>[]) {
    const range = line?.range;
    if (
      typeof line?.variantId === 'string' &&
      typeof range?.lowMinor === 'string' &&
      typeof range.highMinor === 'string' &&
      MINOR.test(range.lowMinor) &&
      MINOR.test(range.highMinor)
    ) {
      found.set(line.variantId, { lowMinor: range.lowMinor, highMinor: range.highMinor });
    }
  }
  return found;
}

/**
 * Whether a price is below or above the typical range. The price is the text in the price field
 * (read as an amount) or, when nothing is typed, the saved price in minor units. An unfinished or
 * empty text, a missing range and a price inside the range (edges included) are not unusual. It
 * only informs: it never stops a save.
 */
export function unusualOf(
  range: TypicalRange | undefined,
  currency: string,
  fieldText: string | undefined,
  savedMinor: string | null,
): Unusual {
  if (range === undefined) return null;
  const minor = fieldText === undefined ? savedMinor : minorOf(fieldText, currency);
  if (minor === null) return null;
  const price = BigInt(minor);
  if (price < BigInt(range.lowMinor)) return 'below';
  if (price > BigInt(range.highMinor)) return 'above';
  return null;
}

/**
 * The typical price of each size of an offer, read once when the page opens. Off when `enabled` is
 * false (the seller may not see prices). A failed read, a refusal and a size nobody else sells all
 * look the same: no range, nothing shown, and the page works as before.
 */
export function useTypicalPrices(offerId: string, enabled: boolean): TypicalState {
  const [state, setState] = useState<TypicalState>(NONE);
  useEffect(() => {
    if (!enabled) {
      setState(NONE);
      return;
    }
    const controller = new AbortController();
    void callApi<TypicalPricesBody>(
      'GET',
      `pricing/seller/offers/${offerId}/typical-prices`,
      undefined,
      undefined,
      controller.signal,
    ).then((result) => {
      if (controller.signal.aborted) return;
      setState(result.ok ? typicalOf(result.body) : NONE);
    });
    return () => controller.abort();
  }, [enabled, offerId]);
  return state;
}
