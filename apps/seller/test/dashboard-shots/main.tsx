import { NextIntlClientProvider } from 'next-intl';
import { Toaster } from '@mondapac/ui';
import { createRoot } from 'react-dom/client';
import messages from '../../messages/en.json';
import '../../app/globals.css';
import { SellerDashboard } from '../../src/dashboard/dashboard.tsx';
import type { SellerKpiSources } from '../../src/dashboard/kpis/load.ts';
import type { Selection } from '../../src/dashboard/kpis/range.ts';
import type { SellerGoalFigures, SellerKpis } from '../../src/dashboard/kpis/types.ts';
import type { SellerDashboardData } from '../../src/dashboard/types.ts';
import type { WorkQueueAnswer } from '../../src/work-queue/queues.ts';

const scenario = new URLSearchParams(window.location.search).get('s') ?? 'full';
// A custom range shows as many days as its inputs say (1 Sep to 23 Nov is 84 days).
const selection: Selection =
  scenario === 'custom' || scenario === 'custom-empty'
    ? { id: 'custom', from: '2026-09-01', to: '2026-11-23' }
    : scenario === 'custom-bad'
      ? { id: 'custom', from: '2024-01-01', to: '2026-11-23' }
      : { id: '30d' };
const N = selection.id === 'custom' ? 84 : 30;
const ok = <T,>(value: T) => ({ kind: 'ok' as const, value });
const NOW = '2026-11-23T03:00:00.000Z';
const ago = (h: number) => new Date(Date.parse(NOW) - h * 3_600_000).toISOString();
const ID = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const CATS = ['c1', 'c2', 'c3', 'c4'].map((c, i) => ID(0x100 + i));

const dayStr = (offset: number) => {
  const d = new Date(Date.UTC(2026, 10, 23 - offset));
  return d.toISOString().slice(0, 10);
};
const series = (days: number, base: number, shift: number) =>
  Array.from({ length: days }, (_, i) => {
    const wave = 1 + 0.25 * Math.sin((i + shift) / 2.2) + (i / days) * 0.2;
    const orders = Math.max(1, Math.round((base / 11000) * wave));
    return {
      day: dayStr(days - 1 - i + shift * 0),
      salesInclTax: String(orders * 8200 + 340 * i),
      orders,
      refundedInclTax: '0',
    };
  });
const sum = (rows: { salesInclTax: string; orders: number }[]) => ({
  sales: rows.reduce((n, r) => n + Number(r.salesInclTax), 0),
  orders: rows.reduce((n, r) => n + r.orders, 0),
});
const totals = (rows: ReturnType<typeof series>) => {
  const { sales, orders } = sum(rows);
  return {
    salesInclTax: String(sales),
    salesExclTax: String(Math.round(sales / 1.1)),
    orders,
    units: orders * 2,
    averageOrderValue: String(Math.round(sales / orders)),
    refundedInclTax: '0',
    refunds: 0,
    refundRateBps: 60,
    ordersCancelled: 2,
    ordersShipped: orders,
    shippedOnTimeBps: 9600,
  };
};
const cur = series(N, 66000, 0);
const prev = series(N, 60000, 3).map((r, i) => ({ ...r, day: dayStr(2 * N - 1 - i) }));
const kpis: { -readonly [K in keyof SellerKpis]: SellerKpis[K] } = {
  period: {
    id: selection.id,
    current: { from: dayStr(N - 1), to: dayStr(0) },
    previous: { from: dayStr(2 * N - 1), to: dayStr(N) },
    days: N,
  },
  timezone: 'Australia/Brisbane',
  currency: 'AUD',
  current: totals(cur),
  previous: totals(prev),
  series: cur,
  previousSeries: prev,
  topCategories: [
    { categoryId: CATS[0]!, netSalesInclTax: '421000', orders: 188, units: 188 },
    { categoryId: CATS[1]!, netSalesInclTax: '338000', orders: 141, units: 241 },
    { categoryId: CATS[2]!, netSalesInclTax: '244000', orders: 102, units: 302 },
    { categoryId: CATS[3]!, netSalesInclTax: '198500', orders: 97, units: 97 },
  ],
  refreshedAt: ago(1),
};
// Dashboards v2 phase 2: the seller's own monthly goal (always the current month).
const goal: SellerGoalFigures = {
  month: '2026-11',
  lastMonth: '2026-10',
  timezone: 'Australia/Brisbane',
  currency: 'AUD',
  daysInMonth: 30,
  dayOfMonth: 23,
  daysLeft: 8,
  monthToDate: '2164000',
  lastMonthTotal: '2310000',
  forecast: { status: 'estimate', amount: '2835000' },
  target: '2700000',
  progressBp: 8015,
  paceBp: 10500,
  toGo: '536000',
  perDayToGo: '67000',
  version: 2,
};
const noGoal: SellerGoalFigures = {
  ...goal,
  dayOfMonth: 2,
  daysLeft: 29,
  monthToDate: '86000',
  forecast: { status: 'not-enough-data', daysElapsed: 1, minimumDays: 3 },
  target: null,
  progressBp: null,
  paceBp: null,
  toGo: null,
  perDayToGo: null,
  version: 0,
};
kpis.sellerGoal =
  scenario === 'goal-none'
    ? { status: 'ok', goal: noGoal }
    : scenario === 'goal-failed'
      ? { status: 'error' }
      : { status: 'ok', goal };
