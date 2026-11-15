// @vitest-environment jsdom
import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CARD_TABLE } from '../data/card-table.ts';
import {
  LIST_SKELETON_MAX_ROWS,
  ListLoadingStatus,
  ListRefreshing,
  ListSkeletonRows,
  listSkeletonRowCount,
  useListLoading,
} from './list-skeleton.tsx';

// Panel loading L2: a super list loads with skeleton rows in the shape of its columns (at most 10),
// refreshes by dimming the rows it has, and names what is loading in one live region.

afterEach(cleanup);

describe('listSkeletonRowCount', () => {
  it('follows the page size up to ten rows', () => {
    expect(listSkeletonRowCount(5)).toBe(5);
    expect(listSkeletonRowCount(25)).toBe(LIST_SKELETON_MAX_ROWS);
    expect(listSkeletonRowCount(0)).toBe(1);
  });
});

describe('ListSkeletonRows', () => {
  it('draws one placeholder per column with the real cell classes, hidden from screen readers', () => {
    render(
      <table>
        <tbody>
          <ListSkeletonRows
            rows={3}
            cells={[
              { kind: 'select', className: 'w-14' },
              { kind: 'thumb', className: CARD_TABLE.cell },
              { kind: 'status', className: CARD_TABLE.corner },
              { kind: 'text', className: CARD_TABLE.labelled, label: 'Category' },
              { kind: 'number', className: CARD_TABLE.labelled, label: 'Offers' },
            ]}
          />
        </tbody>
      </table>,
    );
    const rows = screen.getAllByTestId('skeleton-row');
    expect(rows).toHaveLength(3);
    const first = rows[0]!;
    expect(first.getAttribute('aria-hidden')).toBe('true');
    expect(first.className).toContain('motion-safe:animate-pulse');
    const cells = first.querySelectorAll('td');
    expect(cells).toHaveLength(5);
    expect(cells[0]!.className).toBe('w-14');
    expect(cells[2]!.className).toBe(CARD_TABLE.corner);
    // A labelled cell carries its column name for the card layout below 1024 px.
    expect(cells[3]!.getAttribute('data-label')).toBe('Category');
    const kinds = [...first.querySelectorAll('[data-skeleton]')].map((node) =>
      node.getAttribute('data-skeleton'),
    );
    expect(kinds).toEqual(['select', 'thumb', 'status', 'text', 'number']);
    // The number bar ends where a number ends.
    expect(cells[4]!.querySelector('.justify-end')).not.toBeNull();
  });
});

describe('ListLoadingStatus', () => {
  it('names the list for screen readers, then says "Still loading…" to everyone', () => {
    const { rerender } = render(
      <ListLoadingStatus label="Loading products" slow={false} slowLabel="Still loading…" />,
    );
    const status = screen.getByRole('status');
    expect(status.textContent).toBe('Loading products');
    expect(status.className).toBe('sr-only');
    rerender(<ListLoadingStatus label="Loading products" slow slowLabel="Still loading…" />);
    expect(screen.getByRole('status').textContent).toBe('Still loading…');
    expect(screen.getByRole('status').className).not.toContain('sr-only');
  });
});

describe('ListRefreshing', () => {
  it('dims the rows and shows the bar only while refreshing', () => {
    const { rerender } = render(
      <ListRefreshing refreshing={false}>
        <p>rows</p>
      </ListRefreshing>,
    );
    const content = screen.getByText('rows').parentElement!;
    expect(content.className).not.toContain('opacity-60');
    expect(content.getAttribute('aria-busy')).toBe('false');
    expect(screen.queryByTestId('list-refresh-bar')).toBeNull();
    rerender(
      <ListRefreshing refreshing>
        <p>rows</p>
      </ListRefreshing>,
    );
    expect(content.className).toContain('opacity-60');
    expect(content.getAttribute('aria-busy')).toBe('true');
    expect(screen.getByTestId('list-refresh-bar').getAttribute('aria-hidden')).toBe('true');
  });

  it('can be busy without dimming (skeleton rows)', () => {
    render(
      <ListRefreshing refreshing={false} busy>
        <p>rows</p>
      </ListRefreshing>,
    );
    const content = screen.getByText('rows').parentElement!;
    expect(content.getAttribute('aria-busy')).toBe('true');
    expect(content.className).not.toContain('opacity-60');
  });
});

describe('useListLoading', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the skeleton after 200 ms on the first load, then dims on a refresh', () => {
    const { result, rerender } = renderHook(
      ({ loading, hasRows }) => useListLoading(loading, hasRows),
      { initialProps: { loading: true, hasRows: false } },
    );
    expect(result.current.skeleton).toBe(false);
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(result.current.skeleton).toBe(true);
    expect(result.current.refreshing).toBe(false);
    // The page arrives at 300 ms: the skeleton stays its 400 ms, then goes.
    act(() => {
      vi.advanceTimersByTime(100);
    });
    rerender({ loading: false, hasRows: true });
    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(result.current.skeleton).toBe(true);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.skeleton).toBe(false);
    // Another sort: no skeleton again, the rows dim after 200 ms.
    rerender({ loading: true, hasRows: true });
    act(() => {
      vi.advanceTimersByTime(199);
    });
    expect(result.current.refreshing).toBe(false);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.refreshing).toBe(true);
    expect(result.current.skeleton).toBe(false);
  });

  it('never shows anything for a fast first load', () => {
    const { result, rerender } = renderHook(
      ({ loading, hasRows }) => useListLoading(loading, hasRows),
      { initialProps: { loading: true, hasRows: false } },
    );
    act(() => {
      vi.advanceTimersByTime(150);
    });
    rerender({ loading: false, hasRows: true });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current).toEqual({
      skeleton: false,
      slow: false,
      stalled: false,
      refreshing: false,
    });
  });

  it('marks a long first load slow at 10 s and stalled at 30 s', () => {
    const { result } = renderHook(() => useListLoading(true, false));
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(result.current.slow).toBe(true);
    expect(result.current.stalled).toBe(false);
    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    expect(result.current.stalled).toBe(true);
  });
});
