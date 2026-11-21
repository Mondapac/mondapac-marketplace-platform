// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useBaseTabCounts } from './use-base-tab-counts.ts';

type Counts = { readonly all: number };

describe('useBaseTabCounts', () => {
  it('uses the live counts while no saved filter is open and never loads', () => {
    const load = vi.fn();
    const { result } = renderHook(() =>
      useBaseTabCounts<Counts>({ savedId: null, live: { all: 14 }, load }),
    );
    expect(result.current).toEqual({ all: 14 });
    expect(load).not.toHaveBeenCalled();
  });

  it('shows the unfiltered counts, not the narrowed live ones, while a saved filter is open', async () => {
    const load = vi.fn().mockResolvedValue({ all: 14 });
    const { result, rerender } = renderHook(
      ({ savedId, live }: { savedId: string | null; live: Counts }) =>
        useBaseTabCounts<Counts>({ savedId, live, load }),
      { initialProps: { savedId: null as string | null, live: { all: 14 } } },
    );
    rerender({ savedId: 'oil', live: { all: 2 } });
    // No narrowed number is ever shown.
    expect(result.current).toBeNull();
    await waitFor(() => expect(result.current).toEqual({ all: 14 }));
    rerender({ savedId: 'oil', live: { all: 2 } });
    expect(result.current).toEqual({ all: 14 });
    expect(load).toHaveBeenCalledTimes(1);

    rerender({ savedId: null, live: { all: 14 } });
    expect(result.current).toEqual({ all: 14 });
  });

  it('drops an answer that arrives after the saved filter closed', async () => {
    let resolve: (value: Counts) => void = () => {};
    const load = vi.fn(() => new Promise<Counts>((r) => (resolve = r)));
    const { result, rerender } = renderHook(
      ({ savedId }: { savedId: string | null }) =>
        useBaseTabCounts<Counts>({ savedId, live: { all: 5 }, load }),
      { initialProps: { savedId: 'a' } },
    );
    rerender({ savedId: null });
    await act(() => {
      resolve({ all: 99 });
      return Promise.resolve();
    });
    expect(result.current).toEqual({ all: 5 });
  });
});
