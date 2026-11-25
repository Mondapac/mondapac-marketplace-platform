// @vitest-environment jsdom
import { DashboardGrid } from '@mondapac/ui';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';
import type {
  AbandonedCartsKpis,
  AdminKpis,
  DiscountCostKpis,
  KpiDelta,
  KpiResult,
  MarketTargetKpis,
  OrdersByStateKpis,
  ShoppingFunnelKpis,
  ZeroResultSearchesKpis,
} from './kpi-types.ts';
import { KpiItems } from './kpis.tsx';
import { targetMinorOf, targetProblemOf } from './target-editor.tsx';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

afterEach(cleanup);

const up = (value = 1250): KpiDelta => ({ value, direction: 'up', state: 'ok' });
const aud = (amountMinor: string) => ({ amountMinor, currency: 'AUD' });

const answer = (parts: Partial<AdminKpis>): KpiResult => ({
  kind: 'ok',
  value: {
    generatedAt: '2026-11-22T10:00:00.000Z',
    periodId: '30d',
    period: {
      id: '30d',
      current: { from: '2026-10-24', to: '2026-11-22' },
      previous: { from: '2026-09-24', to: '2026-10-23' },
    },
    operations: null,
    finance: null,
    ordersByStatus: null,
    topSellers: null,
    topCategories: null,
    health: null,
    ...parts,
  },
});

const target: MarketTargetKpis = {
  month: '2026-11',
  lastMonth: '2026-10',
  timezone: 'Australia/Brisbane',
  currency: 'AUD',
  daysInMonth: 30,
  dayOfMonth: 23,
  daysLeft: 8,
  monthToDate: '19056000',
  lastMonthTotal: '22104000',
  forecast: { status: 'estimate', amount: '24860000' },
  target: '24000000',
  progressBp: 7940,
  paceBp: 10358,
  toGo: '4944000',
  perDayToGo: '618000',
  refreshedAt: '2026-11-22T09:55:00.000Z',
};

const step = (count: number | null, rateBp: number | null) => ({
  count,
  rateBp,
  change: up(900),
  rateChange: up(60),
});
const funnel: ShoppingFunnelKpis = {
  status: 'available',
  viewed: step(21480, null),
  carted: step(4120, 1918),
  checkedOut: step(2210, 5364),
  paid: step(null, null),
  recordedDays: 29,
  periodDays: 30,
};

const XSS = '<img src=x onerror=alert(1)>';
const searches: ZeroResultSearchesKpis = {
  status: 'available',
  queries: [
    { query: 'barberry', searches: 688, searcherDays: 120, days: 12 },
    { query: XSS, searches: 40, searcherDays: 22, days: 2 },
  ],
  recordedDays: 30,
  periodDays: 30,
};

const carts: AbandonedCartsKpis = {
  status: 'available',
  carts: 708,
  approximateValue: aud('4126000'),
  asOfDay: '2026-11-21',
  change: up(500),
  recordedDays: 29,
  periodDays: 30,
};

const byState: OrdersByStateKpis = {
  status: 'available',
  paid: 2412,
  states: [
    { state: 'NSW', orders: 1012, shareBp: 4196 },
    { state: 'VIC', orders: 698, shareBp: 2894 },
  ],
  other: { orders: 651, shareBp: 2699 },
  unknown: { orders: 51, shareBp: 211 },
};

const discounts: DiscountCostKpis = {
  status: 'available',
  orders: 412,
  amount: aud('1840000'),
  platformShare: aud('920000'),
  sellerShare: aud('920000'),
  platformShareBp: 5000,
  change: up(1200),
  previousAmount: aud('1640000'),
  byKind: [
    {
      kind: 'promotion',
      uses: 380,
      amount: aud('1500000'),
      platformShare: aud('600000'),
      shareBp: 8152,
    },
    { kind: 'first-order', uses: null, amount: null, platformShare: null, shareBp: null },
    {
      kind: 'free-shipping',
      uses: 30,
      amount: aud('340000'),
      platformShare: aud('320000'),
      shareBp: 1848,
    },
  ],
  released: { orders: 12, amount: aud('48000') },
};

const ALL_SECTIONS = {
  marketTarget: { status: 'ok' as const, kpis: target },
  shoppingFunnel: { status: 'ok' as const, kpis: funnel },
  zeroResultSearches: { status: 'ok' as const, kpis: searches },
  abandonedCarts: { status: 'ok' as const, kpis: carts },
  ordersByState: { status: 'ok' as const, kpis: byState },
  discountCost: { status: 'ok' as const, kpis: discounts },
};

