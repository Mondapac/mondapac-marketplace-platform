// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';
import {
  kpiMajor,
  kpiDayLabel,
  kpiDelta,
  kpiMoney,
  kpiRate,
  kpiSentiment,
  minutesBetween,
} from './kpi-format.ts';
import type { AdminKpis, KpiDelta, KpiResult } from './kpi-types.ts';
import { AdminKpiStrip } from './kpis.tsx';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
afterEach(cleanup);

const wrap = (node: React.ReactNode) => (
  <NextIntlClientProvider locale="en-AU" messages={messages}>
    {node}
  </NextIntlClientProvider>
);
const money = (amountMinor: string) => ({ amountMinor, currency: 'AUD' });
const ok = (): KpiDelta => ({ value: 1250, direction: 'up', state: 'ok' });
const na = (): KpiDelta => ({ value: 0, direction: 'flat', state: 'na' });
const GENERATED = '2026-11-22T10:00:00.000Z';

const finance = {
  status: 'ok' as const,
  refreshedAt: '2026-11-22T09:57:00.000Z',
  kpis: {
    currency: 'AUD',
    current: {
      gmvWithTax: money('123456'),
      gmvWithoutTax: money('112233'),
      refundedWithTax: money('5000'),
      refundRateBp: 405,
      netSalesWithTax: money('118456'),
      averageOrderWithTax: money('41152'),
    },
    previous: {
      gmvWithTax: money('100000'),
      gmvWithoutTax: money('90909'),
      refundedWithTax: money('1000'),
      refundRateBp: 100,
      netSalesWithTax: money('99000'),
      averageOrderWithTax: null,
    },
    deltas: {
      gmvWithTax: ok(),
      gmvWithoutTax: ok(),
      refundedWithTax: ok(),
      refundRateBp: ok(),
      netSalesWithTax: ok(),
      averageOrderWithTax: na(),
    },
    series: [
      { day: '2026-11-21', gmvWithTax: '50000', gmvWithoutTax: '45000', refundedWithTax: '0' },
      { day: '2026-11-22', gmvWithTax: '73456', gmvWithoutTax: '67233', refundedWithTax: '5000' },
    ],
    previousSeries: [
      { day: '2026-11-19', gmvWithTax: '40000', gmvWithoutTax: '36000', refundedWithTax: '0' },
      { day: '2026-11-20', gmvWithTax: '60000', gmvWithoutTax: '54909', refundedWithTax: '1000' },
    ],
  },
};
const operations = {
  status: 'ok' as const,
  refreshedAt: '2026-11-22T09:58:00.000Z',
  kpis: {
    current: {
      ordersPaid: 3,
      ordersCancelled: 1,
      cancelRateBp: 3333,
      ordersShipped: 4,
      onTimeRateBp: 7500,
      refunds: 2,
    },
    previous: {
      ordersPaid: 3,
      ordersCancelled: 0,
      cancelRateBp: 0,
      ordersShipped: 4,
      onTimeRateBp: 9000,
      refunds: 1,
    },
    deltas: {
      ordersPaid: na(),
      ordersCancelled: na(),
      cancelRateBp: { value: 500, direction: 'up', state: 'ok' } as KpiDelta,
      ordersShipped: na(),
      onTimeRateBp: { value: -1500, direction: 'down', state: 'ok' } as KpiDelta,
      refunds: na(),
    },
    series: [{ day: '2026-11-22', ordersPaid: 3, ordersCancelled: 1, refunds: 2 }],
    previousSeries: [],
  },
};
const answer = (parts: Partial<AdminKpis>): KpiResult => ({
  kind: 'ok',
  value: {
    generatedAt: GENERATED,
    periodId: '7d',
    period: {
      id: '7d',
      current: { from: '2026-11-16', to: '2026-11-22' },
      previous: { from: '2026-11-09', to: '2026-11-15' },
    },
    operations: null,
    finance: null,
    ...parts,
  },
});

const BOTH = ['ordering.order.view', 'commission-payouts.settlement.view'];
const strip = (result: KpiResult | null, keys: readonly string[] = BOTH) =>
  render(wrap(<AdminKpiStrip source={result} period="7d" permissionKeys={keys} />));

