import { NextIntlClientProvider } from 'next-intl';
import { createRoot } from 'react-dom/client';
import messages from '../../messages/en.json';
import '../../app/globals.css';
import { AdminDashboard } from '../../src/dashboard/dashboard.tsx';
import { validateRange, type KpiSelection } from '../../src/dashboard/kpi-range.ts';
import type { AdminKpis, KpiResult, SameDayShare } from '../../src/dashboard/kpi-types.ts';
import type { AdminDashboardData } from '../../src/dashboard/types.ts';
import type { WorkQueueAnswer } from '../../src/work-queue/queues.ts';

const scenario = new URLSearchParams(window.location.search).get('s') ?? 'full';
const selection: KpiSelection =
  scenario === 'custom'
    ? { id: 'custom', from: '2026-09-01', to: '2026-11-23' }
    : scenario === 'custom-bad'
      ? { id: 'custom', from: '2024-01-01', to: '2026-11-23' }
      : { id: '30d' };
const NOW = '2026-11-23T03:00:00.000Z';
const ago = (h: number) => new Date(Date.parse(NOW) - h * 3_600_000).toISOString();
const ID = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const aud = (n: number) => ({ amountMinor: String(n), currency: 'AUD' });
const day = (offset: number) =>
  new Date(Date.UTC(2026, 10, 23 - offset)).toISOString().slice(0, 10);
const ok = { value: 1240, direction: 'up' as const, state: 'ok' as const };
const down = { value: -310, direction: 'down' as const, state: 'ok' as const };

const money = (days: number, base: number, shift: number) =>
  Array.from({ length: days }, (_, i) => {
    const wave = 1 + 0.25 * Math.sin((i + shift) / 2.2) + (i / days) * 0.2;
    const gmv = Math.round(base * wave);
    return {
      day: day(days - 1 - i),
      gmvWithTax: String(gmv),
      gmvWithoutTax: String(Math.round(gmv / 1.1)),
      refundedWithTax: String(Math.round(gmv * 0.02)),
    };
  });
const counts = (days: number, base: number, shift: number) =>
  Array.from({ length: days }, (_, i) => ({
    day: day(days - 1 - i),
    ordersPaid: Math.max(1, Math.round(base * (1 + 0.25 * Math.sin((i + shift) / 2.2)))),
    ordersCancelled: 1,
    refunds: 1,
  }));