const ALL_KEYS = [
  'ordering.order.view',
  'commission-payouts.settlement.view',
  'settings.monthly-revenue-target.view',
  'catalog.product.view',
  'promotions.promotion.manage',
];

const page = (result: KpiResult | null, keys: readonly string[] = ALL_KEYS, csrfToken?: string) =>
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <DashboardGrid>
        <KpiItems
          source={result}
          period="30d"
          permissionKeys={keys}
          {...(csrfToken === undefined ? {} : { csrfToken })}
        />
      </DashboardGrid>
    </NextIntlClientProvider>,
  );

const region = (name: string) => screen.getByRole('region', { name });

describe('the phase 2 admin cards', () => {
  it('show every section with its figures', () => {
    page(answer(ALL_SECTIONS));
    const t = region('Monthly target');
    expect(within(t).getByText('$240,000.00')).toBeTruthy();
    expect(within(t).getByText('$190,560.00')).toBeTruthy();
    expect(within(t).getByText('On pace for 103.6%')).toBeTruthy();
    expect(within(t).getByText('Estimate')).toBeTruthy();
    expect(
      within(t).getByText(/Forecast \$248,600\.00 by 30 Nov · October was \$221,040\.00/),
    ).toBeTruthy();
    expect(
      within(t).getByText(/8 days left · \$49,440\.00 to go · \$6,180\.00 a day/),
    ).toBeTruthy();
    expect(within(t).getByRole('img', { name: /Monthly target: 79\.4% of target/ })).toBeTruthy();

    const f = region('Shopping funnel');
    expect(within(f).getByText('21,480')).toBeTruthy();
    expect(within(f).getByText('19.2% of viewers')).toBeTruthy();
    expect(within(f).getByText('53.6% of carts')).toBeTruthy();
    // A step under five is hidden in words, never 0.
    expect(within(f).getByText('Fewer than 5')).toBeTruthy();
    expect(within(f).queryByText('0')).toBeNull();
    expect(within(f).getByText(/29 of 30 days counted so far/)).toBeTruthy();

    const c = screen.getByText('Abandoned carts').closest('[data-kpi-card]') as HTMLElement;
    expect(within(c).getByText('708')).toBeTruthy();
    expect(within(c).getByText(/Untouched 24h\+ as of 21 Nov · about \$41,260\.00/)).toBeTruthy();

    const s = region('Searches with no results');
    expect(within(s).getByText('barberry')).toBeTruthy();
    expect(within(s).getByText('688')).toBeTruthy();

    const o = region('Orders by state');
    expect(within(o).getByText('NSW')).toBeTruthy();
    expect(within(o).getByText('Other states')).toBeTruthy();
    expect(within(o).getByText('Not recorded')).toBeTruthy();

    const d = region('Discount cost');
    expect(within(d).getByText('$18,400.00')).toBeTruthy();
    expect(within(d).getByText('Fewer than 5 uses')).toBeTruthy();
    expect(within(d).getByText(/12 orders refunded or cancelled gave back \$480\.00/)).toBeTruthy();
  });

  it('give each card a "?" that opens its definition', () => {
    page(answer(ALL_SECTIONS));
    for (const name of [
      'Monthly target',
      'Shopping funnel',
      'Abandoned carts',
      'Searches with no results',
      'Orders by state',
      'Discount cost',
    ]) {
      const button = screen.getByRole('button', { name: `What is ${name}?` });
      fireEvent.click(button);
      expect(button.getAttribute('aria-expanded')).toBe('true');
    }
    expect(
      screen.getByText(/steps after it; it is never shown as 0|every step after it/),
    ).toBeTruthy();
    expect(screen.getByText(/at least 10 signed-in shoppers searched it/)).toBeTruthy();
    expect(screen.getByText(/on the days a text found nothing/)).toBeTruthy();
  });

  it('render a searched text as plain text, never as markup', () => {
    const { container } = page(answer(ALL_SECTIONS));
    const s = region('Searches with no results');
    const node = within(s).getByText(XSS);
    expect(node.textContent).toBe(XSS);
    expect(node.children).toHaveLength(0);
    expect(container.querySelector('img')).toBeNull();
    expect(within(s).queryByRole('link')).toBeNull();
    expect(container.innerHTML).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('leave out every card the API left out (null) or the session holds no key for', () => {
    page(
      answer({
        marketTarget: null,
        shoppingFunnel: null,
        zeroResultSearches: null,
        abandonedCarts: null,
        ordersByState: null,
        discountCost: null,
      }),
    );
    for (const name of [
      'Monthly target',
      'Shopping funnel',
      'Abandoned carts',
      'Searches with no results',
      'Orders by state',
      'Discount cost',
    ]) {
      expect(screen.queryByText(name)).toBeNull();
    }
    expect(screen.queryByRole('alert')).toBeNull();
    cleanup();
    // The money key alone opens neither the target (needs its view key) nor the discount cost.
    page(answer(ALL_SECTIONS), ['commission-payouts.settlement.view']);
    expect(screen.queryByText('Monthly target')).toBeNull();
    expect(screen.queryByText('Discount cost')).toBeNull();
    expect(screen.queryByText('Searches with no results')).toBeNull();
  });

  it('say a failed section failed in place, without a figure', () => {
    page(
      answer({
        marketTarget: { status: 'error' },
        shoppingFunnel: { status: 'error' },
        zeroResultSearches: { status: 'error' },
        abandonedCarts: { status: 'error' },
        ordersByState: { status: 'error' },
        discountCost: { status: 'error' },
      }),
    );
    for (const name of [
      'Monthly target',
      'Shopping funnel',
      'Searches with no results',
      'Orders by state',
      'Discount cost',
    ]) {
      expect(within(region(name)).getByRole('alert').textContent).toContain('could not be loaded');
    }
    const c = screen.getByText('Abandoned carts').closest('[data-kpi-card]') as HTMLElement;
    expect(within(c).getByRole('alert')).toBeTruthy();
    expect(screen.queryByText(/\$/)).toBeNull();
  });

  it('say "not enough data" in words when the API holds figures back', () => {
    page(
      answer({
        marketTarget: {
          status: 'ok',
          kpis: {
            ...target,
            dayOfMonth: 2,
            forecast: { status: 'not-enough-data', daysElapsed: 1, minimumDays: 3 },
            target: null,
            progressBp: null,
            paceBp: null,
            toGo: null,
            perDayToGo: null,
          },
        },
        shoppingFunnel: {
          status: 'ok',
          kpis: { status: 'not-enough-data', minimum: 20, recordedDays: 3, periodDays: 7 },
        },
        zeroResultSearches: {
          status: 'ok',
          kpis: { status: 'not-enough-data', minimumSearchers: 10, recordedDays: 7, periodDays: 7 },
        },
        abandonedCarts: {
          status: 'ok',
          kpis: { status: 'not-enough-data', minimum: 5, recordedDays: 5, periodDays: 7 },
        },
        ordersByState: { status: 'ok', kpis: { status: 'not-enough-data', paid: 3, minimum: 5 } },
        discountCost: { status: 'ok', kpis: { status: 'not-enough-data', orders: 2, minimum: 5 } },
      }),
    );
    const t = region('Monthly target');
    expect(within(t).getByText('No monthly target is set')).toBeTruthy();
    expect(within(t).getByText(/Not enough data for a forecast yet/)).toBeTruthy();
    expect(within(region('Shopping funnel')).getByText('Not enough data yet')).toBeTruthy();
    expect(
      within(region('Searches with no results')).getByText('Not enough data yet'),
    ).toBeTruthy();
    expect(
      within(region('Searches with no results')).getByText(/at least 10 shoppers searched it/),
    ).toBeTruthy();
    expect(within(region('Orders by state')).getByText('Not enough data yet')).toBeTruthy();
    expect(within(region('Discount cost')).getByText(/2 so far/)).toBeTruthy();
    expect(screen.getByText('Not enough data yet: fewer than 5 carts.')).toBeTruthy();
    expect(screen.queryByText('$0.00')).toBeNull();
  });

  it('show the empty states of a period with nothing in it', () => {
    page(
      answer({
        zeroResultSearches: {
          status: 'ok',
          kpis: { status: 'available', queries: [], recordedDays: 7, periodDays: 7 },
        },
        ordersByState: { status: 'ok', kpis: { status: 'not-enough-data', paid: 0, minimum: 5 } },
        discountCost: { status: 'ok', kpis: { status: 'not-enough-data', orders: 0, minimum: 5 } },
        abandonedCarts: {
          status: 'ok',
          kpis: { status: 'not-enough-data', minimum: 5, recordedDays: 0, periodDays: 1 },
        },
      }),
    );
    expect(screen.getByText('No searches without results in this period.')).toBeTruthy();
    expect(screen.getByText('No seller orders were paid in this period.')).toBeTruthy();
    expect(screen.getByText('No discounted orders in this period.')).toBeTruthy();
    expect(screen.getByText(/no day of this period is counted yet/)).toBeTruthy();
  });

  it('show a skeleton for every card while the read streams', () => {
    const pending = new Promise<KpiResult>(() => undefined);
    const { container } = render(
      <NextIntlClientProvider locale="en-AU" messages={messages}>
        <DashboardGrid>
          <KpiItems source={pending} period="30d" permissionKeys={ALL_KEYS} />
        </DashboardGrid>
      </NextIntlClientProvider>,
    );
    for (const name of [
      'Monthly target',
      'Shopping funnel',
      'Searches with no results',
      'Orders by state',
      'Discount cost',
    ]) {
      expect(screen.getByRole('region', { name })).toBeTruthy();
    }
    expect(container.textContent).toContain('Abandoned carts');
  });
});

describe('the monthly target editor', () => {
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
  afterEach(() => vi.unstubAllGlobals());

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  it('is offered only with the manage key', () => {
    page(answer(ALL_SECTIONS), ALL_KEYS, 'csrf');
    expect(within(region('Monthly target')).queryByRole('button', { name: 'Edit' })).toBeNull();
    cleanup();
    page(answer(ALL_SECTIONS), [...ALL_KEYS, 'settings.monthly-revenue-target.manage'], 'csrf');
    expect(within(region('Monthly target')).getByRole('button', { name: 'Edit' })).toBeTruthy();
  });

  it('reads the version, sends it with the amount in minor units, and reads the card again', async () => {
    fetchMock
      .mockResolvedValueOnce(
        json(200, {
          target: { amount: '24000000', currency: 'AUD' },
          version: 3,
          updatedAt: '2026-11-01T00:00:00.000Z',
          review: { reviewed: false, risk: 'low' },
        }),
      )
      .mockResolvedValueOnce(
        json(200, {
          target: { amount: '25000050', currency: 'AUD' },
          version: 4,
          updatedAt: '2026-11-22T00:00:00.000Z',
          review: { reviewed: false, risk: 'low' },
          request: null,
        }),
      );
    page(answer(ALL_SECTIONS), [...ALL_KEYS, 'settings.monthly-revenue-target.manage'], 'csrf');
    fireEvent.click(within(region('Monthly target')).getByRole('button', { name: 'Edit' }));
    const field = await screen.findByLabelText<HTMLInputElement>(/Target GMV per month \(AUD/);
    expect(field.value).toBe('240000.00');
    fireEvent.change(field, { target: { value: '250000.50' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save target' }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({
      target: { amount: '25000050', currency: 'AUD' },
      expectedVersion: 3,
    });
  });

  it('asks for a note where a change is reviewed and says when the target changed meanwhile', async () => {
    fetchMock
      .mockResolvedValueOnce(
        json(200, {
          target: null,
          version: 0,
          updatedAt: null,
          review: { reviewed: true, risk: 'high' },
        }),
      )
      .mockResolvedValueOnce(json(409, { statusCode: 409, code: 'settings.conflict' }));
    page(answer(ALL_SECTIONS), [...ALL_KEYS, 'settings.monthly-revenue-target.manage'], 'csrf');
    fireEvent.click(within(region('Monthly target')).getByRole('button', { name: 'Edit' }));
    const field = await screen.findByLabelText(/Target GMV per month/);
    fireEvent.change(field, { target: { value: '240000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save target' }));
    // No note yet: nothing is sent.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const note = screen.getByRole('textbox', { name: /note/i });
    fireEvent.change(note, { target: { value: 'Q4 plan' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save target' }));
    expect(await screen.findByText(/changed meanwhile/)).toBeTruthy();
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      target: { amount: '24000000', currency: 'AUD' },
      expectedVersion: 0,
      note: 'Q4 plan',
    });
  });
});

describe('targetMinorOf', () => {
  it('reads an amount in the currency, exactly', () => {
    expect(targetMinorOf('240000', 'AUD')).toBe('24000000');
    expect(targetMinorOf('240,000.5', 'AUD')).toBe('24000050');
    expect(targetMinorOf('5000', 'JPY')).toBe('5000');
    expect(targetMinorOf('1.5', 'JPY')).toBeNull();
    expect(targetMinorOf('0', 'AUD')).toBeNull();
    expect(targetMinorOf('-5', 'AUD')).toBeNull();
    expect(targetMinorOf('1e5', 'AUD')).toBeNull();
    expect(targetMinorOf('10000000000000', 'AUD')).toBeNull();
  });

  it('maps a refusal to its message', () => {
    expect(targetProblemOf({ status: 409, code: 'settings.conflict' })).toBe('conflict');
    expect(targetProblemOf({ status: 403, code: 'access.denied' })).toBe('denied');
    expect(targetProblemOf({ status: 0, code: 'network' })).toBe('unavailable');
  });
});
