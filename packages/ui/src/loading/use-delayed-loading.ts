'use client';

import { useEffect, useRef, useState } from 'react';

/** Panel loading timing (design: panel-loading plan, section 4; approved by the owner). */
export const LOADING_SHOW_DELAY_MS = 200;
/** Once shown, a loading state stays at least this long so it never flashes. */
export const LOADING_MIN_VISIBLE_MS = 400;
/** After this the page adds "Still loading…" under the skeleton. */
export const LOADING_SLOW_MS = 10_000;
/** After this the page gives up and shows LoadError with Try again. */
export const LOADING_STALLED_MS = 30_000;

export interface DelayedLoading {
  /** Show the skeleton (or spinner): loading for longer than the delay, or held for the minimum. */
  readonly visible: boolean;
  /** Loading for longer than {@link LOADING_SLOW_MS}: add "Still loading…". */
  readonly slow: boolean;
  /** Loading for longer than {@link LOADING_STALLED_MS}: show the load error instead. */
  readonly stalled: boolean;
}

export interface DelayedLoadingOptions {
  readonly delay?: number;
  readonly minVisible?: number;
  readonly slowAfter?: number;
  readonly stalledAfter?: number;
}

/**
 * Turns "is loading" into what the page shows. Nothing shows for the first 200 ms, so a fast
 * answer never flashes a skeleton; once a skeleton shows it stays at least 400 ms, so it never
 * blinks. A loading that runs long is marked slow at 10 s and stalled at 30 s. Not for buttons:
 * a button shows its spinner at once.
 */
export function useDelayedLoading(
  loading: boolean,
  {
    delay = LOADING_SHOW_DELAY_MS,
    minVisible = LOADING_MIN_VISIBLE_MS,
    slowAfter = LOADING_SLOW_MS,
    stalledAfter = LOADING_STALLED_MS,
  }: DelayedLoadingOptions = {},
): DelayedLoading {
  const [visible, setVisible] = useState(false);
  const [slow, setSlow] = useState(false);
  const [stalled, setStalled] = useState(false);
  // When the loading state became visible, to hold it for the minimum.
  const shownAt = useRef<number | null>(null);
  // Read when a timer starts, so a caller passing a new options object never restarts the clocks.
  const timing = useRef({ delay, minVisible, slowAfter, stalledAfter });
  timing.current = { delay, minVisible, slowAfter, stalledAfter };
  // The latest value, read by the timers: a timer that fires after the render that ended the
  // loading but before its effect cleared the timers (passive effects run after paint) must not
  // show the skeleton again over the loaded page.
  const current = useRef(loading);
  current.current = loading;

  useEffect(() => {
    const { delay, minVisible, slowAfter, stalledAfter } = timing.current;
    if (loading) {
      const timers = [
        setTimeout(() => current.current && setSlow(true), slowAfter),
        setTimeout(() => current.current && setStalled(true), stalledAfter),
      ];
      // A loading that starts again while a held skeleton is still up keeps it up, no new delay;
      // its minimum still counts from when it first showed, so it can go as soon as this ends.
      if (shownAt.current === null) {
        timers.push(
          setTimeout(() => {
            if (!current.current) return;
            shownAt.current = Date.now();
            setVisible(true);
          }, delay),
        );
      }
      return () => timers.forEach(clearTimeout);
    }
    setSlow(false);
    setStalled(false);
    if (shownAt.current === null) {
      setVisible(false);
      return undefined;
    }
    const hide = setTimeout(
      () => {
        shownAt.current = null;
        setVisible(false);
      },
      Math.max(0, minVisible - (Date.now() - shownAt.current)),
    );
    return () => clearTimeout(hide);
  }, [loading]);

  return { visible, slow: loading && slow, stalled: loading && stalled };
}
