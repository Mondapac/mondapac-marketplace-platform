// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useRowSelection } from './use-row-selection.ts';

afterEach(() => cleanup());

const ids = (count: number, from = 0) => Array.from({ length: count }, (_, i) => `id-${from + i}`);

describe('useRowSelection', () => {
  it('ticks and unticks one row at a time', () => {
    const { result } = renderHook(() => useRowSelection(ids(3), 5, 'a'));
    act(() => result.current.toggleRow('id-1'));
    expect([...result.current.selected]).toEqual(['id-1']);
    act(() => result.current.toggleRow('id-1'));
    expect(result.current.selected.size).toBe(0);
  });

  it('ticks the page up to the cap, then ticks nothing more and reports it is full', () => {
    const { result } = renderHook(() => useRowSelection(ids(4), 3, 'a'));
    act(() => result.current.togglePage(true));
    expect([...result.current.selected]).toEqual(['id-0', 'id-1', 'id-2']);
    expect(result.current.full).toBe(true);
    act(() => result.current.toggleRow('id-3'));
    expect(result.current.selected.has('id-3')).toBe(false);
    // A ticked row can still be cleared, which frees a place.
    act(() => result.current.toggleRow('id-0'));
    expect(result.current.full).toBe(false);
    act(() => result.current.toggleRow('id-3'));
    expect(result.current.selected.has('id-3')).toBe(true);
  });

  it('clears the rows of the page from the header box, keeping rows of other pages', () => {
    const { result, rerender } = renderHook(({ page }) => useRowSelection(page, 10, 'a'), {
      initialProps: { page: ids(2) },
    });
    act(() => result.current.togglePage(true));
    rerender({ page: ids(2, 2) });
    act(() => result.current.togglePage(true));
    expect(result.current.selected.size).toBe(4);
    act(() => result.current.togglePage(false));
    expect([...result.current.selected]).toEqual(['id-0', 'id-1']);
  });

  it('takes the whole filter, and leaving it keeps the page except the row unticked', () => {
    const { result } = renderHook(() => useRowSelection(ids(3), 5, 'a'));
    act(() => result.current.selectAllMatching());
    expect(result.current.allMatching).toBe(true);
    expect(result.current.full).toBe(false);
    act(() => result.current.toggleRow('id-1'));
    expect(result.current.allMatching).toBe(false);
    expect([...result.current.selected]).toEqual(['id-0', 'id-2']);
  });

  it('leaves the whole filter from the header box without keeping any row', () => {
    const { result } = renderHook(() => useRowSelection(ids(3), 5, 'a'));
    act(() => result.current.selectAllMatching());
    act(() => result.current.togglePage(true));
    expect(result.current.allMatching).toBe(true);
    act(() => result.current.togglePage(false));
    expect(result.current.allMatching).toBe(false);
    expect(result.current.selected.size).toBe(0);
  });

  it('clears everything on request and when the list changes, not when the page does', () => {
    const { result, rerender } = renderHook(({ page, key }) => useRowSelection(page, 5, key), {
      initialProps: { page: ids(2), key: 'a' },
    });
    act(() => result.current.togglePage(true));
    rerender({ page: ids(2, 2), key: 'a' });
    expect(result.current.selected.size).toBe(2);
    rerender({ page: ids(2, 2), key: 'b' });
    expect(result.current.selected.size).toBe(0);
    act(() => result.current.selectAllMatching());
    act(() => result.current.clear());
    expect(result.current.allMatching).toBe(false);
  });
});
