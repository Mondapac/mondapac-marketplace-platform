// @vitest-environment jsdom
import { DashboardGrid } from '@mondapac/ui';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../messages/en.json';
import type { Widget } from '../types.ts';
import { KpiItems } from './kpi-section.tsx';
import type { SellerKpiSources } from './load.ts';
import { goalProblemOf } from './seller-goal.tsx';
import type { KpiTotals, SellerGoalFigures, SellerGoalSection, SellerKpis } from './types.ts';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

const totals: KpiTotals = {
  salesInclTax: '2164000',
  salesExclTax: '1967273',
  orders: 300,
  units: 500,
  averageOrderValue: '7213',
  refundedInclTax: '0',
  refunds: 0,
  refundRateBps: 0,
  ordersCancelled: 0,
  ordersShipped: 290,
  shippedOnTimeBps: 9500,
};

const goal: SellerGoalFigures = {
  month: '2026-11',
  lastMonth: '2026-10',
  timezone: 'Australia/Brisbane',
  currency: 'AUD',
  daysInMonth: 30,
  dayOfMonth: 24,
  daysLeft: 7,
  monthToDate: '2164000',
  lastMonthTotal: '2310000',
  forecast: { status: 'estimate', amount: '2835000' },
  target: '2700000',
  progressBp: 8015,
  paceBp: 10500,
  toGo: '536000',
  perDayToGo: '76571',
  version: 2,
};

const kpis = (sellerGoal: SellerGoalSection | null | undefined): SellerKpis => ({
  period: {
    id: '30d',
    current: { from: '2026-10-25', to: '2026-11-23' },
    previous: { from: '2026-09-25', to: '2026-10-24' },
    days: 30,
  },
  timezone: 'Australia/Brisbane',
  currency: 'AUD',
  current: totals,
  previous: totals,
  series: [],
  previousSeries: [],
  topCategories: [],
  refreshedAt: null,
  ...(sellerGoal === undefined ? {} : { sellerGoal }),
});

const sources = (
  widget: Widget<SellerKpis> | Promise<Widget<SellerKpis>>,
  canManage = true,
): SellerKpiSources => ({
  refused: false,
  kpis: widget,
  categories: null,
  health: { kind: 'error' },
  netEarnings: null,
  nextPayout: null,
  goal: { canManage, csrfToken: 'csrf-1' },
});

const page = (s: SellerKpiSources) =>
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <DashboardGrid>
        <KpiItems sources={s} period="30d" />
      </DashboardGrid>
    </NextIntlClientProvider>,
  );

const card = () => screen.getByRole('region', { name: 'Monthly goal' });

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  refresh.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the Monthly goal card', () => {
  it('shows the goal, the month to date, the pace and the estimate', () => {
    page(sources({ kind: 'ok', value: kpis({ status: 'ok', goal }) }));
    const c = card();
    expect(within(c).getByText('$27,000.00')).toBeTruthy();
    expect(within(c).getByText('$21,640.00')).toBeTruthy();
    expect(within(c).getByText('On pace for 105%')).toBeTruthy();
    expect(within(c).getByText('Estimate')).toBeTruthy();
    expect(within(c).getByText(/7 days left · \$5,360\.00 to go · \$765\.71 a day/)).toBeTruthy();
    expect(within(c).getByText(/Your own goal · November to date/)).toBeTruthy();
    expect(within(c).getByRole('img', { name: /Monthly goal: 80% of goal/ })).toBeTruthy();
    expect(within(c).getByRole('button', { name: 'What is Monthly goal?' })).toBeTruthy();
  });

  it('is left out when the API leaves the section out', () => {
    page(sources({ kind: 'ok', value: kpis(null) }));
    expect(screen.queryByText('Monthly goal')).toBeNull();
    cleanup();
    page(sources({ kind: 'ok', value: kpis(undefined) }));
    expect(screen.queryByText('Monthly goal')).toBeNull();
  });

  it('says a failed section failed in place', () => {
    page(sources({ kind: 'ok', value: kpis({ status: 'error' }) }));
    expect(within(card()).getByRole('alert').textContent).toContain('could not be loaded');
    expect(within(card()).queryByText(/\$/)).toBeNull();
  });

  it('shows a skeleton while the read streams', () => {
    page(sources(new Promise<Widget<SellerKpis>>(() => undefined)));
    expect(card()).toBeTruthy();
    expect(within(card()).queryByText(/\$/)).toBeNull();
  });

  it('says "not enough data" for the forecast and offers to set a goal while none is set', () => {
    page(
      sources({
        kind: 'ok',
        value: kpis({
          status: 'ok',
          goal: {
            ...goal,
            dayOfMonth: 2,
            forecast: { status: 'not-enough-data', daysElapsed: 1, minimumDays: 3 },
            target: null,
            progressBp: null,
            paceBp: null,
            toGo: null,
            perDayToGo: null,
            version: 0,
          },
        }),
      }),
    );
    const c = card();
    expect(within(c).getByText('No goal set for this month')).toBeTruthy();
    expect(within(c).getByText(/Not enough data for a forecast yet/)).toBeTruthy();
    expect(within(c).getByRole('button', { name: 'Set goal' })).toBeTruthy();
    expect(within(c).queryByText('On pace for', { exact: false })).toBeNull();
  });

  it('is read-only without the manage key', () => {
    page(sources({ kind: 'ok', value: kpis({ status: 'ok', goal }) }, false));
    expect(within(card()).queryByRole('button', { name: /^(Set|Edit) goal$/ })).toBeNull();
  });
});