const cur = money(30, 610000, 0);
const prev = money(30, 560000, 3);
const gmvTotal = cur.reduce((n, r) => n + Number(r.gmvWithTax), 0);
const values = (gmv: number) => ({
  gmvWithTax: aud(gmv),
  gmvWithoutTax: aud(Math.round(gmv / 1.1)),
  refundedWithTax: aud(Math.round(gmv * 0.025)),
  refundRateBp: 250,
  netSalesWithTax: aud(Math.round(gmv * 0.975)),
  averageOrderWithTax: aud(7640),
});
const net = (partial: boolean, ready = true) => ({
  readiness: { ready, reason: ready ? ('ready' as const) : ('days-not-matching' as const) },
  current: ready
    ? {
        currency: 'AUD',
        commissionCharged: aud(1_800_000),
        commissionRefunded: aud(20_000),
        components: {},
        total: partial
          ? { status: 'partial' as const, missing: ['fleetFees', 'platformFundedCashback'] }
          : { status: 'complete' as const, amount: aud(2_211_800) },
      }
    : null,
  previous: null,
  takeRate: { current: { status: 'complete' as const, rateBp: 1320 }, previous: null },
  deltas: { total: ok },
});
const ops = (orders: number) => ({
  ordersPaid: orders,
  ordersCancelled: 60,
  cancelRateBp: 250,
  ordersShipped: 2200,
  onTimeRateBp: 9420,
  ordersDelivered: 1840,
  refunds: 47,
});
const finance = (kind: string) => ({
  status: 'ok' as const,
  refreshedAt: ago(0.07),
  kpis: {
    currency: 'AUD',
    current: values(gmvTotal),
    previous: values(Math.round(gmvTotal * 0.89)),
    deltas: {
      gmvWithTax: ok,
      gmvWithoutTax: ok,
      refundedWithTax: down,
      refundRateBp: down,
      netSalesWithTax: ok,
      averageOrderWithTax: ok,
    },
    series: kind === 'sparse' ? cur.slice(-1) : cur,
    previousSeries: kind === 'sparse' ? prev.slice(-1) : prev,
    net: net(kind === 'partial'),
  },
});
const operations = {
  status: 'ok' as const,
  refreshedAt: ago(0.07),
  kpis: {
    sellersWithOrders: 212,
    current: ops(2412),
    previous: ops(2230),
    deltas: {
      ordersPaid: ok,
      ordersCancelled: ok,
      cancelRateBp: down,
      ordersShipped: ok,
      onTimeRateBp: ok,
      ordersDelivered: ok,
      refunds: down,
    },
    series: counts(30, 80, 0),
    previousSeries: counts(30, 74, 3),
  },
};
const sellerRows = [
  ['Al-Noor Butchery', 1842000, 311, 9700, 60],
  ['Tehran Grocer', 1290500, 244, 9300, 110],
  ['Saffron House', 988000, 187, 9500, 40],
  ['Bosphorus Bakery', 721500, 402, 8800, 150],
  ['Medina Fresh', 653000, 129, 9600, 30],
] as const;
const topSellers = {
  status: 'ok' as const,
  kpis: {
    rows: sellerRows.map(([name, gmv, orders, onTime, refund], i) => ({
      sellerId: ID(0x50 + i),
      storeName: name,
      gmvWithTax: aud(gmv),
      ordersPaid: orders,
      onTimeRateBp: onTime,
      refundRateBp: refund,
    })),
  },
};
const cats = [
  ['Meat & poultry', 6120000, 700],
  ['Pantry & spices', 3890000, 520],
  ['Fresh produce', 2740000, 410],
  ['Bakery & sweets', 2180000, 330],
  ['Dairy & frozen', 1610000, 280],
  [null, 400000, 60],
] as const;
const topCategories = {
  status: 'ok' as const,
  kpis: {
    rows: cats.map(([name, sales, orders], i) => ({
      categoryId: ID(0x60 + i),
      name,
      salesWithTax: aud(sales),
      orders,
    })),
  },
};
const status = (paid: number, same: SameDayShare) => ({
  status: 'ok' as const,
  kpis: {
    paid,
    toShip: Math.round(paid * 0.06),
    shipped: Math.round(paid * 0.13),
    delivered: Math.round(paid * 0.76),
    cancelled: Math.round(paid * 0.025),
    refunded: Math.round(paid * 0.019),
    cancelledRateBp: 250,
    refundedRateBp: 190,
    sameDayShare: same,
  },
});
const health = {
  uncertifiedListings: { status: 'ok' as const, count: 2 },
  sellersAtRisk: { status: 'ok' as const, count: 0 },
  listings: { status: 'ok' as const, active: 8412, outOfStock: 260, outOfStockRateBp: 310 },
  certificatesExpiring: { status: 'ok' as const, count: 6, withinDays: 30 },
  payoutsOnHold: {
    status: 'ok' as const,
    count: 4,
    amount: { status: 'not-available' as const, reason: 'not-recorded' as const },
  },
  disputeRate: { status: 'ok' as const, disputes: 7, paidSellerOrders: 2412, rateBp: 29 },
};
const base: AdminKpis = {
  generatedAt: NOW,
  periodId: '30d',
  period: {
    id: '30d',
    current: { from: day(29), to: day(0) },
    previous: { from: day(59), to: day(30) },
  },
  operations,
  finance: finance(scenario),
  ordersByStatus: status(2412, { status: 'available', sameDay: 748, paid: 2412, rateBp: 3100 }),
  topSellers,
  topCategories,
  health,
};
const empty: AdminKpis = {
  ...base,
  operations: {
    ...operations,
    kpis: {
      ...operations.kpis,
      current: ops(0),
      series: counts(30, 0, 0).map((r) => ({ ...r, ordersPaid: 0 })),
      previousSeries: counts(30, 0, 0).map((r) => ({ ...r, ordersPaid: 0 })),
    },
  },
  finance: {
    ...finance('full'),
    kpis: {
      ...finance('full').kpis,
      current: { ...values(0), averageOrderWithTax: null },
      series: cur.map((r) => ({ ...r, gmvWithTax: '0', refundedWithTax: '0' })),
      previousSeries: prev.map((r) => ({ ...r, gmvWithTax: '0', refundedWithTax: '0' })),
      net: {
        ...net(false),
        current: { ...net(false).current!, total: { status: 'complete', amount: aud(0) } },
        takeRate: { current: { status: 'no-sales' }, previous: null },
      },
    },
  },
  ordersByStatus: status(0, { status: 'not-enough-data', paid: 0, minimum: 5 }),
  topSellers: { status: 'ok', kpis: { rows: [] } },
  topCategories: { status: 'ok', kpis: { rows: [] } },
};
const sparse: AdminKpis = {
  ...base,
  operations: {
    ...operations,
    kpis: {
      ...operations.kpis,
      series: operations.kpis.series.slice(-1),
      previousSeries: operations.kpis.previousSeries.slice(-1),
    },
  },
  ordersByStatus: status(4, { status: 'not-enough-data', paid: 4, minimum: 5 }),
  topCategories: {
    status: 'ok',
    kpis: {
      rows: cats.slice(0, 2).map(([n, s], i) => ({
        categoryId: ID(0x60 + i),
        name: n,
        salesWithTax: aud(s),
        orders: 2,
      })),
    },
  },
};
const partial: AdminKpis = {
  ...base,
  ordersByStatus: status(2412, {
    status: 'not-available',
    reason: 'method-unknown',
    unknownMethod: 318,
  }),
  topSellers: { status: 'error' },
  topCategories: null,
  health: {
    ...health,
    certificatesExpiring: { status: 'error' },
    listings: null,
    disputeRate: null,
  },
};
const picked =
  scenario === 'empty'
    ? empty
    : scenario === 'sparse'
      ? sparse
      : scenario === 'partial'
        ? partial
        : base;
