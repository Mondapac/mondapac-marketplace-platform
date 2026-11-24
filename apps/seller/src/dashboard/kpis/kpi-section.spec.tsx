// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../messages/en.json';
import type { Widget } from '../types.ts';
import type { SellerKpiSources } from './load.ts';
import type { NextPayout } from '../../earnings/payout-types.ts';
import type { SellerDashboardSources } from '../types.ts';
import type { KpiTotals, SellerKpis, SellerNetEarnings } from './types.ts';

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => '/',
}));

import { SellerDashboard } from '../dashboard.tsx';

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

const net = (over: Partial<SellerNetEarnings> = {}): SellerNetEarnings => ({
  range: { from: '2026-11-16', to: '2026-11-22' },
  timezone: 'Australia/Brisbane',
  currency: 'AUD',
  ready: true,
  netEarnings: '180000',
  refreshedAt: '2026-11-22T01:00:00.000Z',
  ...over,
});
const payout = (over: Partial<NextPayout> = {}): NextPayout => ({
  slotAt: '2026-11-27T23:00:00.000Z',
  zone: 'Australia/Brisbane',
  estimatedAmount: { amountMinor: '231000', currency: 'AUD' },
  blockReason: null,
  ...over,
});
const health = {
  current: {
    day: '2026-11-22',
    kind: 'scored' as const,
    band: 'healthy' as const,
    score: 86,
    lowestMetric: null,
    formulaVersion: '1',
    computedAt: '2026-11-22T00:00:00Z',
    orders: 40,
    metrics: [
      { metric: 'late-ready', kind: 'scored' as const, band: 'healthy' as const, score: 92 },
      { metric: 'customer-rating', kind: 'no-data' as const },
    ],
  },
  trend: [],
  refresh: { pending: false, retryAfterSeconds: 0 },
};
const NONE: SellerDashboardSources = {
  tasks: null,
  orders: null,
  payout: null,
  sources: null,
  lowStock: null,
};
const KEYS = ['ordering.seller-order.view', 'commission-payouts.earnings.view'];

const mount = (sources: Partial<SellerKpiSources> = {}, locale = 'en-AU') =>
  render(
    <NextIntlClientProvider locale={locale} messages={messages}>
      <SellerDashboard
        data={NONE}
        permissionKeys={KEYS}
        period="7d"
        kpis={{
          kpis: ok(kpis),
          categories: { categories: [{ id: CAT_A, name: 'Fresh meat', depth: 3 }] },
          health: ok(health),
          netEarnings: ok(net()),
          nextPayout: ok(payout()),
          ...sources,
        }}
      />
    </NextIntlClientProvider>,
  );
const card = (name: string) => {
  const found = document.querySelectorAll('[data-kpi-card]');
  const hit = [...found].find((el) => el.textContent?.includes(name));
  if (hit === undefined) throw new Error(`no card ${name}`);
  return within(hit as HTMLElement);
};

describe('the seller KPI cards', () => {
  it('shows the four headline cards, only Sales highlighted, with the change against the period before', () => {
    mount();
    expect(document.querySelectorAll('[data-kpi-card]')).toHaveLength(4);
    expect(document.querySelectorAll('[data-highlight]')).toHaveLength(1);
    const sales = card('Sales (incl. GST)');
    expect(sales.getByText(/\$2,200\.00/)).toBeTruthy();
    expect(sales.getByText('+100.0%')).toBeTruthy();
    expect(card('Seller orders paid').getByText('20')).toBeTruthy();
    expect(card('Net earnings').getByText(/\$1,800\.00/)).toBeTruthy();
    const next = card('Next payout');
    expect(next.getByText(/\$2,310\.00/)).toBeTruthy();
    expect(next.getByText(/Scheduled for/)).toBeTruthy();
  });

  it('formats money with the Market locale and its currency', () => {
    mount({ netEarnings: ok(net({ currency: 'JPY', netEarnings: '180000' })) }, 'de-DE');
    expect(card('Net earnings').getByText(/180\.000/)).toBeTruthy();
    expect(card('Sales (incl. GST)').getByText(/2\.200,00/)).toBeTruthy();
  });

  it('withholds net earnings until a week of ledger records, never as a number', () => {
    mount({ netEarnings: ok(net({ ready: false, netEarnings: null })) });
    const earnings = card('Net earnings');
    expect(earnings.getByText('Available after a week of payout records')).toBeTruthy();
    expect(earnings.queryByText(/\$/)).toBeNull();
  });

  it('leaves the earnings cards out without the earnings key', () => {
    mount({ netEarnings: null, nextPayout: null });
    expect(document.querySelectorAll('[data-kpi-card]')).toHaveLength(2);
  });

  it('says why no payout is on its way, or that there is nothing yet', () => {
    mount({ nextPayout: ok(payout({ blockReason: 'account-not-ready', estimatedAmount: null })) });
    expect(card('Next payout').getByText('Payout account not ready')).toBeTruthy();
    cleanup();
    mount({ nextPayout: ok(payout({ estimatedAmount: null })) });
    expect(card('Next payout').getByText('Nothing to pay out yet')).toBeTruthy();
  });

  it('says a failed read in place and never shows a zero for it', () => {
    mount({ kpis: { kind: 'error' as const }, netEarnings: { kind: 'error' as const } });
    for (const name of ['Sales (incl. GST)', 'Seller orders paid', 'Net earnings']) {
      expect(card(name).getByRole('alert').textContent).toMatch(/could not be loaded/i);
    }
    expect(screen.queryByText('$0.00')).toBeNull();
  });

  it('opens a definition from the question mark', () => {
    mount();
    const button = screen.getByRole('button', { name: 'What is Net earnings?' });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText(/after commission, refunds and cashback you fund/)).toBeTruthy();
  });
});

