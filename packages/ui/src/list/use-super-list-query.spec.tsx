// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSuperListQuery } from './use-super-list-query.ts';

interface Q {
  readonly view: string;
  readonly q: string;
  readonly status: string;
  readonly sort: string;
  readonly days: number;
  readonly page: number;
}
const DEFAULT: Q = { view: 'all', q: '', status: '', sort: 'created', days: 30, page: 1 };
const SAVED: Q = { view: 'all', q: 'rice', status: 'paid', sort: 'name', days: 7, page: 1 };

const options = {
  defaultQuery: DEFAULT,
  forView: (view: string): Q => ({ ...DEFAULT, view }),
  withView: (query: Q, view: string): Q => ({ ...query, view }),
  searchOf: (query: Q) => query.q,
  withSearch: (query: Q, q: string): Q => ({ ...query, q }),
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('useSuperListQuery: a saved filter belongs to its own tab', () => {
  it('opens a built-in tab from a saved tab with the list defaults, not the saved search, filters, sort or days', () => {
    const { result } = renderHook(() => useSuperListQuery(options));
    act(() => result.current.openSaved('saved-1', SAVED));
    expect(result.current.savedId).toBe('saved-1');
    expect(result.current.draft).toBe('rice');

    act(() => result.current.openView('paid'));
    expect(result.current.savedId).toBeNull();
    expect(result.current.query).toEqual({ ...DEFAULT, view: 'paid' });
    expect(result.current.draft).toBe('');
  });

  it('keeps the filters when one built-in tab goes to another (no saved tab on show)', () => {
    const { result } = renderHook(() => useSuperListQuery(options));
    act(() => result.current.change({ status: 'paid' }));
    act(() => result.current.openView('open'));
    expect(result.current.query).toMatchObject({ view: 'open', status: 'paid', page: 1 });
  });

  it('leaves the saved tab as soon as the search, a filter or the sort changes', () => {
    const { result } = renderHook(() => useSuperListQuery(options));
    act(() => result.current.openSaved('saved-1', SAVED));
    act(() => result.current.change({ sort: 'created' }));
    expect(result.current.savedId).toBeNull();

    act(() => result.current.openSaved('saved-1', SAVED));
    act(() => result.current.setDraft('flour'));
    act(() => void vi.advanceTimersByTime(300));
    expect(result.current.savedId).toBeNull();
    expect(result.current.query.q).toBe('flour');
  });

  it('keeps the saved tab when only the page changes', () => {
    const { result } = renderHook(() => useSuperListQuery(options));
    act(() => result.current.openSaved('saved-1', SAVED));
    act(() => result.current.goToPage(3));
    expect(result.current.savedId).toBe('saved-1');
    expect(result.current.query.page).toBe(3);
  });

  it('goes back to page 1 when the filters change', () => {
    const { result } = renderHook(() => useSuperListQuery(options));
    act(() => result.current.goToPage(4));
    act(() => result.current.change({ status: 'paid' }));
    expect(result.current.query.page).toBe(1);
  });
});