describe('the admin KPI strip', () => {
  it('shows eight figures with money in the currency, rates, changes and the update time', () => {
    strip(answer({ finance, operations }));
    const cards = within(
      screen.getByRole('list', { name: 'Marketplace performance' }),
    ).getAllByRole('listitem');
    expect(cards).toHaveLength(8);
    expect(screen.getByText('$1,234.56')).toBeTruthy();
    expect(screen.getByText(/\$1,122\.33 excl\. GST/)).toBeTruthy();
    expect(screen.getByText('33.3%')).toBeTruthy();
    expect(screen.getAllByText('+12.5%').length).toBeGreaterThan(0);
    expect(screen.getByText(/updated 2 min ago/)).toBeTruthy();
    // A change that is n/a never reads as zero.
    expect(screen.getAllByText('n/a').length).toBeGreaterThan(0);
  });

  it('colours a rise in the cancel rate as worse and a fall in on-time as worse', () => {
    strip(answer({ operations }));
    const cancel = screen.getByText('Cancel rate').closest('li')!;
    expect(within(cancel).getByText(/worse/)).toBeTruthy();
    const onTime = screen.getByText('Shipped on time').closest('li')!;
    expect(within(onTime).getByText(/worse/)).toBeTruthy();
  });

  it('leaves out a section the session has no key for', () => {
    strip(answer({ finance }));
    expect(screen.queryByText('Paid orders')).toBeNull();
    expect(screen.getByText('GMV (incl. GST)', { selector: 'span' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'GMV (incl. GST)' })).toBeTruthy();
  });

  it('says an error section failed in place and still shows the other', () => {
    strip(answer({ finance: { status: 'error' }, operations }));
    expect(screen.getAllByRole('alert').length).toBe(4);
    expect(screen.getByText('Paid orders')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'GMV (incl. GST)' })).toBeNull();
  });

  it('shows an error for every figure when the read failed, and nothing without a key', () => {
    const { unmount } = strip({ kind: 'error' });
    expect(screen.getAllByRole('alert').length).toBe(8);
    unmount();
    // Only the figures the session may see, never the money cards of an orders-only admin.
    const some = strip({ kind: 'error' }, ['ordering.order.view']);
    expect(screen.getAllByRole('alert').length).toBe(4);
    expect(screen.queryByText('GMV (incl. GST)')).toBeNull();
    some.unmount();
    const hidden = strip(answer({}));
    expect(hidden.container.textContent).toBe('');
    hidden.unmount();
    expect(strip(null).container.textContent).toBe('');
  });

  it('says there is nothing to chart when the period has no sales', () => {
    const empty = {
      ...finance,
      kpis: {
        ...finance.kpis,
        series: [{ day: '2026-11-22', gmvWithTax: '0', gmvWithoutTax: '0', refundedWithTax: '0' }],
      },
    };
    strip(answer({ finance: empty }));
    expect(screen.getByText('No sales in this period yet.')).toBeTruthy();
  });
});

describe('the KPI formats', () => {
  it('formats money, rates, changes and days', () => {
    expect(kpiMoney(money('123456'), 'en-AU')).toBe('$1,234.56');
    expect(kpiMoney({ amountMinor: '1500', currency: 'JPY' }, 'en-AU')).toContain('1,500');
    expect(kpiMoney(money('12.5'), 'en-AU')).toBe('-');
    expect(kpiRate(1250, 'en-AU')).toBe('12.5%');
    expect(kpiRate(null, 'en-AU')).toBe('-');
    expect(kpiDelta({ value: -300, direction: 'down', state: 'ok' }, 'percent', 'en-AU')).toBe(
      '-3%',
    );
    expect(kpiDelta({ value: 150, direction: 'up', state: 'ok' }, 'points', 'en-AU')).toBe(
      '+1.5 pts',
    );
    expect(kpiDelta(na(), 'percent', 'en-AU')).toBe('n/a');
    expect(kpiDayLabel('2026-11-22', 'en-AU')).toBe('22 Nov');
    expect(minutesBetween('2026-11-22T09:57:00Z', GENERATED)).toBe(3);
    expect(minutesBetween(null, GENERATED)).toBeNull();
  });

  it('shows a chart value in the currency whatever its digits', () => {
    expect(kpiMajor(1500, 'JPY', 'en-AU')).toContain('1,500');
    expect(kpiMajor(12.5, 'AUD', 'en-AU')).toBe('$12.50');
  });

  it('judges better or worse by the metric, not the arrow', () => {
    expect(kpiSentiment(ok(), 'better')).toBe('good');
    expect(kpiSentiment(ok(), 'worse')).toBe('bad');
    expect(kpiSentiment(na(), 'worse')).toBe('neutral');
  });
});