describe('the goal form', () => {
  it('sends this month, the amount in minor units and the version seen, then reads again', async () => {
    fetchMock.mockResolvedValueOnce(
      json(200, {
        month: '2026-11',
        amount: '3000050',
        currency: 'AUD',
        version: 3,
        updatedAt: '2026-11-24T00:00:00Z',
      }),
    );
    page(sources({ kind: 'ok', value: kpis({ status: 'ok', goal }) }));
    fireEvent.click(within(card()).getByRole('button', { name: 'Edit goal' }));
    const field = screen.getByLabelText<HTMLInputElement>(/Sales goal for November \(AUD/);
    expect(field.value).toBe('27000.00');
    fireEvent.change(field, { target: { value: '30000.50' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save goal' }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/reporting/seller/monthly-goal');
    expect(init.method).toBe('PUT');
    expect((init.headers as Record<string, string>)['x-csrf-token']).toBe('csrf-1');
    expect(JSON.parse(init.body as string)).toEqual({
      month: '2026-11',
      amount: '3000050',
      currency: 'AUD',
      expectedVersion: 2,
    });
  });

  it('refuses an amount that is not above zero without calling the API', () => {
    page(sources({ kind: 'ok', value: kpis({ status: 'ok', goal }) }));
    fireEvent.click(within(card()).getByRole('button', { name: 'Edit goal' }));
    const field = screen.getByLabelText(/Sales goal for November/);
    for (const value of ['0', '-5', '12.345', 'abc']) {
      fireEvent.change(field, { target: { value } });
      fireEvent.click(screen.getByRole('button', { name: 'Save goal' }));
      expect(screen.getByText(/Enter an amount above zero/)).toBeTruthy();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('says why a write was refused: acting-as or no right, and a stale version', async () => {
    fetchMock
      .mockResolvedValueOnce(json(403, { statusCode: 403, code: 'access.denied' }))
      .mockResolvedValueOnce(
        json(409, { statusCode: 409, code: 'reporting.seller-goal-conflict' }),
      );
    page(sources({ kind: 'ok', value: kpis({ status: 'ok', goal }) }));
    fireEvent.click(within(card()).getByRole('button', { name: 'Edit goal' }));
    fireEvent.change(screen.getByLabelText(/Sales goal for November/), {
      target: { value: '30000' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save goal' }));
    expect(await screen.findByText(/can’t be changed in this session/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save goal' }));
    expect(await screen.findByText(/changed meanwhile/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('maps every refusal to a message', () => {
    expect(goalProblemOf({ status: 403, code: 'access.seller-not-approved' })).toBe('not-approved');
    expect(goalProblemOf({ status: 403, code: 'access.denied' })).toBe('denied');
    expect(goalProblemOf({ status: 409, code: 'x' })).toBe('conflict');
    expect(goalProblemOf({ status: 0, code: 'network' })).toBe('unavailable');
    expect(goalProblemOf({ status: 500, code: 'x' })).toBe('unknown');
  });
});