describe('the seller sales chart', () => {
  it('switches the measure from sales to orders', () => {
    mount();
    const chart = () => screen.getByRole('img', { name: /against the previous period/ });
    expect(chart().getAttribute('aria-label')).toMatch(/^Sales, Last 7 days/);
    fireEvent.click(screen.getByRole('radio', { name: 'Orders' }));
    expect(chart().getAttribute('aria-label')).toMatch(/^Orders, Last 7 days/);
  });

  it('says no data when the periods hold no paid order', () => {
    mount({
      kpis: ok({
        ...kpis,
        current: totals({ orders: 0, salesInclTax: '0' }),
        previous: totals({ orders: 0, salesInclTax: '0' }),
        series: kpis.series.map((d) => ({ ...d, orders: 0, salesInclTax: '0' })),
        previousSeries: kpis.previousSeries.map((d) => ({ ...d, orders: 0, salesInclTax: '0' })),
        topCategories: [],
      }),
    });
    expect(screen.getByText(/No paid orders in this period/)).toBeTruthy();
    expect(screen.getByText('No sales in this period.')).toBeTruthy();
  });

  it('says not enough data, not no data, when there is one day to draw', () => {
    mount({
      kpis: ok({
        ...kpis,
        series: kpis.series.slice(0, 1),
        previousSeries: kpis.previousSeries.slice(0, 1),
      }),
    });
    expect(screen.getByText('Not enough data yet')).toBeTruthy();
    expect(screen.queryByText(/No paid orders in this period/)).toBeNull();
  });

  it('says the Market zone and the update time', () => {
    mount();
    expect(screen.getByText(/Market time \(Australia\/Brisbane\)/)).toBeTruthy();
    expect(screen.getByText(/updated /)).toBeTruthy();
  });
});

describe('the seller store health and categories', () => {
  it('shows the score out of 100 as a ring with the scored measures only', () => {
    mount();
    const region = within(screen.getByRole('region', { name: 'Store health' }));
    expect(region.getByRole('img', { name: /Store health: 86/ })).toBeTruthy();
    expect(region.getByText('Ready late')).toBeTruthy();
    expect(region.queryByText('Customer rating')).toBeNull();
  });

  it('says a new store has no score yet', () => {
    mount({ health: ok({ ...health, current: { ...health.current, kind: 'new', score: null } }) });
    expect(screen.getByText('Your score appears after your first orders.')).toBeTruthy();
  });

  it('names categories, and numbers the bars when the category tree failed', () => {
    mount();
    expect(screen.getByText('Fresh meat')).toBeTruthy();
    cleanup();
    mount({ categories: null });
    expect(screen.getByText('Category 1')).toBeTruthy();
  });
});

describe('the seller dashboard layout', () => {
  it('puts the KPI cards first and the tasks second on a phone, and keeps two KPI cards a row', () => {
    mount();
    const items = [...document.querySelectorAll('[data-dashboard-grid] > *')];
    const kpi = items.filter((el) => el.querySelector('[data-kpi-card]'));
    expect(kpi).toHaveLength(4);
    for (const el of kpi) {
      expect(el.className).toContain('order-1');
      expect(el.className).toContain('col-span-6');
      expect(el.className).toContain('lg:col-span-3');
    }
    const chart = items.find((el) => el.querySelector('#dash-kpi-sales'));
    expect(chart?.className).toContain('order-3');
    expect(chart?.className).toContain('lg:col-span-8');
  });

  it('offers the four periods with the chosen one checked', () => {
    mount();
    const group = screen.getByRole('group', { name: 'Period' });
    expect(within(group).getAllByRole('radio')).toHaveLength(4);
    expect(within(group).getByRole('radio', { name: '7 days' })).toHaveProperty('checked', true);
  });
});
