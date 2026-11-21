// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { usePagedSavedFilters, type SavedFilter } from './saved.tsx';
import type { PagedListRuntime } from './types.ts';

const filter = (id: string): SavedFilter =>
  ({
    id,
    listKey: 'k',
    name: id,
    visibility: 'me',
    ownedByMe: true,
    canManage: true,
  }) as SavedFilter;

describe('usePagedSavedFilters', () => {
  it('keeps the newest answer when an older read lands last', async () => {
    const pending: Array<(items: SavedFilter[]) => void> = [];
    const callApi = vi.fn(
      () =>
        new Promise((resolve) => {
          pending.push((items) =>
            resolve({ ok: true, status: 200, body: { items, canShare: false } }),
          );
        }),
    );
    const runtime = {
      savedFiltersPath: 'lists/admin/saved-filters',
      callApi,
    } as unknown as PagedListRuntime;
    const { result } = renderHook(() => usePagedSavedFilters(runtime, 'k', true));
    await waitFor(() => expect(pending).toHaveLength(1));
    // A change of the filters reads them again while the first read is still out.
    let second: Promise<unknown> = Promise.resolve();
    act(() => {
      second = result.current.reload();
    });
    await waitFor(() => expect(pending).toHaveLength(2));
    await act(async () => {
      pending[1]?.([filter('new')]);
      await second;
    });
    await act(async () => {
      pending[0]?.([filter('old'), filter('new')]);
      await Promise.resolve();
    });
    expect(result.current.saved?.items.map((item) => item.id)).toEqual(['new']);
  });

  it('shows no saved filters while the list has none to read', () => {
    const runtime = { savedFiltersPath: 'p', callApi: vi.fn() } as unknown as PagedListRuntime;
    const { result } = renderHook(() => usePagedSavedFilters(runtime, undefined, true));
    expect(result.current.saved).toBeNull();
  });
});
