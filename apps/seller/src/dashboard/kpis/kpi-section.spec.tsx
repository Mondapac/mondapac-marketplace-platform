// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../messages/en.json';
import type { Widget } from '../types.ts';
import type { SellerKpiSources } from './load.ts';
import type { KpiTotals, SellerKpis } from './types.ts';

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => '/',
}));

import { KpiSection } from './kpi-section.tsx';

afterEach(cleanup);

const ok = <T,>(value: T): Widget<T> => ({ kind: 'ok', value });
const CAT_A = '0190a000-0000-7000-8000-0000000000a1';
const totals = (over: Partial<KpiTotals> = {}): KpiTotals => ({
  salesInclTax: '220000',
  salesExclTax: '200000',
  orders: 20,
  units: 31,
  averageOrderValue: '11000',
  refundedInclTax: '5500',
  refunds: 1,
  refundRateBps: 250,
  ordersCancelled: 2,
  ordersShipped: 18,
  shippedOnTimeBps: 9444,
  ...over,
});
const kpis: SellerKpis = {
  period: {
    id: '7d',
    current: { from: '2026-11-16', to: '2026-11-22' },
    previous: { from: '2026-11-09', to: '2026-11-15' },
    days: 7,
  },
  timezone: 'Australia/Brisbane',
  currency: 'AUD',
  current: totals(),
  previous: totals({ salesInclTax: '110000', orders: 10 }),
  series: [
    { day: '2026-11-21', salesInclTax: '100000', orders: 9, refundedInclTax: '0' },
    { day: '2026-11-22', salesInclTax: '120000', orders: 11, refundedInclTax: '5500' },
  ],
  previousSeries: [
    { day: '2026-11-14', salesInclTax: '50000', orders: 5, refundedInclTax: '0' },
    { day: '2026-11-15', salesInclTax: '60000', orders: 5, refundedInclTax: '0' },
  ],
  topCategories: [{ categoryId: CAT_A, netSalesInclTax: '150000', orders: 12, units: 20 }],
  refreshedAt: '2026-11-22T01:00:00.000Z',
};

const render7d = (sources: Partial<SellerKpiSources> = {}) =>
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <KpiSection
        period="7d"
        sources={{
          kpis: ok(kpis),
          categories: { categories: [{ id: CAT_A, name: 'Fresh meat', depth: 3 }] },
          health: ok({
            current: {
              day: '2026-11-22',
              kind: 'scored' as const,
              band: 'healthy' as const,
              score: 86,
              lowestMetric: null,
              formulaVersion: '1',
              computedAt: '2026-11-22T00:00:00Z',
              orders: 40,
              metrics: [],
            },
            trend: [],
            refresh: { pending: false, retryAfterSeconds: 0 },
          }),
          ...sources,
        }}
      />
    </NextIntlClientProvider>,
  );

describe('the seller KPI section', () => {
  it('shows the eight figures with their change, the chart, the top categories and the health', async () => {
    render7d();
    const strip = await screen.findByRole('list', { name: 'Sales figures' });
    const cards = within(strip).getAllByRole('listitem');
    expect(cards).toHaveLength(8);
    expect(within(cards[0]!).getByText('Sales (incl. GST)')).toBeTruthy();
    expect(within(cards[0]!).getByText(/\$2,200\.00/)).toBeTruthy();
    expect(within(cards[0]!).getByText('+100.0%')).toBeTruthy();
    expect(within(cards[3]!).getByText('Refunded (incl. GST)')).toBeTruthy();
    expect(await screen.findByRole('heading', { name: 'Sales trend (incl. GST)' })).toBeTruthy();
    expect(await screen.findByText('Fresh meat')).toBeTruthy();
    expect(await screen.findByText('86')).toBeTruthy();
    expect(screen.getByText('Healthy')).toBeTruthy();
  });

  it('says a failed read in place and never shows a zero for it', async () => {
    render7d({ kpis: { kind: 'error' as const } });
    const strip = await screen.findByRole('list', { name: 'Sales figures' });
    const cards = within(strip).getAllByRole('listitem');
    expect(cards).toHaveLength(8);
    for (const card of cards) {
      expect(within(card).getByRole('alert').textContent).toMatch(/could not be loaded/i);
    }
    expect(screen.queryByText('$0.00')).toBeNull();
  });

  it('says so when the periods hold no paid order, and names an unknown category as other', async () => {
    render7d({
      kpis: ok({
        ...kpis,
        current: totals({ orders: 0, salesInclTax: '0' }),
        previous: totals({ orders: 0, salesInclTax: '0' }),
        topCategories: [],
      }),
    });
    expect(await screen.findByText(/No paid orders in this period/)).toBeTruthy();
    expect(await screen.findByText('No sales in this period.')).toBeTruthy();
  });

  it('numbers the bars when the category tree failed, and says the Market zone and update time', async () => {
    render7d({
      categories: null,
      kpis: ok({
        ...kpis,
        topCategories: [
          { categoryId: CAT_A, netSalesInclTax: '150000', orders: 12, units: 20 },
          { categoryId: CAT_A.replace(/1$/, '2'), netSalesInclTax: '90000', orders: 5, units: 6 },
        ],
      }),
    });
    expect(await screen.findByText('Category 1')).toBeTruthy();
    expect(screen.getByText('Category 2')).toBeTruthy();
    expect(screen.queryByText('Other categories')).toBeNull();
    expect(screen.getByText(/Market time \(Australia\/Brisbane\)/)).toBeTruthy();
    expect(screen.getByText(/updated /)).toBeTruthy();
  });

  it('offers the four periods with the chosen one checked', async () => {
    render7d();
    const group = await screen.findByRole('group', { name: 'Period' });
    expect(within(group).getAllByRole('radio')).toHaveLength(4);
    expect(within(group).getByRole('radio', { name: '7 days' })).toHaveProperty('checked', true);
  });
});
