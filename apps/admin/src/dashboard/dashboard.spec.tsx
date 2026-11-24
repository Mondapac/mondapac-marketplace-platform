// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';
import type { AdminSession } from '../server/session.ts';
import type { SellerListPage } from '../sellers/types.ts';
import { AdminDashboard } from './dashboard.tsx';
import type { WorkQueueAnswer } from '../work-queue/queues.ts';
import type { AdminDashboardData, Widget } from './types.ts';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  redirect: vi.fn((to: string) => {
    throw new Error(`redirect:${to}`);
  }),
}));
vi.mock('../server/server-fetch.ts', () => ({ serverGet: mocks.get }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));

import { startAdminDashboard } from './load.ts';

/** Every read of the dashboard, awaited. */
async function loadAdminDashboard(session: AdminSession): Promise<AdminDashboardData> {
  const sources = startAdminDashboard(session);
  const [workQueue, sellers, holds, offers, accounts, orders] = await Promise.all([
    sources.workQueue,
    sources.sellers,
    sources.holds,
    sources.offers,
    sources.accounts,
    sources.orders,
  ]);
  return { workQueue, sellers, holds, offers, accounts, orders };
}

const wrap = (node: React.ReactNode, locale = 'en-AU') => (
  <NextIntlClientProvider locale={locale} messages={messages}>
    {node}
  </NextIntlClientProvider>
);
const ok = <T,>(value: T): Widget<T> => ({ kind: 'ok', value });
const ID = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;

const sellers: SellerListPage = {
  tab: 'awaiting-review',
  items: [
    {
      sellerId: ID(1),
      storeName: 'Cedar Lane Halal Meats',
      slug: 'cedar-lane',
      status: 'awaiting-review',
      owner: null,
      origin: 'self',
      kind: 'onboarding',
      submittedAt: '2026-10-13T01:00:00.000Z',
      serviceAreaCode: null,
      timezone: null,
      createdAt: '2026-10-01T00:00:00.000Z',
      lastChangedAt: '2026-10-13T01:00:00.000Z',
    },
  ],
  next: null,
  counts: { awaitingReview: { onboarding: 7, identityChange: 2 }, incomplete: 0, all: 20 },
  areas: [],
  stateCounts: { changesNeeded: 1, notApproved: 0, approved: 9, suspended: 1 },
};
const NOW = '2026-10-14T03:00:00.000Z';
const hoursAgo = (h: number) => new Date(Date.parse(NOW) - h * 3_600_000).toISOString();
const workQueue: WorkQueueAnswer = {
  panel: 'admin',
  generatedAt: NOW,
  queues: [
    {
      key: 'catalog.claims-without-certificate',
      level: 'critical',
      status: 'ok',
      count: 2,
      overdue: 2,
      oldestAt: hoursAgo(1),
      countedAt: NOW,
    },
    { key: 'security.open-alerts', level: 'critical', status: 'error' },
    {
      key: 'commission-payouts.disputes-due',
      level: 'critical',
      status: 'ok',
      count: 0,
      overdue: 0,
      oldestAt: null,
      countedAt: NOW,
    },
    {
      key: 'sellers.applications',
      level: 'today',
      status: 'ok',
      count: 17,
      overdue: 5,
      oldestAt: hoursAgo(72),
      countedAt: NOW,
    },
    {
      key: 'pricing.price-holds',
      level: 'today',
      status: 'ok',
      count: 4,
      overdue: 0,
      oldestAt: hoursAgo(9),
      countedAt: NOW,
    },
    {
      key: 'future.queue',
      level: 'today',
      status: 'ok',
      count: 9,
      overdue: 0,
      oldestAt: null,
      countedAt: NOW,
    },
    {
      key: 'catalog.brand-merges',
      level: 'review',
      status: 'ok',
      count: 3,
      overdue: 0,
      oldestAt: hoursAgo(30),
      countedAt: NOW,
    },
  ],
};
const full: AdminDashboardData = {
  workQueue: ok(workQueue),
  sellers: ok(sellers),
  holds: ok({
    items: Array.from({ length: 50 }, (_, i) => ({
      recordId: ID(100 + i),
      offerId: ID(1),
      variantId: ID(2),
      sellerId: ID(3),
      productName: i === 0 ? 'Lamb shoulder' : 'Other',
      variantLabel: '1 kg',
      storeName: 'Cedar Lane Halal Meats',
      kind: 'regular' as const,
      amount: { amount: '12800', currency: 'AUD' },
      anchorAmount: { amount: '5600', currency: 'AUD' },
      direction: 'up' as const,
      submittedAt: '2026-10-12T01:00:00.000Z',
    })),
    next: ID(999),
  }),
  offers: ok({
    items: [
      {
        kind: 'offer-first-publication' as const,
        offerId: ID(7),
        version: 1,
        sellerId: ID(3),
        productId: ID(4),
        product: { productCode: 'P1', typeCode: 'food', name: 'Dates' },
        sellerSku: 'DATES-1',
        conditionCode: 'new',
        description: {},
        handling: null,
        submittedAt: '2026-10-12T01:00:00.000Z',
      },
    ],
    nextAfterId: null,
  }),
  accounts: ok({
    items: [
      {
        sellerId: ID(3),
        sellerName: 'Olive Grove Bakehouse',
        status: 'restricted',
        ready: false,
        requirementsDue: 2,
        requirementsPastDue: true,
        coolingOffUntil: null,
        payoutsPaused: false,
        lastReadAt: null,
        createdAt: '2026-10-01T00:00:00.000Z',
      },
    ],
    nextCursor: null,
  }),
  orders: ok({
    orders: [
      {
        orderId: ID(55),
        status: 'confirmed',
        total: { amount: '4590', currency: 'AUD' },
        createdAt: '2026-10-14T01:00:00.000Z',
      },
    ],
    nextCursor: null,
  }),
};
const none: AdminDashboardData = {
  workQueue: null,
  sellers: null,
  holds: null,
  offers: null,
  accounts: null,
  orders: null,
};
const ALL_KEYS = [
  'sellers.seller.view',
  'pricing.price-hold.view',
  'catalog.product.view',
  'payments.connected-account.view',
  'ordering.order.view',
  'identity.seller-access.view',
  'identity.admin-account.view',
  'identity.admin-account.invite',
  'identity.platform-role.view',
  'identity.platform-role.create',
  'customers.customers.view',
];

