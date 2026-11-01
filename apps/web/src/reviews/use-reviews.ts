'use client';

import { useCallback, useEffect, useState } from 'react';
import { readMyReviews, readToReview } from './reviews-api.ts';
import type { MyReviews, ToReview } from './reviews-model.ts';

/**
 * The buyer's reviews state on the account pages. `off`: the Market's reviews switch is off (or
 * the site is not on the API); nothing about reviews is shown. Reads once when the page opens.
 */
export type ReviewsState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'off' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'ready'; readonly toReview: ToReview; readonly mine: MyReviews };

export function useReviews(live: boolean): {
  readonly state: ReviewsState;
  readonly reload: () => void;
} {
  const [state, setState] = useState<ReviewsState>(live ? { kind: 'loading' } : { kind: 'off' });
  const [round, setRound] = useState(0);
  useEffect(() => {
    if (!live) return;
    let current = true;
    void Promise.all([readToReview(), readMyReviews()]).then(([toReview, mine]) => {
      if (!current) return;
      if (toReview.kind === 'ok' && mine.kind === 'ok') {
        setState({ kind: 'ready', toReview: toReview.value, mine: mine.value });
        return;
      }
      // `reviews.disabled` answers 404: the switch is off, so the pages stay quiet about reviews.
      const off = [toReview, mine].some(
        (result) => result.kind === 'invalid' && result.code === 'reviews.disabled',
      );
      setState(off ? { kind: 'off' } : { kind: 'failed' });
    });
    return () => {
      current = false;
    };
  }, [live, round]);
  const reload = useCallback(() => setRound((n) => n + 1), []);
  return { state, reload };
}

/** How many things wait for the buyer's review; null while unknown or when reviews are off. */
export function useWaitingCount(live: boolean): number | null {
  const { state } = useReviews(live);
  return state.kind === 'ready'
    ? state.toReview.products.length + state.toReview.sellerOrders.length
    : null;
}
