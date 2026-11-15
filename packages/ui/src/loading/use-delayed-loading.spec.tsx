// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LOADING_MIN_VISIBLE_MS,
  LOADING_SHOW_DELAY_MS,
  LOADING_SLOW_MS,
  LOADING_STALLED_MS,
  useDelayedLoading,
} from './use-delayed-loading.ts';

// Panel loading L1, timing approved by the owner: nothing for 200 ms, then at least 400 ms;
// "Still loading…" at 10 s and the load error at 30 s.

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const advance = (ms: number) =>
  act(() => {
    vi.advanceTimersByTime(ms);
  });

describe('useDelayedLoading', () => {
  it('shows nothing for a loading shorter than the delay', () => {
    const { result, rerender } = renderHook(({ loading }) => useDelayedLoading(loading), {
      initialProps: { loading: true },
    });
    advance(LOADING_SHOW_DELAY_MS - 1);
    expect(result.current.visible).toBe(false);
    rerender({ loading: false });
    advance(LOADING_SHOW_DELAY_MS * 5);
    expect(result.current.visible).toBe(false);
  });

  it('once shown, stays for the minimum even when the data comes at once', () => {
    const { result, rerender } = renderHook(({ loading }) => useDelayedLoading(loading), {
      initialProps: { loading: true },
    });
    advance(LOADING_SHOW_DELAY_MS);
    expect(result.current.visible).toBe(true);
    advance(50);
    rerender({ loading: false });
    expect(result.current.visible).toBe(true);
    advance(LOADING_MIN_VISIBLE_MS - 51);
    expect(result.current.visible).toBe(true);
    advance(1);
    expect(result.current.visible).toBe(false);
  });

  it('hides at once when shown for longer than the minimum', () => {
    const { result, rerender } = renderHook(({ loading }) => useDelayedLoading(loading), {
      initialProps: { loading: true },
    });
    advance(LOADING_SHOW_DELAY_MS + LOADING_MIN_VISIBLE_MS);
    rerender({ loading: false });
    advance(0);
    expect(result.current.visible).toBe(false);
  });

  it('keeps a held skeleton up when loading starts again, with no new delay', () => {
    const { result, rerender } = renderHook(({ loading }) => useDelayedLoading(loading), {
      initialProps: { loading: true },
    });
    advance(LOADING_SHOW_DELAY_MS);
    rerender({ loading: false });
    advance(100);
    rerender({ loading: true });
    advance(LOADING_MIN_VISIBLE_MS);
    expect(result.current.visible).toBe(true);
  });

  it('is slow at 10 s and stalled at 30 s, and neither once loading ends', () => {
    const { result, rerender } = renderHook(({ loading }) => useDelayedLoading(loading), {
      initialProps: { loading: true },
    });
    advance(LOADING_SLOW_MS - 1);
    expect(result.current.slow).toBe(false);
    advance(1);
    expect(result.current.slow).toBe(true);
    expect(result.current.stalled).toBe(false);
    advance(LOADING_STALLED_MS - LOADING_SLOW_MS);
    expect(result.current.stalled).toBe(true);
    rerender({ loading: false });
    expect(result.current.slow).toBe(false);
    expect(result.current.stalled).toBe(false);
  });

  it('after a re-entry during the hold, hides when the second load ends (minimum already met)', () => {
    const { result, rerender } = renderHook(({ loading }) => useDelayedLoading(loading), {
      initialProps: { loading: true },
    });
    advance(LOADING_SHOW_DELAY_MS);
    rerender({ loading: false });
    advance(100);
    rerender({ loading: true });
    advance(LOADING_MIN_VISIBLE_MS);
    rerender({ loading: false });
    advance(0);
    expect(result.current.visible).toBe(false);
  });

  it('does not restart its clocks when the caller passes a new options object', () => {
    const { result, rerender } = renderHook(
      ({ loading }) => useDelayedLoading(loading, { delay: LOADING_SHOW_DELAY_MS }),
      { initialProps: { loading: true } },
    );
    advance(LOADING_SHOW_DELAY_MS - 50);
    rerender({ loading: true });
    advance(50);
    expect(result.current.visible).toBe(true);
  });

  it('leaves no timer behind when unmounted while loading', () => {
    const { unmount } = renderHook(() => useDelayedLoading(true));
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