afterEach(cleanup);

describe('admin dashboard', () => {
  it('shows the work queue first: critical queues, today queues, folded review queues', () => {
    render(
      wrap(
        <AdminDashboard
          title="Dashboard"
          zone="Australia/Brisbane"
          data={full}
          permissionKeys={ALL_KEYS}
        />,
      ),
    );
    const card = within(screen.getByRole('region', { name: 'Needs action' }));
    // A queue with no list yet is plain text; the status is in words, not only a colour.
    expect(card.getByText('Certified listings without a valid certificate').tagName).toBe('SPAN');
    expect(card.getByText('Incident')).toBeTruthy();
    // A failed queue says so, never 0, and is not a link.
    expect(card.getByText('Security alerts open').closest('li')?.textContent).toContain(
      "Couldn't load",
    );
    const applications = card.getByRole('link', { name: 'Seller applications' });
    expect(applications.getAttribute('href')).toBe('/sellers?tab=awaiting-review');
    expect(applications.closest('li')?.textContent).toContain('17 · 5 overdue');
    expect(applications.closest('li')?.textContent).toContain('Oldest 3d');
    expect(
      card.getByRole('link', { name: 'Held prices to decide' }).closest('li')?.textContent,
    ).toContain('Oldest 9h');
    // One review queue shows as itself; a key the panel does not know is left out.
    expect(card.getByRole('link', { name: 'Brand merge groups' })).toBeTruthy();
    expect(card.queryByText('future.queue')).toBeNull();
    expect(card.getByText('1 queue is all clear')).toBeTruthy();
    const open = card.getByRole('link', { name: 'Open work queue (5)' });
    expect(open.getAttribute('href')).toBe('/work-queue');
  });

  it('says the work queue could not be loaded in its card and still renders the rest', () => {
    render(
      wrap(
        <AdminDashboard
          title="Dashboard"
          zone="Australia/Brisbane"
          data={{ ...full, workQueue: { kind: 'error' } }}
          permissionKeys={ALL_KEYS}
        />,
      ),
    );
    const card = within(screen.getByRole('region', { name: 'Needs action' }));
    expect(card.getByText('This could not be loaded. Reload the page to try again.')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Recent orders' })).toBeTruthy();
  });

  it('lists the latest rows with links to their details, money in the Market locale', () => {
    render(
      wrap(
        <AdminDashboard
          title="Dashboard"
          zone="Australia/Brisbane"
          data={full}
          permissionKeys={ALL_KEYS}
        />,
      ),
    );
    expect(screen.getByRole('link', { name: 'Cedar Lane Halal Meats' }).getAttribute('href')).toBe(
      `/sellers/${ID(1)}`,
    );
    expect(screen.getByRole('link', { name: 'Olive Grove Bakehouse' }).getAttribute('href')).toBe(
      `/payout-accounts/${ID(3)}`,
    );
    const order = screen.getByRole('link', { name: '00000055'.toUpperCase() });
    expect(order.getAttribute('href')).toBe(`/orders/${ID(55)}`);
    expect(screen.getAllByText('$45.90').length).toBeGreaterThan(0);
    // The held-price table lists five rows, not the 50 counted.
    const holds = within(screen.getByRole('region', { name: 'Held prices' }));
    expect(holds.getAllByRole('row')).toHaveLength(1 + 5);
    // Column headers come from the held-prices list messages, not raw keys.
    for (const name of ['Product', 'Held price', 'Submitted']) {
      expect(holds.getByRole('columnheader', { name })).toBeTruthy();
    }
    expect(holds.getAllByText(/^Increase/).length).toBeGreaterThan(0);
  });

  it('formats money and counts with the locale of the Market, not a fixed one', () => {
    render(
      wrap(
        <AdminDashboard
          title="Dashboard"
          zone="Australia/Brisbane"
          data={full}
          permissionKeys={ALL_KEYS}
        />,
        'de-DE',
      ),
    );
    expect(screen.getAllByText(/45,90/).length).toBeGreaterThan(0);
  });

  it('draws the seller states chart with a text alternative', () => {
    render(
      wrap(
        <AdminDashboard
          title="Dashboard"
          zone="Australia/Brisbane"
          data={full}
          permissionKeys={ALL_KEYS}
        />,
      ),
    );
    const card = within(screen.getByRole('region', { name: 'Sellers by access state' }));
    expect(card.getByText('Approved').closest('li')?.textContent).toBe('Approved9');
    expect(card.getByText('Suspended')).toBeTruthy();
  });

  it('leaves out the chart when identity state is hidden', () => {
    const hidden = { ...full, sellers: ok({ ...sellers, stateCounts: null }) };
    render(
      wrap(
        <AdminDashboard
          title="Dashboard"
          zone="Australia/Brisbane"
          data={hidden}
          permissionKeys={ALL_KEYS}
        />,
      ),
    );
    expect(screen.queryByRole('region', { name: 'Sellers by access state' })).toBeNull();
  });

  it('says a queue is empty instead of showing an empty table', () => {
    const empty: AdminDashboardData = {
      ...none,
      holds: ok({ items: [], next: null }),
      offers: ok({ items: [], nextAfterId: null }),
    };
    render(
      wrap(
        <AdminDashboard
          title="Dashboard"
          zone="Australia/Brisbane"
          data={empty}
          permissionKeys={[]}
        />,
      ),
    );
    expect(screen.getByText('No held prices are waiting for a decision.')).toBeTruthy();
    expect(screen.getByText('No offers are waiting for their first publication.')).toBeTruthy();
    expect(screen.queryAllByRole('table')).toHaveLength(0);
  });

  it('lists only Offers, not the product revisions in the same queue', () => {
    const mixed: AdminDashboardData = {
      ...none,
      offers: ok({ items: [{ kind: 'product-revision' as const }], nextAfterId: null }),
    };
    render(
      wrap(
        <AdminDashboard
          title="Dashboard"
          zone="Australia/Brisbane"
          data={mixed}
          permissionKeys={[]}
        />,
      ),
    );
    expect(screen.getByText('No offers are waiting for their first publication.')).toBeTruthy();
    expect(screen.queryAllByRole('table')).toHaveLength(0);
  });

  it('fails one widget in place and still renders the others', () => {
    const partly: AdminDashboardData = {
      ...full,
      holds: { kind: 'error' },
      orders: { kind: 'error' },
    };
    render(
      wrap(
        <AdminDashboard
          title="Dashboard"
          zone="Australia/Brisbane"
          data={partly}
          permissionKeys={ALL_KEYS}
        />,
      ),
    );
    const failed = 'This could not be loaded. Reload the page to try again.';
    expect(screen.getAllByText(failed).length).toBe(2); // the held-prices card, the orders card
    expect(screen.getByRole('link', { name: 'Seller applications' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Olive Grove Bakehouse' })).toBeTruthy();
  });

  it('shows only the widgets of the data it gets, and the quick actions the keys allow', () => {
    const small: AdminDashboardData = { ...none, orders: full.orders };
    render(
      wrap(
        <AdminDashboard
          title="Dashboard"
          zone="Australia/Brisbane"
          data={small}
          permissionKeys={['ordering.order.view', 'customers.customers.view']}
        />,
      ),
    );
    expect(screen.queryByRole('region', { name: 'Needs action' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Recent orders' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Held prices' })).toBeNull();
    const actions = within(screen.getByRole('region', { name: 'Quick actions' }));
    expect(actions.getAllByRole('link').map((a) => a.textContent)).toEqual(['Find a customer']);
  });

  it('needs both keys of the page a quick action opens', () => {
    render(
      wrap(
        <AdminDashboard
          title="Dashboard"
          zone="Australia/Brisbane"
          data={none}
          permissionKeys={['identity.admin-account.invite']}
        />,
      ),
    );
    expect(screen.queryByRole('link', { name: 'Invite an admin' })).toBeNull();
    expect(screen.getByText('Nothing to show here yet')).toBeTruthy();
  });

  it('says there is nothing to show for a role with no dashboard widget', () => {
    render(
      wrap(
        <AdminDashboard
          title="Dashboard"
          zone="Australia/Brisbane"
          data={none}
          permissionKeys={['notifications.support-contact.view']}
        />,
      ),
    );
    expect(screen.getByText('Nothing to show here yet')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Quick actions' })).toBeNull();
  });

  it('streams each card on its own: a slow read shows its skeleton while the others render', async () => {
    let answerQueue!: (value: AdminDashboardData['workQueue']) => void;
    const queueRead = new Promise<AdminDashboardData['workQueue']>((resolve) => {
      answerQueue = resolve;
    });
    let answer!: (value: AdminDashboardData['sellers']) => void;
    const sellersRead = new Promise<AdminDashboardData['sellers']>((resolve) => {
      answer = resolve;
    });
    await act(async () => {
      render(
        wrap(
          <AdminDashboard
            title="Dashboard"
            zone="Australia/Brisbane"
            data={{
              ...full,
              workQueue: queueRead,
              sellers: sellersRead,
              orders: Promise.resolve(full.orders),
            }}
            permissionKeys={ALL_KEYS}
          />,
        ),
      );
      await Promise.resolve();
    });
    // The other reads have answered.
    expect(screen.getByRole('region', { name: 'Held prices' })).toBeTruthy();
    expect(await screen.findByRole('table', { name: 'Recent orders' })).toBeTruthy();
    // The work queue and sellers reads have not: their cards are skeletons with their real titles.
    const queue = screen.getByRole('region', { name: 'Needs action' });
    expect(queue.querySelector('[data-skeleton="chart-card"]')).not.toBeNull();
    const applications = screen.getByRole('region', { name: 'Seller applications' });
    expect(applications.querySelector('[data-skeleton="activity"]')).not.toBeNull();
    expect(screen.getByRole('status').textContent).toBe('Loading the dashboard');
    await act(async () => {
      answerQueue(full.workQueue);
      answer(full.sellers);
      await Promise.resolve();
    });
    expect(await screen.findByRole('link', { name: 'Seller applications' })).toBeTruthy();
    expect(document.querySelector('[data-skeleton]')).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('');
  });

  it('drops the work queue when the API shows no queue the panel knows', async () => {
    await act(async () => {
      render(
        wrap(
          <AdminDashboard
            title="Dashboard"
            zone="Australia/Brisbane"
            data={{ ...full, workQueue: Promise.resolve(null) }}
            permissionKeys={ALL_KEYS}
          />,
        ),
      );
      await Promise.resolve();
    });
    expect(screen.queryByRole('region', { name: 'Needs action' })).toBeNull();
  });

  it('says there is nothing to show when every read is refused after the skeletons', async () => {
    await act(async () => {
      render(
        wrap(
          <AdminDashboard
            title="Dashboard"
            zone="Australia/Brisbane"
            data={{
              workQueue: null,
              sellers: Promise.resolve(null),
              holds: Promise.resolve(null),
              offers: null,
              accounts: null,
              orders: Promise.resolve(null),
            }}
            permissionKeys={[
              'sellers.seller.view',
              'pricing.price-hold.view',
              'ordering.order.view',
            ]}
          />,
        ),
      );
      await Promise.resolve();
    });
    expect(await screen.findByText('Nothing to show here yet')).toBeTruthy();
    expect(document.querySelector('[data-skeleton]')).toBeNull();
  });

  it('drops a card whose read the API refuses after its skeleton showed', async () => {
    await act(async () => {
      render(
        wrap(
          <AdminDashboard
            title="Dashboard"
            zone="Australia/Brisbane"
            data={{ ...full, holds: Promise.resolve(null) }}
            permissionKeys={ALL_KEYS}
          />,
        ),
      );
      await Promise.resolve();
    });
    expect(screen.queryByRole('region', { name: 'Held prices' })).toBeNull();
  });
});

const session = (permissionKeys: string[]): AdminSession => ({
  accountId: 'a',
  roleId: 'r',
  permissionKeys,
  secondFactorActive: true,
  lastSignInAt: null,
  timezone: null,
  marketTimezone: 'UTC',
  locale: null,
  email: 'ada@example.test',
  displayName: 'Ada',
  csrfToken: 'csrf-1',
});

describe('startAdminDashboard', () => {
  beforeEach(() => {
    mocks.get.mockReset();
    mocks.redirect.mockClear();
  });

  it('asks for nothing the session has no key for', async () => {
    const data = await loadAdminDashboard(session([]));
    expect(mocks.get).not.toHaveBeenCalled();
    expect(Object.values(data).every((widget) => widget === null)).toBe(true);
  });

  it('reads each widget once with the key it needs, the seller list as a CSRF-protected read', async () => {
    mocks.get.mockResolvedValue({ kind: 'ok', body: {} });
    await loadAdminDashboard(session(ALL_KEYS));
    const paths = mocks.get.mock.calls.map((call) => call[0] as string).sort();
    expect(paths).toEqual([
      'catalog/admin/review-queue?limit=50',
      'dashboard/admin/work-queue',
      'ordering/admin/orders?limit=5',
      'payments/admin/connected-accounts?status=restricted',
      'pricing/admin/price-holds?limit=5',
      'sellers/admin/list',
    ]);
    const sellersCall = mocks.get.mock.calls.find((call) => call[0] === 'sellers/admin/list');
    expect(sellersCall?.[1]).toEqual({
      post: { body: { tab: 'awaiting-review', limit: 5 }, csrfToken: 'csrf-1' },
    });
  });

  it('keeps going when one read fails, and hides a widget the API refuses', async () => {
    mocks.get.mockImplementation((path: string) =>
      Promise.resolve(
        path.startsWith('pricing')
          ? { kind: 'unavailable' }
          : path.startsWith('catalog')
            ? { kind: 'forbidden' }
            : { kind: 'ok', body: {} },
      ),
    );
    const data = await loadAdminDashboard(session(ALL_KEYS));
    expect(data.holds).toEqual({ kind: 'error' });
    expect(data.offers).toBeNull();
    expect(data.sellers?.kind).toBe('ok');
  });

  it('reads the work queue only with a key of one of its queues, and drops an answer with none it knows', async () => {
    mocks.get.mockImplementation((path: string) =>
      Promise.resolve({
        kind: 'ok',
        body:
          path === 'dashboard/admin/work-queue'
            ? {
                panel: 'admin',
                generatedAt: NOW,
                queues: [
                  { key: 'future.queue', level: 'today', status: 'ok', count: 1, overdue: 0 },
                ],
              }
            : {},
      }),
    );
    const only = await loadAdminDashboard(session(['notifications.support-contact.view']));
    expect(only.workQueue).toBeNull();
    expect(mocks.get).not.toHaveBeenCalled();
    const unknown = await loadAdminDashboard(session(['security.centre.view']));
    expect(mocks.get).toHaveBeenCalledWith('dashboard/admin/work-queue');
    expect(unknown.workQueue).toBeNull();
  });

  it('sends a rejected session to the session-ended page', async () => {
    mocks.get.mockResolvedValue({ kind: 'signed-out' });
    await expect(loadAdminDashboard(session(ALL_KEYS))).rejects.toThrow('redirect:/session-ended');
  });
});
