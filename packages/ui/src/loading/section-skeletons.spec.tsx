// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DetailSkeleton, FormSkeleton, TableSkeleton } from './section-skeletons.tsx';
import { LOADING_SHOW_DELAY_MS, LOADING_SLOW_MS } from './use-delayed-loading.ts';

// Panel loading L4: the shaped placeholders that replace SkeletonRows outside dialogs. Each has
// one status, shows bars only after 200 ms and says "Still loading…" at 10 s.

afterEach(cleanup);
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const wait = (ms: number) =>
  act(() => {
    vi.advanceTimersByTime(ms);
  });

describe('TableSkeleton', () => {
  const columns = [
    { header: 'Brand', kind: 'title' as const },
    { header: 'Status', kind: 'status' as const },
    { header: 'Products', kind: 'number' as const },
  ];

  it('shows only its status for 200 ms, then the real headers and shaped rows', () => {
    render(
      <TableSkeleton
        label="Loading brands"
        slowLabel="Still loading…"
        columns={columns}
        rows={4}
      />,
    );
    expect(screen.getByRole('status').textContent).toBe('Loading brands');
    expect(document.querySelector('table')).toBeNull();
    wait(LOADING_SHOW_DELAY_MS);
    const headers = [...document.querySelectorAll('th')].map((th) => th.textContent);
    expect(headers).toEqual(['Brand', 'Status', 'Products']);
    expect(screen.getAllByTestId('skeleton-row')).toHaveLength(4);
    // The status is the card corner and the number a labelled line on phones.
    const cells = screen.getAllByTestId('skeleton-row')[0]!.querySelectorAll('td');
    expect(cells[1]?.className).toContain('max-lg:col-start-2');
    expect(cells[2]?.getAttribute('data-label')).toBe('Products');
    expect(document.querySelector('table')?.closest('[aria-hidden="true"]')).not.toBeNull();
    expect(screen.getAllByRole('status')).toHaveLength(1);
  });

  it('never draws more than 10 rows, and says "Still loading…" at 10 s', () => {
    render(
      <TableSkeleton label="Loading" slowLabel="Still loading…" columns={columns} rows={50} />,
    );
    wait(LOADING_SLOW_MS);
    expect(screen.getAllByTestId('skeleton-row')).toHaveLength(10);
    expect(screen.getByRole('status').textContent).toBe('Still loading…');
  });
});

describe('FormSkeleton', () => {
  it('draws the form cards after 200 ms, without the page title by default', () => {
    render(
      <FormSkeleton
        label="Loading the product"
        slowLabel="Still loading…"
        sections={[{ fields: 3 }]}
      />,
    );
    expect(document.querySelector('[data-skeleton="section"]')).toBeNull();
    wait(LOADING_SHOW_DELAY_MS);
    expect(document.querySelectorAll('[data-skeleton="row"]')).toHaveLength(3);
    expect(document.querySelector('[data-skeleton="header"]')).toBeNull();
  });
});

describe('DetailSkeleton', () => {
  it('draws label and value pairs like DataList after 200 ms', () => {
    render(<DetailSkeleton label="Loading the category" slowLabel="Still loading…" rows={4} />);
    expect(document.querySelectorAll('[data-skeleton="detail-row"]')).toHaveLength(0);
    wait(LOADING_SHOW_DELAY_MS);
    const rows = document.querySelectorAll('[data-skeleton="detail-row"]');
    expect(rows).toHaveLength(4);
    expect(rows[0]?.className).toContain('sm:grid-cols-[var(--mp-size-data-label)_minmax(0,1fr)]');
    expect(screen.getByRole('status').textContent).toBe('Loading the category');
  });
});