const kpis: KpiResult =
  selection.id === 'custom' &&
  validateRange({ from: selection.from, to: selection.to, today: '2026-11-23' }).length > 0
    ? {
        kind: 'invalid',
        fields: validateRange({ from: selection.from, to: selection.to, today: '2026-11-23' }),
      }
    : { kind: 'ok', value: picked };

const q = (key: string, level: string, count: number, overdue: number, hours: number) => ({
  key,
  level,
  status: 'ok',
  count,
  overdue,
  oldestAt: ago(hours),
  countedAt: NOW,
});
const queue = {
  panel: 'admin',
  generatedAt: NOW,
  queues: [
    q('catalog.claims-without-certificate', 'critical', 2, 2, 5),
    q('commission-payouts.disputes-due', 'critical', 2, 0, -6),
    q('ordering.failed-payments', 'today', 2, 0, 3),
    q('ordering.late-deliveries', 'today', 11, 0, 48),
    q('sellers.applications', 'review', 17, 0, 72),
    q('ordering.pending-refunds', 'review', 4, 0, 9),
    q('catalog.pending-offers', 'review', 128, 0, 24),
  ],
} as unknown as WorkQueueAnswer;
const data = {
  workQueue: { kind: 'ok', value: queue },
  sellers: null,
  holds: null,
  offers: null,
  accounts: null,
  orders: null,
} as unknown as AdminDashboardData;

createRoot(document.getElementById('root')!).render(
  <NextIntlClientProvider locale="en-AU" messages={messages} timeZone="Australia/Brisbane">
    <main className="mx-auto max-w-[1200px] p-4 md:p-6">
      <AdminDashboard
        title="Dashboard"
        data={data}
        zone="Australia/Brisbane"
        permissionKeys={[
          'ordering.order.view',
          'commission-payouts.settlement.view',
          'sellers.seller.view',
          'catalog.product.view',
          'commission-payouts.dispute.view',
          'certification.seller-certificate.view',
          'reporting.marketplace-report.export',
        ]}
        kpis={kpis}
        selection={selection}
        today="2026-11-23"
      />
    </main>
  </NextIntlClientProvider>,
);
