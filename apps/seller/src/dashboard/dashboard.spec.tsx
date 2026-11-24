// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';
import type { SellerOrderView } from '../orders/types.ts';
import type { SellerSession } from '../server/session.ts';
import { SellerDashboard } from './dashboard.tsx';
import type { WorkQueueAnswer } from '../work-queue/queues.ts';
import type { SellerDashboardData, Widget } from './types.ts';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  redirect: vi.fn((to: string) => {
    throw new Error(`redirect:${to}`);
  }),
}));
vi.mock('../server/server-fetch.ts', () => ({ serverGet: mocks.get }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));

import { startSellerDashboard } from './load.ts';

/** Every read of the dashboard, awaited. */
async function loadSellerDashboard(session: SellerSession): Promise<SellerDashboardData> {
  const sources = startSellerDashboard(session);
  const [tasks, orders, payout, sourcesView, lowStock] = await Promise.all([
    sources.tasks,
    sources.orders,
    sources.payout,
    sources.sources,
    sources.lowStock,
  ]);
  return { tasks, orders, payout, sources: sourcesView, lowStock };
}

const wrap = (node: React.ReactNode, locale = 'en-AU') => (
  <NextIntlClientProvider locale={locale} messages={messages}>
    {node}
  </NextIntlClientProvider>
);
const ok = <T,>(value: T): Widget<T> => ({ kind: 'ok', value });
const ID = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const money = (amount: string) => ({ amount, currency: 'AUD' });

