'use client';

import { useEffect, useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { minorOf } from './money.ts';
import type { VariantPrice } from './types.ts';

/** The answer of `GET pricing/seller/offers/:offerId/receive-estimates` (Offer page PR 4). */
export interface ReceiveEstimatesView {
  readonly offerId: string;
  readonly currency: string;
  readonly taxInclusive: boolean;
  readonly lines: readonly {
    readonly variantId: string;
    readonly priceMinor: string;
    readonly commissionMinor: string;
    readonly youReceiveMinor: string;
  }[];
}

/** One size's estimate: what the customer pays now, the commission and what the seller receives. */
export interface ReceiveEstimate {
  readonly customerPaysMinor: string;
  readonly commissionMinor: string;
  readonly youReceiveMinor: string;
  /** False when the Market's prices exclude tax: the amounts are then before tax. */
  readonly taxInclusive: boolean;
}

/** The API takes at most this many sizes in one read; more sizes are read in several. */
const MAX_LINES = 20;
/** The largest amount the API estimates (10^12 minor units); a larger typed price shows none. */
const MAX_MINOR = 10n ** 12n;
/** Typing waits this long before the estimate is read again. */
export const ESTIMATE_DELAY_MS = 400;

/**
 * What a customer pays now for one unit of a size, in minor units: a running special price wins
 * (it is what the shop charges), else the price typed in the row when it reads as an amount,
 * else the price in force. Null when there is none, or when the typed text is not an amount: the
 * row then shows no estimate rather than one for a price the seller is still typing.
 */
export function customerPaysMinor(
  price: VariantPrice | null,
  draft: string | undefined,
  currency: string,
): string | null {
  if (price?.retired === true) return null;
  if (price?.special?.state === 'running') return price.special.amount;
  const minor =
    draft !== undefined
      ? draft.trim() === ''
        ? null
        : minorOf(draft, currency)
      : (price?.inForce?.amount ?? null);
  return minor !== null && BigInt(minor) <= MAX_MINOR ? minor : null;
}

/**
 * The `lines` queries of the amounts that have one, sorted: one per {@link MAX_LINES} sizes, so an
 * Offer with many sizes is read in several requests and no size is left out.
 */
export function linesQueries(amounts: Readonly<Record<string, string | null>>): string[] {
  const pairs = Object.entries(amounts)
    .filter((entry): entry is [string, string] => entry[1] !== null)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([variantId, minor]) => `${variantId}:${minor}`);
  const queries: string[] = [];
  for (let i = 0; i < pairs.length; i += MAX_LINES) {
    queries.push(pairs.slice(i, i + MAX_LINES).join(','));
  }
  return queries;
}

export type EstimateState =
  | { readonly kind: 'off' }
  | {
      readonly kind: 'ready';
      readonly bySize: ReadonlyMap<string, ReceiveEstimate>;
      /** The Market's price convention, once an answer said it; null before the first one. */
      readonly taxInclusive: boolean | null;
    }
  /** The product has no published tax category yet: no estimate until it is published. */
  | { readonly kind: 'no-category' }
  | { readonly kind: 'unavailable' };

/**
 * "You receive (est.)" of each size whose customer price is known, read from the API when the
 * amounts change (after {@link ESTIMATE_DELAY_MS}, so typing does not send a read per key). The
 * last answer stays while a newer one is read; an answer for older amounts is dropped. A failed
 * read (refused, unavailable, no network) is `unavailable`: the page shows no money then. Off when
 * `enabled` is false: nothing is read.
 */
export function useReceiveEstimates(
  offerId: string,
  amounts: Readonly<Record<string, string | null>>,
  enabled: boolean,
): EstimateState {
  const queries = enabled ? linesQueries(amounts) : [];
  const key = queries.join('|');
  const [state, setState] = useState<EstimateState>(
    enabled ? { kind: 'ready', bySize: new Map(), taxInclusive: null } : { kind: 'off' },
  );
  const latest = useRef(key);
  latest.current = key;

  useEffect(() => {
    if (!enabled) {
      setState({ kind: 'off' });
      return;
    }
    if (key === '') {
      setState((old) => ({
        kind: 'ready',
        bySize: new Map(),
        taxInclusive: old.kind === 'ready' ? old.taxInclusive : null,
      }));
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void Promise.all(
        key
          .split('|')
          .map((query) =>
            callApi<ReceiveEstimatesView>(
              'GET',
              `pricing/seller/offers/${offerId}/receive-estimates?lines=${encodeURIComponent(query)}`,
              undefined,
              undefined,
              controller.signal,
            ),
          ),
      ).then((results) => {
        // An answer for amounts the page no longer shows is dropped.
        if (controller.signal.aborted || latest.current !== key) return;
        const failed = results.find((result) => !result.ok);
        if (failed !== undefined && !failed.ok) {
          setState(
            failed.failure.code === 'pricing.estimate-no-tax-category'
              ? { kind: 'no-category' }
              : { kind: 'unavailable' },
          );
          return;
        }
        const bySize = new Map<string, ReceiveEstimate>();
        let taxInclusive: boolean | null = null;
        for (const result of results) {
          if (!result.ok) continue;
          taxInclusive = result.body.taxInclusive;
          for (const line of result.body.lines) {
            bySize.set(line.variantId, {
              customerPaysMinor: line.priceMinor,
              commissionMinor: line.commissionMinor,
              youReceiveMinor: line.youReceiveMinor,
              taxInclusive: result.body.taxInclusive,
            });
          }
        }
        setState({ kind: 'ready', bySize, taxInclusive });
      });
    }, ESTIMATE_DELAY_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [enabled, offerId, key]);

  return state;
}

/**
 * The estimate of one size, only when it is for the amount the row shows now: while a new read is
 * on its way the old number is not shown against a new price.
 */
export function estimateFor(
  state: EstimateState,
  variantId: string,
  amount: string | null,
): ReceiveEstimate | null {
  if (state.kind !== 'ready' || amount === null) return null;
  const found = state.bySize.get(variantId);
  return found !== undefined && found.customerPaysMinor === amount ? found : null;
}

/**
 * The last estimate read for a size, whatever its amount: shown muted while the estimate for a
 * newly typed price is read, so the number does not blink to a dash at each key.
 */
export function lastEstimateFor(state: EstimateState, variantId: string): ReceiveEstimate | null {
  return state.kind === 'ready' ? (state.bySize.get(variantId) ?? null) : null;
}
