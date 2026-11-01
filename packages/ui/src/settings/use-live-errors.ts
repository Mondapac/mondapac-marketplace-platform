'use client';

import { useCallback, useState } from 'react';

export interface LiveErrors<K extends string> {
  /**
   * The fields to show as wrong now, in the order given: those that fail the check at this
   * moment and that the user has edited or left, or all of them after a Save attempt. The page
   * hands this list to its error summary and its save bar, so Save stays disabled while it is
   * not empty.
   */
  readonly shown: readonly K[];
  readonly has: (key: K) => boolean;
  /** The user edited or left this field: from now on it shows its error as soon as it fails. */
  readonly touch: (key: K) => void;
  /** Forget that the field was edited (its value was reset by the page, not typed). */
  readonly untouch: (key: K) => void;
  /** Save was pressed: every failing field shows, and `attempts` rises so the summary can take focus. */
  readonly attempt: () => void;
  /** Discard or a successful save: nothing has been edited or attempted any more. */
  readonly reset: () => void;
  /** Counts Save presses since the last reset; the error summary's `focusSignal`. */
  readonly attempts: number;
}

/**
 * Live validation for a settings page. The page recomputes which fields fail from its draft on
 * every render and passes them here; the hook decides which of them to show. A field shows its
 * error once the user has typed in it or left it (not before: an untouched, loaded value is not
 * nagged), and the error goes away the moment the value is right. Nothing is stored or sent.
 */
export function useLiveErrors<K extends string>(failing: readonly K[]): LiveErrors<K> {
  const [touched, setTouched] = useState<ReadonlySet<K>>(() => new Set());
  const [attempts, setAttempts] = useState(0);

  const touch = useCallback((key: K) => {
    setTouched((current) => (current.has(key) ? current : new Set(current).add(key)));
  }, []);
  const untouch = useCallback((key: K) => {
    setTouched((current) => {
      if (!current.has(key)) return current;
      const next = new Set(current);
      next.delete(key);
      return next;
    });
  }, []);
  const attempt = useCallback(() => setAttempts((n) => n + 1), []);
  const reset = useCallback(() => {
    setTouched(new Set());
    setAttempts(0);
  }, []);

  const shown = attempts > 0 ? failing : failing.filter((key) => touched.has(key));
  return {
    shown,
    has: (key) => shown.includes(key),
    touch,
    untouch,
    attempt,
    reset,
    attempts,
  };
}