const order = (n: number, fulfilment: SellerOrderView['fulfilment']): SellerOrderView => ({
  sellerOrderId: ID(n),
  orderId: ID(500 + n),
  paidAt: '2026-10-14T01:00:00.000Z',
  subtotal: money('4000'),
  shipping: money('590'),
  discount: money('0'),
  shippingDiscount: money('0'),
  total: money('4590'),
  fulfilment,
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
const NOW = '2026-11-22T03:00:00.000Z';
const hoursAgo = (h: number) => new Date(Date.parse(NOW) - h * 3_600_000).toISOString();
const tasks: WorkQueueAnswer = {
  panel: 'seller',
  generatedAt: NOW,
  queues: [
    {
      key: 'ordering.late-orders',
      level: 'critical',
      status: 'ok',
      count: 2,
      overdue: 1,
      oldestAt: hoursAgo(2),
      countedAt: NOW,
    },
    {
      key: 'commission-payouts.dispute-reply-needed',
      level: 'critical',
      status: 'ok',
      count: 1,
      overdue: 0,
      oldestAt: hoursAgo(-20),
      countedAt: NOW,
    },
    {
      key: 'payments.payouts-blocked',
      level: 'critical',
      status: 'ok',
      count: 1,
      overdue: 0,
      oldestAt: hoursAgo(30),
      countedAt: NOW,
    },
    {
      key: 'ordering.to-ship-today',
      level: 'today',
      status: 'ok',
      count: 9,
      overdue: 0,
      oldestAt: hoursAgo(3),
      countedAt: NOW,
    },
    { key: 'ordering.pickups-uncollected', level: 'today', status: 'error' },
    {
      key: 'commission-payouts.payout-holds',
      level: 'today',
      status: 'ok',
      count: 0,
      overdue: 0,
      oldestAt: null,
      countedAt: NOW,
    },
    {
      key: 'reviews.unanswered',
      level: 'review',
      status: 'ok',
      count: 4,
      overdue: 0,
      oldestAt: hoursAgo(50),
      countedAt: NOW,
    },
    {
      key: 'inventory.published-out-of-stock',
      level: 'today',
      status: 'ok',
      count: 3,
      overdue: 0,
      oldestAt: null,
      countedAt: NOW,
    },
  ],
};
const full: SellerDashboardData = {
  tasks: ok(tasks),
  orders: ok({
    sellerOrders: [order(1, 'to-ship'), order(2, 'to-ship'), order(3, 'shipped')],
    nextCursor: null,
  }),
  payout: ok({
    status: 'enabled',
    ready: true,
    requirementsDue: 0,
    requirementsPastDue: false,
    secondFactorActive: true,
    lastSignInAt: null,
    timezone: null,
    locale: null,
    coolingOffUntil: null,
    payoutsPaused: false,
    changes: [],
  }),
  sources: ok({
    version: 1,
    max: 5,
    sources: [
      {
        id: ID(80),
        name: 'Warehouse',
        isDefault: true,
        position: 0,
        address: null,
        timeZone: null,
        createdAt: '2026-10-01T00:00:00.000Z',
      },
    ],
  }),
  lowStock: ok({
    items: [
      {
        offerId: ID(20),
        variantId: ID(21),
        status: 'low',
        onlyLeft: 1200,
        changedAt: '2026-10-14T01:00:00.000Z',
        productName: 'Lamb mince',
        variantLabel: '500 g',
      },
      {
        offerId: ID(22),
        variantId: ID(23),
        status: 'out',
        onlyLeft: null,
        changedAt: '2026-10-13T01:00:00.000Z',
        productName: null,
        variantLabel: null,
      },
    ],
    nextCursor: null,
  }),
};
const none: SellerDashboardData = {
  tasks: null,
  orders: null,
  payout: null,
  sources: null,
  lowStock: null,
};
const KEYS = [
  'ordering.seller-order.view',
  'catalog.own-product.view',
  'catalog.own-product.edit',
  'commission-payouts.earnings.view',
  'payments.payout-account.view',
  'inventory.stock.view',
  'identity.team-member.view',
  'identity.team-member.invite',
];

afterEach(cleanup);

describe('seller dashboard', () => {
  it("shows today's tasks first, each in words and linked to where it is done", () => {
    render(
      wrap(
        <SellerDashboard today="2026-11-23" title="Dashboard" data={full} permissionKeys={KEYS} />,
      ),
    );
    const card = within(screen.getByRole('region', { name: "Today's tasks" }));
    const late = card.getByRole('link', { name: 'Orders past their delivery promise' });
    expect(late.getAttribute('href')).toBe('/orders');
    expect(late.closest('li')?.textContent).toContain('2 · 1 overdue');
    expect(card.getByText('Due in 20h')).toBeTruthy();
    const payouts = card.getByRole('link', { name: 'Payouts paused or not set up' });
    expect(payouts.getAttribute('href')).toBe('/accounting/payout-account');
    expect(payouts.closest('li')?.textContent).toContain('Fix payout details');
    expect(card.getByText('Pickups ready, not collected').closest('li')?.textContent).toContain(
      "Couldn't load",
    );
    expect(card.getByRole('link', { name: 'Reviews to answer' }).getAttribute('href')).toBe(
      '/reviews',
    );
    // A task the panel does not know yet is left out; an empty one is summed up.
    expect(card.queryByText(/out of stock/)).toBeNull();
    expect(card.getByText('1 task is all clear')).toBeTruthy();
  });

  it("says today's tasks could not be loaded in their card", () => {
    render(
      wrap(
        <SellerDashboard
          today="2026-11-23"
          title="Dashboard"
          data={{ ...full, tasks: { kind: 'error' } }}
          permissionKeys={KEYS}
        />,
      ),
    );
    const card = within(screen.getByRole('region', { name: "Today's tasks" }));
    expect(card.getByText('This could not be loaded. Reload the page to try again.')).toBeTruthy();
  });

  it("gives no age for today's orders to ship: when they were paid is not what the seller acts on", () => {
    render(
      wrap(
        <SellerDashboard today="2026-11-23" title="Dashboard" data={full} permissionKeys={KEYS} />,
      ),
    );
    const card = within(screen.getByRole('region', { name: "Today's tasks" }));
    const row = card.getByRole('link', { name: 'Orders to ship today' }).closest('li');
    expect(row?.textContent).toContain('9');
    expect(row?.textContent).not.toContain('Oldest');
    // The review task keeps its age.
    expect(
      card.getByRole('link', { name: 'Reviews to answer' }).closest('li')?.textContent,
    ).toContain('Oldest 2d');
  });

  it('says how late a passed dispute deadline and every overdue late order are', () => {
    const answer: WorkQueueAnswer = {
      panel: 'seller',
      generatedAt: NOW,
      queues: [
        {
          key: 'ordering.late-orders',
          level: 'critical',
          status: 'ok',
          count: 1,
          overdue: 1,
          oldestAt: hoursAgo(1),
        },
        {
          key: 'commission-payouts.dispute-reply-needed',
          level: 'critical',
          status: 'ok',
          count: 1,
          overdue: 1,
          oldestAt: hoursAgo(2),
        },
        // Nothing paused: the payout task is clear, never "Fix payout details".
        { key: 'payments.payouts-blocked', level: 'critical', status: 'ok', count: 0, overdue: 0 },
      ],
    };
    render(
      wrap(
        <SellerDashboard
          today="2026-11-23"
          title="Dashboard"
          data={{ ...full, tasks: ok(answer) }}
          permissionKeys={KEYS}
        />,
      ),
    );
    const card = within(screen.getByRole('region', { name: "Today's tasks" }));
    expect(
      card.getByRole('link', { name: 'Orders past their delivery promise' }).closest('li')
        ?.textContent,
    ).toContain('Overdue 1h');
    expect(
      card.getByRole('link', { name: 'Disputes waiting for your reply' }).closest('li')
        ?.textContent,
    ).toContain('Overdue by 2h');
    expect(card.queryByText('Fix payout details')).toBeNull();
    expect(card.queryByRole('link', { name: 'Payouts paused or not set up' })).toBeNull();
    expect(card.getByText('1 task is all clear')).toBeTruthy();
  });

  it('says all clear when every task is empty', () => {
    const answer: WorkQueueAnswer = {
      panel: 'seller',
      generatedAt: NOW,
      queues: [
        { key: 'ordering.late-orders', level: 'critical', status: 'ok', count: 0, overdue: 0 },
        { key: 'reviews.unanswered', level: 'review', status: 'ok', count: 0, overdue: 0 },
      ],
    };
    render(
      wrap(
        <SellerDashboard
          today="2026-11-23"
          title="Dashboard"
          data={{ ...full, tasks: ok(answer) }}
          permissionKeys={KEYS}
        />,
      ),
    );
    const card = within(screen.getByRole('region', { name: "Today's tasks" }));
    expect(card.getByText('All clear: nothing needs you right now.')).toBeTruthy();
  });

  it('counts from the clock when the answer has no readable time', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse(NOW) + 3_600_000);
    try {
      render(
        wrap(
          <SellerDashboard
            today="2026-11-23"
            title="Dashboard"
            data={{ ...full, tasks: ok({ ...tasks, generatedAt: 'not a time' }) }}
            permissionKeys={KEYS}
          />,
        ),
      );
      const card = within(screen.getByRole('region', { name: "Today's tasks" }));
      expect(card.getByText('Due in 19h')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('links recent orders to their pages', () => {
    render(
      wrap(
        <SellerDashboard today="2026-11-23" title="Dashboard" data={full} permissionKeys={KEYS} />,
      ),
    );
    expect(
      screen.getByRole('link', { name: ID(1).slice(-8).toUpperCase() }).getAttribute('href'),
    ).toBe(`/orders/${ID(1)}`);
  });

  it('warns about an unready payout account and a missing stock location', () => {
    const data: SellerDashboardData = {
      ...full,
      payout: ok({
        status: 'restricted',
        ready: false,
        requirementsDue: 1,
        requirementsPastDue: false,
        secondFactorActive: true,
        lastSignInAt: null,
        timezone: null,
        locale: null,
        coolingOffUntil: null,
        payoutsPaused: false,
        changes: [],
      }),
      sources: ok({ version: 1, max: 5, sources: [] }),
    };
    render(
      wrap(
        <SellerDashboard today="2026-11-23" title="Dashboard" data={data} permissionKeys={KEYS} />,
      ),
    );
    expect(screen.getByRole('link', { name: 'Set up payouts' }).getAttribute('href')).toBe(
      '/accounting/payout-account',
    );
    expect(screen.getByRole('link', { name: 'Add a location' }).getAttribute('href')).toBe(
      '/settings/stock-locations',
    );
  });

  it('shows no banner when payout and stock are in order', () => {
    render(
      wrap(
        <SellerDashboard today="2026-11-23" title="Dashboard" data={full} permissionKeys={KEYS} />,
      ),
    );
    expect(screen.queryByRole('link', { name: 'Set up payouts' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Add a location' })).toBeNull();
  });

  it('fails one widget in place and renders the rest', () => {
    const partly: SellerDashboardData = { ...full, orders: { kind: 'error' } };
    render(
      wrap(
        <SellerDashboard
          today="2026-11-23"
          title="Dashboard"
          data={partly}
          permissionKeys={KEYS}
        />,
      ),
    );
    const orders = within(screen.getByRole('region', { name: 'Recent orders' }));
    expect(orders.getByText(/This could not be loaded/)).toBeTruthy();
    expect(screen.getByRole('region', { name: "Today's tasks" })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Stock watch' })).toBeTruthy();
  });

  it('says a list is empty instead of showing an empty table', () => {
    const empty: SellerDashboardData = {
      ...none,
      orders: ok({ sellerOrders: [], nextCursor: null }),
    };
    render(
      wrap(
        <SellerDashboard today="2026-11-23" title="Dashboard" data={empty} permissionKeys={[]} />,
      ),
    );
    expect(screen.getByText('No paid orders yet.')).toBeTruthy();
    expect(screen.queryAllByRole('table')).toHaveLength(0);
  });

  it('lists low and out-of-stock items, each linking to its stock page', () => {
    render(
      wrap(
        <SellerDashboard today="2026-11-23" title="Dashboard" data={full} permissionKeys={KEYS} />,
      ),
    );
    const card = within(screen.getByRole('region', { name: 'Stock watch' }));
    const lamb = card.getByRole('link', { name: 'Lamb mince · 500 g' });
    expect(lamb.getAttribute('href')).toBe(`/offers/${ID(20)}/stock`);
    expect(lamb.closest('li')?.textContent).toContain('1,200 left');
    // A missing name falls back; an out-of-stock unit shows no count.
    const unnamed = card.getByRole('link', { name: 'Unnamed product' });
    expect(unnamed.getAttribute('href')).toBe(`/offers/${ID(22)}/stock`);
    expect(unnamed.closest('li')?.textContent).toContain('Out of stock');
  });

  it('lists out of stock first, then low stock, and links View all to the offers', () => {
    const item = (n: number, status: string, hours: number) => ({
      offerId: ID(300 + n),
      variantId: ID(400 + n),
      status,
      onlyLeft: status === 'low' ? n : null,
      changedAt: new Date(Date.parse(NOW) - hours * 3_600_000).toISOString(),
      productName: `Item ${n}`,
      variantLabel: null,
    });
    const data: SellerDashboardData = {
      ...full,
      lowStock: ok({
        items: [item(1, 'low', 1), item(2, 'out', 5), item(3, 'low', 2), item(4, 'out', 9)],
        nextCursor: null,
      }),
    };
    render(
      wrap(
        <SellerDashboard today="2026-11-23" title="Dashboard" data={data} permissionKeys={KEYS} />,
      ),
    );
    const card = within(screen.getByRole('region', { name: 'Stock watch' }));
    const names = card.getAllByRole('link').map((a) => a.textContent);
    expect(names).toEqual(['View all', 'Item 2', 'Item 4', 'Item 1', 'Item 3']);
    expect(card.getByRole('link', { name: 'View all' }).getAttribute('href')).toBe('/offers');
  });

  it('has no View all link without the key of the offers list', () => {
    render(
      wrap(
        <SellerDashboard
          today="2026-11-23"
          title="Dashboard"
          data={full}
          permissionKeys={['inventory.stock.view']}
        />,
      ),
    );
    const card = within(screen.getByRole('region', { name: 'Stock watch' }));
    expect(card.queryByRole('link', { name: 'View all' })).toBeNull();
  });

  it('shows an order to ship as a routine status, not an attention (amber) one', () => {
    render(
      wrap(
        <SellerDashboard today="2026-11-23" title="Dashboard" data={full} permissionKeys={KEYS} />,
      ),
    );
    const orders = within(screen.getByRole('region', { name: 'Recent orders' }));
    const badge = orders.getAllByText('To ship')[0]!;
    expect(badge.className).not.toMatch(/attention/);
  });

  it('formats units in the Market locale', () => {
    render(
      wrap(
        <SellerDashboard today="2026-11-23" title="Dashboard" data={full} permissionKeys={KEYS} />,
        'de-DE',
      ),
    );
    const card = within(screen.getByRole('region', { name: 'Stock watch' }));
    expect(card.getByRole('link', { name: /Lamb mince/ }).closest('li')?.textContent).toContain(
      '1.200 left',
    );
  });

  it('says nothing is low or out of stock when the list is empty', () => {
    const data: SellerDashboardData = { ...none, lowStock: ok({ items: [], nextCursor: null }) };
    render(
      wrap(
        <SellerDashboard today="2026-11-23" title="Dashboard" data={data} permissionKeys={[]} />,
      ),
    );
    expect(screen.getByText('Nothing is low or out of stock.')).toBeTruthy();
  });

  it('fails the low-stock card in place while the others render', () => {
    render(
      wrap(
        <SellerDashboard
          today="2026-11-23"
          title="Dashboard"
          data={{ ...full, lowStock: { kind: 'error' } }}
          permissionKeys={KEYS}
        />,
      ),
    );
    const card = within(screen.getByRole('region', { name: 'Stock watch' }));
    expect(card.getByText(/This could not be loaded/)).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Recent orders' })).toBeTruthy();
  });

  it('hides the low-stock card when the session lacks the key or the API refuses', () => {
    render(
      wrap(
        <SellerDashboard
          today="2026-11-23"
          title="Dashboard"
          data={{ ...full, lowStock: null }}
          permissionKeys={KEYS}
        />,
      ),
    );
    expect(screen.queryByRole('region', { name: 'Stock watch' })).toBeNull();
  });

  it('shows a staff member only the widgets and actions their keys allow', () => {
    const staff: SellerDashboardData = { ...none, orders: full.orders };
    render(
      wrap(
        <SellerDashboard
          today="2026-11-23"
          title="Dashboard"
          data={staff}
          permissionKeys={['ordering.seller-order.view', 'inventory.stock.view']}
        />,
      ),
    );
    expect(screen.getByRole('region', { name: 'Recent orders' })).toBeTruthy();
    const actions = within(screen.getByRole('region', { name: 'Quick actions' }));
    expect(actions.getAllByRole('link').map((a) => a.textContent)).toEqual(['Stock locations']);
  });

  it('needs both keys of the page a quick action opens', () => {
    render(
      wrap(
        <SellerDashboard
          today="2026-11-23"
          title="Dashboard"
          data={none}
          permissionKeys={['identity.team-member.invite']}
        />,
      ),
    );
    expect(screen.queryByRole('link', { name: 'Invite a team member' })).toBeNull();
    expect(screen.getByText('Nothing to show here yet')).toBeTruthy();
  });
});

const session = (permissionKeys: string[]): SellerSession => ({
  accountId: 'a',
  sellerId: ID(1),
  permissionKeys,
  sellerAccessState: 'approved',
  email: 'sam@example.test',
  secondFactorActive: true,
  lastSignInAt: null,
  timezone: null,
  locale: null,
  displayName: 'Sam',
  csrfToken: 'c',
});

describe('seller dashboard while it streams', () => {
  it('says there is nothing to show when every read is refused after the skeletons', async () => {
    await act(async () => {
      render(
        wrap(
          <SellerDashboard
            today="2026-11-23"
            title="Dashboard"
            data={{
              tasks: null,
              orders: Promise.resolve(null),
              payout: null,
              sources: null,
              lowStock: null,
            }}
            permissionKeys={['ordering.seller-order.view']}
          />,
        ),
      );
      await Promise.resolve();
    });
    expect(await screen.findByText('Nothing to show here yet')).toBeTruthy();
    expect(document.querySelector('[data-skeleton]')).toBeNull();
  });
});

describe("today's tasks while they are read", () => {
  it('shows the card skeleton under its own title', () => {
    render(
      wrap(
        <SellerDashboard
          today="2026-11-23"
          title="Dashboard"
          data={{ ...none, tasks: new Promise<never>(() => undefined) }}
          permissionKeys={['reviews.seller.view']}
        />,
      ),
    );
    const card = screen.getByRole('region', { name: "Today's tasks" });
    expect(card.querySelector('[data-skeleton="chart-card"]')).toBeTruthy();
  });
});

describe('startSellerDashboard', () => {
  beforeEach(() => {
    mocks.get.mockReset();
    mocks.redirect.mockClear();
  });

  it('asks for nothing the session has no key for', async () => {
    const data = await loadSellerDashboard(session([]));
    expect(mocks.get).not.toHaveBeenCalled();
    expect(Object.values(data).every((widget) => widget === null)).toBe(true);
  });

  it('reads each widget once, in one parallel round, with no per-row calls', async () => {
    mocks.get.mockResolvedValue({ kind: 'ok', body: {} });
    await loadSellerDashboard(session(KEYS));
    expect(mocks.get.mock.calls.map((call) => call[0] as string).sort()).toEqual([
      'dashboard/seller/tasks',
      'inventory/seller/low-stock?limit=50',
      'inventory/seller/sources',
      'ordering/seller/orders?limit=5',
      'payments/seller/payout-account',
    ]);
  });

  it('reads the tasks only with a key of one task, and drops an answer with none it knows', async () => {
    mocks.get.mockImplementation((path: string) =>
      Promise.resolve({
        kind: 'ok',
        body:
          path === 'dashboard/seller/tasks'
            ? {
                panel: 'seller',
                generatedAt: NOW,
                queues: [
                  { key: 'future.task', level: 'today', status: 'ok', count: 1, overdue: 0 },
                ],
              }
            : {},
      }),
    );
    const only = await loadSellerDashboard(session(['identity.team-member.view']));
    expect(only.tasks).toBeNull();
    expect(mocks.get).not.toHaveBeenCalled();
    const unknown = await loadSellerDashboard(session(['reviews.seller.view']));
    expect(mocks.get).toHaveBeenCalledWith('dashboard/seller/tasks');
    expect(unknown.tasks).toBeNull();
  });

  it('hides the tasks when the API refuses them, and sends a rejected session to sign in', async () => {
    mocks.get.mockResolvedValue({ kind: 'forbidden' });
    const refused = await loadSellerDashboard(session(['reviews.seller.view']));
    expect(refused.tasks).toBeNull();
    mocks.get.mockResolvedValue({ kind: 'signed-out' });
    const sources = startSellerDashboard(session(['reviews.seller.view']));
    await expect(sources.tasks).rejects.toThrow('redirect:/session-ended');
  });

  it('keeps the tasks card when every known task is empty', async () => {
    const empty = {
      panel: 'seller',
      generatedAt: NOW,
      queues: [{ key: 'reviews.unanswered', level: 'review', status: 'ok', count: 0, overdue: 0 }],
    };
    mocks.get.mockResolvedValue({ kind: 'ok', body: empty });
    const data = await loadSellerDashboard(session(['reviews.seller.view']));
    expect(data.tasks).toEqual({ kind: 'ok', value: empty });
  });

  it('keeps going when one read fails', async () => {
    mocks.get.mockImplementation((path: string) =>
      Promise.resolve(
        path.startsWith('ordering') ? { kind: 'unavailable' } : { kind: 'ok', body: {} },
      ),
    );
    const data = await loadSellerDashboard(session(KEYS));
    expect(data.orders).toEqual({ kind: 'error' });
    expect(data.lowStock?.kind).toBe('ok');
  });

  it('hides a widget the API refuses instead of showing an error', async () => {
    mocks.get.mockImplementation((path: string) =>
      Promise.resolve(
        path.startsWith('inventory/seller/low-stock')
          ? { kind: 'forbidden' }
          : { kind: 'ok', body: {} },
      ),
    );
    const data = await loadSellerDashboard(session(KEYS));
    expect(data.lowStock).toBeNull();
    expect(data.orders?.kind).toBe('ok');
  });

  it('sends a rejected session to the session-ended page', async () => {
    mocks.get.mockResolvedValue({ kind: 'signed-out' });
    await expect(loadSellerDashboard(session(KEYS))).rejects.toThrow('redirect:/session-ended');
  });
});
