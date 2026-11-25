// @vitest-environment jsdom
import { DashboardGrid } from '@mondapac/ui';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it } from 'vitest';
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
import type {
  AdminKpis,
  KpiDelta,
  KpiResult,
  MarketHealth,
  OrdersByStatusKpis,
} from './kpi-types.ts';
import { KpiItems } from './kpis.tsx';

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
    net: null,
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
    sellersWithOrders: 2,
    current: {
      ordersPaid: 3,
      ordersCancelled: 1,
      cancelRateBp: 3333,
      ordersShipped: 4,
      onTimeRateBp: 7500,
      ordersDelivered: 2,
      refunds: 2,
    },
    previous: {
      ordersPaid: 3,
      ordersCancelled: 0,
      cancelRateBp: 0,
      ordersShipped: 4,
      onTimeRateBp: 9000,
      ordersDelivered: 3,
      refunds: 1,
    },
    deltas: {
      ordersPaid: na(),
      ordersCancelled: na(),
      cancelRateBp: { value: 500, direction: 'up', state: 'ok' } as KpiDelta,
      ordersShipped: na(),
      onTimeRateBp: { value: -1500, direction: 'down', state: 'ok' } as KpiDelta,
      ordersDelivered: na(),
      refunds: na(),
    },
    series: [{ day: '2026-11-22', ordersPaid: 3, ordersCancelled: 1, refunds: 2 }],
    previousSeries: [],
  },
};
const topSellers = {
  status: 'ok' as const,
  kpis: {
    rows: [
      {
        sellerId: '01990000-0000-7000-8000-000000000051',
        storeName: 'Al-Noor Butchery',
        gmvWithTax: { amountMinor: '1842000', currency: 'AUD' },
        ordersPaid: 311,
        onTimeRateBp: 9700,
        refundRateBp: 60,
      },
      {
        sellerId: '01990000-0000-7000-8000-000000000052',
        storeName: null,
        gmvWithTax: { amountMinor: '900000', currency: 'AUD' },
        ordersPaid: 20,
        onTimeRateBp: null,
        refundRateBp: null,
      },
    ],
  },
};
const topCategories = {
  status: 'ok' as const,
  kpis: {
    rows: [
      {
        categoryId: '01990000-0000-7000-8000-000000000061',
        name: 'Fresh meat',
        salesWithTax: { amountMinor: '500000', currency: 'AUD' },
        orders: 40,
      },
      {
        categoryId: '00000000-0000-0000-0000-000000000000',
        name: null,
        salesWithTax: { amountMinor: '20000', currency: 'AUD' },
        orders: 2,
      },
    ],
  },
};
const orderStatus: { status: 'ok'; kpis: OrdersByStatusKpis } = {
  status: 'ok',
  kpis: {
    paid: 40,
    toShip: 5,
    shipped: 10,
    delivered: 20,
    cancelled: 3,
    refunded: 2,
    cancelledRateBp: 750,
    refundedRateBp: 500,
    sameDayShare: { status: 'available', sameDay: 12, paid: 40, rateBp: 3000 },
  },
};
const readyNet = (total: object, rate: object = { status: 'complete', rateBp: 1320 }) => ({
  readiness: { ready: true, reason: 'ready' as const },
  current: {
    currency: 'AUD',
    commissionCharged: money('250000'),
    commissionRefunded: money('0'),
    components: {},
    total,
  },
  previous: null,
  takeRate: { current: rate, previous: null },
  deltas: { total: ok() },
});
const withNet = (net: unknown) =>
  ({
    ...finance,
    kpis: { ...finance.kpis, net },
  }) as unknown as NonNullable<AdminKpis['finance']>;
const health: MarketHealth = {
  uncertifiedListings: { status: 'ok', count: 2 },
  sellersAtRisk: { status: 'ok', count: 0 },
  listings: { status: 'ok', active: 8412, outOfStock: 260, outOfStockRateBp: 310 },
  certificatesExpiring: { status: 'ok', count: 6, withinDays: 30 },
  payoutsOnHold: {
    status: 'ok',
    count: 4,
    amount: { status: 'not-available', reason: 'not-recorded' },
  },
  disputeRate: { status: 'ok', disputes: 3, paidSellerOrders: 1000, rateBp: 30 },
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
    ordersByStatus: null,
    topSellers: null,
    topCategories: null,
    health: null,
    ...parts,
  },
});
const FULL = answer({
  finance: withNet(readyNet({ status: 'complete', amount: money('221180') })),
  operations,
  ordersByStatus: orderStatus,
  topSellers,
  topCategories,
  health,
});

