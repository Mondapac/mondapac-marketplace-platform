// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LOADING_SHOW_DELAY_MS,
  LOADING_SLOW_MS,
  LOADING_STALLED_MS,
} from '../loading/use-delayed-loading.ts';
import {
  ActivityCardSkeleton,
  DashboardLoading,
  DistributionCardSkeleton,
  StatCardSkeleton,
  activitySkeletonColumns,
} from './dashboard-loading.tsx';
import { DashboardSlot } from './dashboard-slot.tsx';

// Panel loading L4: each dashboard card has a skeleton of its own shape (real label, title,
// link and column headers; bars for what is not known yet), shown after 200 ms, with "Still
// loading…" at 10 s and the card error at 30 s. The page has one status while any card loads.

afterEach(cleanup);

const bars = (root: ParentNode = document) => root.querySelectorAll('.bg-muted').length;
const text = { slowLabel: 'Still loading…', stalledLabel: 'This could not be loaded.' };
const columns = activitySkeletonColumns([
  { id: 'order', header: 'Order', kind: 'title', cell: () => null },
  { id: 'status', header: 'Status', kind: 'corner', size: 'status', cell: () => null },
  {
    id: 'total',
    header: 'Total',
    kind: 'labelled',
    size: 'figure',
    align: 'end',
    cell: () => null,
  },
]);
const frame = {
  id: 'dash-orders',
  title: 'Recent orders',
  scope: 'Latest 5',
  action: { href: '/orders', label: 'View all' },
};

describe('dashboard card skeletons', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows a stat card frame with its real label, and the bars only after 200 ms', () => {
    render(
      <ul>
        <StatCardSkeleton icon="store" label="Sellers awaiting review" {...text} />
      </ul>,
    );
    expect(screen.getByText('Sellers awaiting review')).toBeTruthy();
    expect(bars()).toBe(0);
    act(() => {
      vi.advanceTimersByTime(LOADING_SHOW_DELAY_MS);
    });
    expect(bars()).toBe(2);
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('gives a stat card the card error after 30 s', () => {
    render(
      <ul>
        <StatCardSkeleton icon="store" label="Sellers awaiting review" {...text} />
      </ul>,
    );
    act(() => {
      vi.advanceTimersByTime(LOADING_STALLED_MS);
    });
    expect(screen.getByRole('alert').textContent).toBe('This could not be loaded.');
  });

  it('draws an activity card with its real title, link and headers, a row per listed item', () => {
    render(<ActivityCardSkeleton {...frame} {...text} columns={columns} rows={5} />);
    const card = screen.getByRole('region', { name: 'Recent orders' });
    expect(within(card).getByRole('link', { name: 'View all' }).getAttribute('href')).toBe(
      '/orders',
    );
    expect(within(card).getByText('Latest 5')).toBeTruthy();
    const table = card.querySelector('table');
    expect(table?.getAttribute('aria-hidden')).toBe('true');
    expect([...(table?.querySelectorAll('th') ?? [])].map((th) => th.textContent)).toEqual([
      'Order',
      'Status',
      'Total',
    ]);
    expect(table?.querySelectorAll('tbody tr')).toHaveLength(5);
    // Labelled cells carry their real column name for the phone layout.
    expect(table?.querySelector('td[data-label="Total"]')).not.toBeNull();
    // Rows hold their height before the bars show, so the card does not grow at 200 ms.
    const body = table!.querySelector('tbody')!;
    expect(bars(body)).toBe(0);
    act(() => {
      vi.advanceTimersByTime(LOADING_SHOW_DELAY_MS);
    });
    expect(bars(body)).toBe(15);
  });

  it('adds "Still loading…" at 10 s and shows the card error at 30 s', () => {
    render(<ActivityCardSkeleton {...frame} {...text} columns={columns} rows={5} />);
    act(() => {
      vi.advanceTimersByTime(LOADING_SLOW_MS);
    });
    expect(screen.getByText('Still loading…')).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(LOADING_STALLED_MS - LOADING_SLOW_MS);
    });
    const card = screen.getByRole('region', { name: 'Recent orders' });
    expect(within(card).getByRole('alert').textContent).toBe('This could not be loaded.');
    expect(card.querySelector('table')).toBeNull();
    expect(within(card).queryByRole('link')).toBeNull();
  });

  it('draws a chart card with the real legend and a bar per figure', () => {
    render(
      <DistributionCardSkeleton
        id="dash-states"
        title="Sellers by access state"
        {...text}
        parts={[
          { id: 'approved', label: 'Approved', tone: 'success' },
          { id: 'suspended', label: 'Suspended', tone: 'critical' },
        ]}
      />,
    );
    expect(screen.getByText('Approved')).toBeTruthy();
    expect(screen.getByText('Suspended')).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(LOADING_SHOW_DELAY_MS);
    });
    // The chart's bar and one figure per part.
    expect(bars()).toBe(3);
  });

  it('does not pulse with reduced motion', () => {
    render(<ActivityCardSkeleton {...frame} {...text} columns={columns} rows={2} />);
    expect(document.querySelector('tbody')?.className).toContain('motion-safe:animate-pulse');
    expect(document.querySelector('.animate-pulse')).toBeNull();
  });
});

describe('DashboardLoading', () => {
  it('has one status that names the page while any card loads, and is busy until then', async () => {
    let answer!: (value: string) => void;
    const pending = new Promise<string>((resolve) => {
      answer = resolve;
    });
    await act(async () => {
      render(
        <DashboardLoading label="Loading the dashboard">
          <ul>
            <StatCardSkeleton icon="store" label="One" {...text} />
          </ul>
          <DashboardSlot
            source={pending}
            fallback={<ActivityCardSkeleton {...frame} {...text} columns={columns} rows={2} />}
          >
            {(value) => <p>{value}</p>}
          </DashboardSlot>
        </DashboardLoading>,
      );
      await Promise.resolve();
    });
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByRole('status').textContent).toBe('Loading the dashboard');
    expect(screen.getByRole('status').parentElement?.getAttribute('aria-busy')).toBe('true');
    await act(async () => {
      answer('Orders arrived');
      await Promise.resolve();
    });
    expect(await screen.findByText('Orders arrived')).toBeTruthy();
    // The stat card skeleton is still there, so the page is still loading.
    expect(screen.getByRole('status').textContent).toBe('Loading the dashboard');
  });

  it('says nothing and is not busy once every card has its data', () => {
    render(
      <DashboardLoading label="Loading the dashboard">
        <DashboardSlot source="ready" fallback={<p>skeleton</p>}>
          {(value) => <p>{value}</p>}
        </DashboardSlot>
      </DashboardLoading>,
    );
    expect(screen.getByText('ready')).toBeTruthy();
    expect(screen.queryByText('skeleton')).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('');
    expect(screen.getByRole('status').parentElement?.getAttribute('aria-busy')).toBe('false');
  });
});