const health = {
  current: {
    day: dayStr(0),
    kind: 'scored' as const,
    band: 'healthy' as const,
    score: 86,
    lowestMetric: 'late-ready',
    formulaVersion: 'v1',
    computedAt: ago(5),
    orders: 311,
    metrics: [
      {
        metric: 'seller-cancellations',
        kind: 'scored' as const,
        band: 'healthy' as const,
        score: 96,
      },
      { metric: 'late-ready', kind: 'scored' as const, band: 'healthy' as const, score: 86 },
      { metric: 'customer-rating', kind: 'scored' as const, band: 'healthy' as const, score: 94 },
      { metric: 'lost-disputes', kind: 'scored' as const, band: 'healthy' as const, score: 100 },
      { metric: 'reports', kind: 'no-data' as const },
    ],
  },
  trend: [],
  refresh: { pending: false, retryAfterSeconds: 0 },
};
const q = (key: string, level: string, count: number, overdue: number, hours: number) => ({
  key,
  level,
  status: 'ok',
  count,
  overdue,
  oldestAt: ago(hours),
  countedAt: NOW,
});
const tasks = {
  panel: 'seller',
  generatedAt: NOW,
  queues: [
    q('ordering.late-orders', 'critical', 2, 2, 1),
    q('commission-payouts.dispute-reply-needed', 'critical', 1, 0, -20),
    q('ordering.to-ship-today', 'today', 9, 0, 3),
    q('ordering.pickups-uncollected', 'today', 3, 0, 5),
    q('reviews.unanswered', 'review', 6, 0, 48),
  ],
} as unknown as WorkQueueAnswer;
const order = (n: number, f: string, total: string) => ({
  sellerOrderId: ID(0xa7f0 + n),
  orderId: ID(500 + n),
  paidAt: ago(n * 5),
  subtotal: { amount: total, currency: 'AUD' },
  shipping: { amount: '0', currency: 'AUD' },
  discount: { amount: '0', currency: 'AUD' },
  shippingDiscount: { amount: '0', currency: 'AUD' },
  total: { amount: total, currency: 'AUD' },
  fulfilment: f,
  carrier: null,
  trackingRef: null,
  shippedAt: null,
  deliveredAt: null,
  deliveryMethod: 'instant',
  deliveryWindowStart: null,
  deliveryWindowEnd: null,
  readyAt: null,
  deliveryAttention: null,
  lines: [],
});
const data = {
  tasks: ok(tasks),
  orders: ok({
    sellerOrders: [
      order(2, 'to-ship', '8410'),
      order(3, 'delivered', '4200'),
      order(4, 'delivered', '11960'),
      order(5, 'delivered', '6345'),
    ],
    nextCursor: null,
  }),
  payout: null,
  sources: null,
  lowStock: ok({
    items: [
      {
        offerId: ID(1),
        variantId: ID(2),
        status: 'out',
        onlyLeft: null,
        changedAt: ago(4),
        productName: 'Lamb shoulder, halal',
        variantLabel: '1 kg',
      },
      {
        offerId: ID(3),
        variantId: ID(4),
        status: 'low',
        onlyLeft: 4,
        changedAt: ago(9),
        productName: 'Chicken thigh fillets',
        variantLabel: null,
      },
      {
        offerId: ID(5),
        variantId: ID(6),
        status: 'low',
        onlyLeft: 7,
        changedAt: ago(20),
        productName: 'Beef mince',
        variantLabel: '500 g',
      },
      {
        offerId: ID(7),
        variantId: ID(8),
        status: 'low',
        onlyLeft: 9,
        changedAt: ago(30),
        productName: 'Merguez sausages',
        variantLabel: '500 g',
      },
    ],
    nextCursor: null,
  }),
} as unknown as SellerDashboardData;
const tree = {
  categories: [
    { id: CATS[0]!, name: 'Lamb', depth: 3 },
    { id: CATS[1]!, name: 'Chicken', depth: 3 },
    { id: CATS[2]!, name: 'Beef', depth: 3 },
    { id: CATS[3]!, name: 'Sausages', depth: 3 },
  ],
};
const sources: SellerKpiSources = {
  refused: false,
  kpis: ok(kpis),
  categories: tree,
  health: ok(health),
  netEarnings: ok({
    range: kpis.period.current,
    timezone: 'Australia/Brisbane',
    currency: 'AUD',
    ready: scenario !== 'withheld',
    netEarnings:
      scenario === 'withheld'
        ? null
        : scenario === 'empty' || scenario === 'custom-empty'
          ? '0'
          : '1419000',
    refreshedAt: ago(1),
  }),
  nextPayout: ok({
    slotAt: '2026-11-26T23:00:00.000Z',
    zone: 'Australia/Brisbane',
    estimatedAmount: { amountMinor: '231000', currency: 'AUD' },
    blockReason: null,
  }),
  goal: { canManage: scenario !== 'goal-read-only', csrfToken: 'shots' },
};
const sparse: SellerKpiSources = {
  ...sources,
  kpis: ok({
    ...kpis,
    series: kpis.series.slice(-1),
    previousSeries: kpis.previousSeries.slice(-1),
  }),
};
const empty: SellerKpiSources = {
  ...sources,
  kpis: ok({
    ...kpis,
    current: {
      ...totals(cur),
      salesInclTax: '0',
      salesExclTax: '0',
      orders: 0,
      units: 0,
      averageOrderValue: null,
    },
    series: cur.map((r) => ({ ...r, orders: 0, salesInclTax: '0' })),
    previousSeries: prev.map((r) => ({ ...r, orders: 0, salesInclTax: '0' })),
    topCategories: [],
  }),
};
const refused: SellerKpiSources = {
  ...sources,
  refused: true,
  kpis: null,
  categories: null,
  netEarnings: null,
};
const pick =
  scenario === 'sparse'
    ? sparse
    : scenario === 'empty' || scenario === 'custom-empty'
      ? empty
      : scenario === 'custom-bad'
        ? refused
        : sources;

// The denied toast: the report download answers 403.
if (scenario === 'denied') {
  window.fetch = () => Promise.resolve(new Response('{}', { status: 403 }));
}

createRoot(document.getElementById('root')!).render(
  <NextIntlClientProvider locale="en-AU" messages={messages} timeZone="Australia/Brisbane">
    <Toaster labels={{ region: messages.toast.region, close: messages.toast.close }} />
    <main className="mx-auto max-w-[1200px] p-4 md:p-6">
      <SellerDashboard
        title="Dashboard"
        data={data}
        permissionKeys={[
          'ordering.seller-order.view',
          'commission-payouts.earnings.view',
          'inventory.stock.view',
          'catalog.own-product.view',
          'reporting.seller-report.export',
        ]}
        kpis={pick}
        selection={selection}
        today="2026-11-23"
      />
    </main>
  </NextIntlClientProvider>,
);