const ALL = [
  'ordering.order.view',
  'commission-payouts.settlement.view',
  'sellers.seller.view',
  'catalog.product.view',
];
const page = (result: KpiResult | null, keys: readonly string[] = ALL) =>
  render(
    wrap(
      <DashboardGrid>
        <KpiItems source={result} period="7d" permissionKeys={keys} />
      </DashboardGrid>,
    ),
  );
const card = (label: string) =>
  screen.getByText(label, { selector: 'span, a' }).closest('[data-kpi-card]') as HTMLElement;

describe('the admin KPI cards', () => {
  it('shows four figures, only GMV highlighted, with money, rates and changes', () => {
    page(FULL);
    const cards = document.querySelectorAll('[data-kpi-card]');
    expect(cards).toHaveLength(4);
    const highlighted = document.querySelectorAll('[data-highlight]');
    expect(highlighted).toHaveLength(1);
    expect(within(highlighted[0] as HTMLElement).getByText('GMV (incl. GST)')).toBeTruthy();
    expect(screen.getByText('$1,234.56')).toBeTruthy();
    expect(screen.getByText(/\$1,122\.33 excl\. GST/)).toBeTruthy();
    expect(within(card('Mondapac net revenue')).getByText('$2,211.80')).toBeTruthy();
    expect(within(card('Mondapac net revenue')).getByText(/Take rate 13\.2%/)).toBeTruthy();
    expect(screen.getAllByText('+12.5%').length).toBeGreaterThan(0);
    // A change that is n/a never reads as zero.
    expect(within(card('Average order (incl. GST)')).getByText('n/a')).toBeTruthy();
  });

  it('gives every card, chart and table a "?" that opens its definition', () => {
    page(FULL);
    const names = [
      'GMV (incl. GST)',
      'Seller orders paid',
      'Mondapac net revenue',
      'Average order (incl. GST)',
      'Revenue analytics',
      'Sales by category',
      'Orders by status',
      'Supply and health',
      'Top sellers',
    ];
    for (const name of names) {
      const button = screen.getByRole('button', { name: `What is ${name}?` });
      expect(button.getAttribute('aria-expanded')).toBe('false');
      fireEvent.click(button);
      expect(button.getAttribute('aria-expanded')).toBe('true');
    }
    expect(screen.getByText(/Goods of paid orders on the day they were paid/)).toBeTruthy();
    expect(screen.getByText(/A cart bought from three stores/)).toBeTruthy();
  });

  it('leaves out every section the API refused, without an error or a zero', () => {
    page(answer({ finance: null, operations: null }), ['ordering.order.view']);
    expect(document.querySelectorAll('[data-kpi-card]')).toHaveLength(0);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('Revenue analytics')).toBeNull();
    expect(screen.queryByText('Orders by status')).toBeNull();
    expect(screen.queryByText('Top sellers')).toBeNull();
    expect(screen.queryByText('Supply and health')).toBeNull();
  });

  it('leaves out the money cards and charts of an orders-only session', () => {
    page(answer({ operations, ordersByStatus: orderStatus }), ['ordering.order.view']);
    expect(screen.getByText('Seller orders paid')).toBeTruthy();
    expect(screen.queryByText('GMV (incl. GST)')).toBeNull();
    expect(screen.queryByText('Mondapac net revenue')).toBeNull();
    expect(screen.getByText('Orders by status')).toBeTruthy();
    expect(screen.queryByText('Sales by category')).toBeNull();
  });

  it('says a failed section failed in place and never shows a zero for it', () => {
    page(answer({ finance: { status: 'error' }, operations, ordersByStatus: { status: 'error' } }));
    const alerts = screen.getAllByRole('alert').map((a) => a.textContent);
    expect(alerts.length).toBeGreaterThanOrEqual(4);
    expect(card('GMV (incl. GST)').textContent).toContain('could not be loaded');
    expect(screen.queryByText(/\$0\.00/)).toBeNull();
    // The orders section still shows.
    expect(within(card('Seller orders paid')).getByText('3')).toBeTruthy();
    // The chart keeps the orders measure and names the failed one.
    expect(screen.getByText('GMV could not be loaded.')).toBeTruthy();
  });

  it('shows an error in every card when the whole read failed', () => {
    page({ kind: 'error' });
    // The four headline cards and Abandoned carts (phase 2), each with its own error.
    expect(document.querySelectorAll('[data-kpi-card] [role="alert"]')).toHaveLength(5);
    expect(screen.getAllByRole('alert').length).toBeGreaterThan(4);
    expect(screen.queryByText(/\$/)).toBeNull();
  });

  it('shows nothing without a read', () => {
    const { container } = page(null);
    expect(container.querySelectorAll('[data-kpi-card]')).toHaveLength(0);
  });

  it('lets a single card of the middle row take the whole row', () => {
    page(answer({ ordersByStatus: orderStatus }), ['ordering.order.view']);
    expect(screen.getByRole('region', { name: 'Orders by status' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Sales by category' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Supply and health' })).toBeNull();
    const row = screen.getByRole('region', { name: 'Orders by status' }).parentElement!
      .parentElement!;
    // Absent cards leave empty cells, hidden by CSS; the one card is flex-1 (fills the row).
    const filled = [...row.children].filter((cell) => cell.childElementCount > 0);
    expect(filled).toHaveLength(1);
    expect(filled[0]!.className).toContain('lg:flex-1');
    expect(row.className).toContain('lg:flex');
  });

  describe('a change that must agree with its figures', () => {
    const withCurrent = (gmv: string, previousGmv: string) =>
      answer({
        finance: {
          ...finance,
          kpis: {
            ...finance.kpis,
            current: { ...finance.kpis.current, gmvWithTax: money(gmv) },
            previous: { ...finance.kpis.previous, gmvWithTax: money(previousGmv) },
          },
        },
      });

    it('shows a fall to nothing as a drop, never the API’s stale rise', () => {
      page(withCurrent('0', '100000'));
      const gmv = card('GMV (incl. GST)');
      expect(within(gmv).getByText('$0.00')).toBeTruthy();
      expect(within(gmv).queryByText('+12.5%')).toBeNull();
      expect(within(gmv).getByText(/-100(\.0)?%/)).toBeTruthy();
    });

    it('shows n/a when there was nothing before, never a percentage', () => {
      page(withCurrent('123456', '0'));
      const gmv = card('GMV (incl. GST)');
      expect(within(gmv).getByText('n/a')).toBeTruthy();
      expect(within(gmv).queryByText('+12.5%')).toBeNull();
    });
  });

  describe('net revenue', () => {
    const net = (finance: unknown) => page(answer({ finance: finance as AdminKpis['finance'] }));

    it('says when a week of matching ledger is not in yet, with no figure', () => {
      net(
        withNet({
          ...readyNet({ status: 'complete', amount: money('1') }),
          readiness: { ready: false, reason: 'days-not-matching' },
          current: null,
        }),
      );
      expect(
        within(card('Mondapac net revenue')).getByText(/Shown after a week of matching ledger/),
      ).toBeTruthy();
      expect(card('Mondapac net revenue').textContent).not.toMatch(/\$/);
    });

    it('never shows a partial total as a number: it names what is missing', () => {
      net(withNet(readyNet({ status: 'partial', missing: ['fleetFees', 'deliveryMargin'] })));
      const text = card('Mondapac net revenue').textContent;
      expect(text).toContain('fleet fees, delivery margin not recorded');
      expect(text).not.toMatch(/\$\d/);
    });

    it('shows a failed net read as an error while GMV still shows', () => {
      net(withNet(null));
      expect(card('Mondapac net revenue').textContent).toContain('Net revenue could not be loaded');
      expect(within(card('GMV (incl. GST)')).getByText('$1,234.56')).toBeTruthy();
    });

    it('labels a partial take rate with its basis and says when nothing sold', () => {
      const partial = net(
        withNet(
          readyNet(
            { status: 'complete', amount: money('1000') },
            { status: 'partial', rateBp: 800, basis: ['commission'] },
          ),
        ),
      );
      expect(screen.getByText('Take rate 8%, from commission only')).toBeTruthy();
      partial.unmount();
      net(withNet(readyNet({ status: 'complete', amount: money('0') }, { status: 'no-sales' })));
      expect(screen.getByText('Take rate: no sales in the period')).toBeTruthy();
    });

    it('formats in the currency of the Market (a second market fixture)', () => {
      const jpy = { amountMinor: '480000', currency: 'JPY' };
      const nz = withNet(readyNet({ status: 'complete', amount: jpy }));
      page(
        answer({
          finance: {
            ...nz,
            kpis: { ...(nz as { kpis: object }).kpis, currency: 'JPY' },
          } as AdminKpis['finance'],
        }),
      );
      expect(within(card('Mondapac net revenue')).getByText(/480,000/)).toBeTruthy();
    });
  });

  describe('the revenue chart', () => {
    it('switches measure, and offers the figures as a table', () => {
      page(FULL);
      const chart = screen.getByRole('region', { name: 'Revenue analytics' });
      expect(within(chart).getByRole('button', { name: 'View as table' })).toBeTruthy();
      fireEvent.click(within(chart).getByRole('button', { name: 'View as table' }));
      expect(within(chart).getByRole('table')).toBeTruthy();
      expect(within(chart).getByText('$500.00')).toBeTruthy();
    });

    it('says there is no data, and not enough data for one day', () => {
      const none = page(
        answer({
          finance: {
            ...finance,
            kpis: {
              ...finance.kpis,
              series: finance.kpis.series.map((d) => ({ ...d, gmvWithTax: '0' })),
              previousSeries: [],
            },
          },
        }),
        ['commission-payouts.settlement.view'],
      );
      expect(screen.getByText('No sales in this period or the one before.')).toBeTruthy();
      none.unmount();
      page(
        answer({
          finance: {
            ...finance,
            kpis: { ...finance.kpis, series: finance.kpis.series.slice(-1) },
          },
        }),
        ['commission-payouts.settlement.view'],
      );
      expect(screen.getByText('Not enough data yet')).toBeTruthy();
    });
  });

  describe('sales by category', () => {
    it('shows the donut with its table', () => {
      page(FULL);
      const region = screen.getByRole('region', { name: 'Sales by category' });
      fireEvent.click(within(region).getByRole('button', { name: 'View as table' }));
      expect(within(region).getByText('Fresh meat')).toBeTruthy();
      expect(within(region).getByText('Uncategorised')).toBeTruthy();
    });

    it('says not enough data below five orders, and empty when nothing sold', () => {
      const few = {
        status: 'ok' as const,
        kpis: { rows: [{ ...topCategories.kpis.rows[0]!, orders: 2 }] },
      };
      const a = page(answer({ topCategories: few }), ['commission-payouts.settlement.view']);
      expect(screen.getByText('Not enough data yet')).toBeTruthy();
      expect(screen.getByText(/ranked once there are 5 or more orders/)).toBeTruthy();
      a.unmount();
      page(answer({ topCategories: { status: 'ok', kpis: { rows: [] } } }), [
        'commission-payouts.settlement.view',
      ]);
      expect(screen.getByText('No sales in this period yet.')).toBeTruthy();
    });

    it('fails in place', () => {
      page(answer({ topCategories: { status: 'error' } }), ['commission-payouts.settlement.view']);
      expect(
        within(screen.getByRole('region', { name: 'Sales by category' })).getByRole('alert'),
      ).toBeTruthy();
    });
  });

  describe('orders by status', () => {
    const status = (kpis: Partial<typeof orderStatus.kpis>) =>
      page(
        answer({
          operations,
          ordersByStatus: { status: 'ok', kpis: { ...orderStatus.kpis, ...kpis } },
        }),
        ['ordering.order.view'],
      );
    const region = () => screen.getByRole('region', { name: 'Orders by status' });

    it('shows the split, the rates, on-time and the table', () => {
      status({});
      expect(within(region()).getByText('Cancelled')).toBeTruthy();
      expect(within(region()).getByText('75%')).toBeTruthy();
      fireEvent.click(within(region()).getByRole('button', { name: 'View as table' }));
      expect(within(region()).getByRole('table')).toBeTruthy();
    });

    it('same-day share: a percentage only when it is available', () => {
      status({});
      expect(within(region()).getByText('30%')).toBeTruthy();
      expect(within(region()).getByText('12 of 40 paid orders')).toBeTruthy();
    });

    it('same-day share: not enough data is words, never a percentage or zero', () => {
      status({ sameDayShare: { status: 'not-enough-data', paid: 3, minimum: 5 } });
      const tile = within(region()).getByText('Same-day share').parentElement!;
      expect(tile.textContent).toContain('Not enough data');
      expect(tile.textContent).toContain('Needs 5 or more paid orders; 3 so far.');
      expect(tile.textContent).not.toMatch(/%|\b0\b/);
    });

    it('same-day share: not available says how many orders lack a method', () => {
      status({
        sameDayShare: { status: 'not-available', reason: 'method-unknown', unknownMethod: 7 },
      });
      const tile = within(region()).getByText('Same-day share').parentElement!;
      expect(tile.textContent).toContain('Not enough data');
      expect(tile.textContent).toContain(
        'Shown once every paid order has a delivery method; 7 paid orders have none yet.',
      );
      expect(tile.textContent).not.toMatch(/%/);
    });

    it('says not enough data below five paid orders, and empty at none', () => {
      const a = status({ paid: 3, delivered: 3, toShip: 0, shipped: 0, cancelled: 0, refunded: 0 });
      expect(within(region()).getByText('Not enough data yet')).toBeTruthy();
      a.unmount();
      status({ paid: 0, delivered: 0, toShip: 0, shipped: 0, cancelled: 0, refunded: 0 });
      expect(within(region()).getByText('No seller orders were paid in this period.')).toBeTruthy();
    });

    it('shows an error in the on-time tile when only the operations read failed', () => {
      page(answer({ operations: { status: 'error' }, ordersByStatus: orderStatus }), [
        'ordering.order.view',
      ]);
      expect(within(region()).getByText('Shipped on time').parentElement!.textContent).toContain(
        'could not be loaded',
      );
      expect(within(region()).getByText('30%')).toBeTruthy();
    });
  });

  describe('supply and health', () => {
    const region = () => screen.getByRole('region', { name: 'Supply and health' });

    it('shows every count with its words, and never a zero for an unrecorded amount', () => {
      page(FULL);
      const text = region().textContent;
      expect(text).toContain('8,412');
      expect(text).toContain('3.1%');
      expect(text).toContain('Approved seller certificates ending in the next 30 days');
      expect(text).toContain('Incident');
      expect(text).toContain('All clear');
      expect(text).toContain('0.3%');
      expect(within(region()).getByText('Amount held is not recorded yet')).toBeTruthy();
    });

    it('says "Not enough data" for a dispute rate with no paid orders, never 0%', () => {
      page(
        answer({
          operations,
          health: {
            ...health,
            disputeRate: { status: 'ok', disputes: 0, paidSellerOrders: 0, rateBp: null },
          },
        }),
      );
      const row = within(region()).getByText('Dispute rate').closest('li')!;
      expect(row.textContent).toContain('Not enough data');
      expect(row.textContent).not.toMatch(/%|of 0/);
    });

    it('leaves out a count the viewer has no key for and shows a failed one in place', () => {
      page(
        answer({
          operations,
          health: {
            ...health,
            listings: null,
            certificatesExpiring: { status: 'error' },
            disputeRate: null,
          },
        }),
      );
      expect(within(region()).queryByText('Active listings')).toBeNull();
      expect(within(region()).queryByText('Dispute rate')).toBeNull();
      expect(
        within(region()).getByText('Certificates expiring').closest('li')!.textContent,
      ).toContain('Could not be loaded.');
    });

    it('is left out when there is nothing in it', () => {
      page(answer({ health: null }), ['catalog.product.view']);
      expect(screen.queryByText('Supply and health')).toBeNull();
    });
  });

  describe('top sellers', () => {
    it('lists the stores with links when the session may open them', () => {
      page(FULL);
      expect(screen.getByRole('link', { name: 'Al-Noor Butchery' }).getAttribute('href')).toBe(
        '/sellers/01990000-0000-7000-8000-000000000051',
      );
      expect(screen.getByText('Unnamed store')).toBeTruthy();
      expect(screen.getByText('$18,420.00')).toBeTruthy();
    });

    it('shows plain names without the sellers key, and says when nobody sold', () => {
      const a = page(FULL, ['commission-payouts.settlement.view']);
      expect(screen.queryByRole('link', { name: 'Al-Noor Butchery' })).toBeNull();
      a.unmount();
      page(answer({ topSellers: { status: 'ok', kpis: { rows: [] } } }), [
        'commission-payouts.settlement.view',
      ]);
      expect(screen.getByText('No sales in this period yet.')).toBeTruthy();
    });
  });

  it('says in one line what the figures cover, in Market days, and how fresh they are', () => {
    page(FULL);
    expect(screen.getByText('16 Nov - 22 Nov · Market days · updated 2 min ago')).toBeTruthy();
  });
});

describe('a custom range', () => {
  it('shows the fields the API refused inline, with no figures', () => {
    const { container } = render(
      wrap(
        <DashboardGrid>
          <KpiItems
            source={{ kind: 'invalid', fields: [{ path: 'from', code: 'too-long' }] }}
            period="custom"
            permissionKeys={ALL}
          />
        </DashboardGrid>,
      ),
    );
    expect(screen.getByText('Choose a valid range to see figures, or').textContent).toContain(
      'go back to 30 days',
    );
    expect(screen.getByRole('link', { name: 'go back to 30 days' }).getAttribute('href')).toBe(
      '/?period=30d',
    );
    expect(screen.queryByRole('alert')).toBeNull();
    expect(container.querySelectorAll('[data-kpi-card]')).toHaveLength(0);
  });

  it('compares with the days just before', () => {
    page(FULL, ALL);
    cleanup();
    render(
      wrap(
        <DashboardGrid>
          <KpiItems source={FULL} period="custom" permissionKeys={ALL} />
        </DashboardGrid>,
      ),
    );
    expect(screen.getAllByText(/vs the days just before/).length).toBeGreaterThan(0);
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
