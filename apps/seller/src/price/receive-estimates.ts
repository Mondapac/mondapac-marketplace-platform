'use client';

import { useEffect, useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { minorOf } from './money.ts';
import type { VariantPrice } from './types.ts';

/** The keys the estimate needs: the price view and the seller ledger (the commission is its data). */
export const RECEIVE_ESTIMATE_PERMISSIONS = [
  'pricing.price.view',
  'commission-payouts.earnings.view',
] as const;

/** True when the seller may see "You receive (est.)". */
export function canEstimateReceive(permissionKeys: readonly string[]): boolean {
  return RECEIVE_ESTIMATE_PERMISSIONS.every((key) => permissionKeys.includes(key));
}

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

/** The API takes at most this many sizes in one read. */
const MAX_LINES = 20;
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
  if (draft !== undefined) return draft.trim() === '' ? null : minorOf(draft, currency);
  return price?.inForce?.amount ?? null;
}

/** The `lines` query of the amounts that have one, sorted, at most {@link MAX_LINES}. */
export function linesQuery(amounts: Readonly<Record<string, string | null>>): string {
  return Object.entries(amounts)
    .filter((entry): entry is [string, string] => entry[1] !== null)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, MAX_LINES)
    .map(([variantId, minor]) => `${variantId}:${minor}`)
    .join(',');
}

export type EstimateState =
  | { readonly kind: 'off' }
  | { readonly kind: 'ready'; readonly bySize: ReadonlyMap<string, ReceiveEstimate> }
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
  const query = enabled ? linesQuery(amounts) : '';
  const [state, setState] = useState<EstimateState>(
    enabled ? { kind: 'ready', bySize: new Map() } : { kind: 'off' },
  );
  const latest = useRef(query);
  latest.current = query;

  useEffect(() => {
    if (!enabled) {
      setState({ kind: 'off' });
      return;
    }
    if (query === '') {
      setState({ kind: 'ready', bySize: new Map() });
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void callApi<ReceiveEstimatesView>(
        'GET',
        `pricing/seller/offers/${offerId}/receive-estimates?lines=${encodeURIComponent(query)}`,
        undefined,
        undefined,
        controller.signal,
      ).then((result) => {
        if (controller.signal.aborted || latest.current !== query) return;
        if (!result.ok) {
          setState({ kind: 'unavailable' });
          return;
        }
        const bySize = new Map<string, ReceiveEstimate>();
        for (const line of result.body.lines) {
          bySize.set(line.variantId, {
            customerPaysMinor: line.priceMinor,
            commissionMinor: line.commissionMinor,
            youReceiveMinor: line.youReceiveMinor,
            taxInclusive: result.body.taxInclusive,
          });
        }
        setState({ kind: 'ready', bySize });
      });
    }, ESTIMATE_DELAY_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [enabled, offerId, query]);

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
