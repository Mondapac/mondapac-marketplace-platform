// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';
import type { AdminSession } from '../server/session.ts';
import type { SellerListPage } from '../sellers/types.ts';
import { AdminDashboard } from './dashboard.tsx';
import type { AdminDashboardData, Widget } from './types.ts';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  redirect: vi.fn((to: string) => {
    throw new Error(`redirect:${to}`);
  }),
}));
vi.mock('../server/server-fetch.ts', () => ({ serverGet: mocks.get }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));

import { loadAdminDashboard } from './load.ts';

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
  stateCounts: { changesNeeded: 1, notApproved: 0, approved: 9, suspended: 1 },
};
const full: AdminDashboardData = {
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
  'identity.customer-account.view',
];

afterEach(cleanup);

describe('admin dashboard', () => {
  it('shows the figures with their scope, and 50+ when the queue is longer than the page', () => {
    render(wrap(<AdminDashboard data={full} permissionKeys={ALL_KEYS} />));
    const stats = within(screen.getByRole('list', { name: 'Needs attention' }));
    const sellersCard = stats.getByRole('link', { name: /Sellers awaiting review/ });
    expect(sellersCard.getAttribute('href')).toBe('/sellers');
    expect(sellersCard.textContent).toContain('9');
    const holdsCard = stats.getByRole('link', { name: /Held prices to decide/ });
    expect(holdsCard.textContent).toContain('50+');
    expect(holdsCard.textContent).toContain('First 50 only; more are waiting');
    expect(stats.getByRole('link', { name: /Offers to review/ }).textContent).toContain(
      'The whole queue',
    );
    expect(
      stats.getByRole('link', { name: /Payout accounts needing action/ }).textContent,
    ).toContain('All restricted accounts');
  });

  it('lists the latest rows with links to their details, money in the Market locale', () => {
    render(wrap(<AdminDashboard data={full} permissionKeys={ALL_KEYS} />));
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
  });

  it('formats money and counts with the locale of the Market, not a fixed one', () => {
    render(wrap(<AdminDashboard data={full} permissionKeys={ALL_KEYS} />, 'de-DE'));
    expect(screen.getAllByText(/45,90/).length).toBeGreaterThan(0);
  });

  it('draws the seller states chart with a text alternative', () => {
    render(wrap(<AdminDashboard data={full} permissionKeys={ALL_KEYS} />));
    const card = within(screen.getByRole('region', { name: 'Sellers by access state' }));
    expect(card.getByText('Approved').closest('li')?.textContent).toBe('Approved9');
    expect(card.getByText('Suspended')).toBeTruthy();
  });

  it('leaves out the chart when identity state is hidden', () => {
    const hidden = { ...full, sellers: ok({ ...sellers, stateCounts: null }) };
    render(wrap(<AdminDashboard data={hidden} permissionKeys={ALL_KEYS} />));
    expect(screen.queryByRole('region', { name: 'Sellers by access state' })).toBeNull();
  });

  it('says a queue is empty instead of showing an empty table', () => {
    const empty: AdminDashboardData = {
      ...none,
      holds: ok({ items: [], next: null }),
      offers: ok({ items: [], nextAfterId: null }),
    };
    render(wrap(<AdminDashboard data={empty} permissionKeys={[]} />));
    expect(screen.getByText('No held prices are waiting for a decision.')).toBeTruthy();
    expect(screen.getByText('No offers are waiting for their first publication.')).toBeTruthy();
    expect(screen.queryAllByRole('table')).toHaveLength(0);
    expect(screen.getByRole('link', { name: /Held prices to decide/ }).textContent).toContain('0');
  });

  it('fails one widget in place and still renders the others', () => {
    const partly: AdminDashboardData = {
      ...full,
      holds: { kind: 'error' },
      orders: { kind: 'error' },
    };
    render(wrap(<AdminDashboard data={partly} permissionKeys={ALL_KEYS} />));
    const failed = 'This could not be loaded. Reload the page to try again.';
    expect(screen.getAllByText(failed).length).toBe(3); // the held-prices figure and card, the orders card
    expect(screen.getByRole('link', { name: /Sellers awaiting review/ })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Olive Grove Bakehouse' })).toBeTruthy();
    // A failed figure is not a link to a list it could not count.
    expect(screen.queryByRole('link', { name: /Held prices to decide/ })).toBeNull();
  });

  it('shows only the widgets of the data it gets, and the quick actions the keys allow', () => {
    const small: AdminDashboardData = { ...none, orders: full.orders };
    render(
      wrap(
        <AdminDashboard
          data={small}
          permissionKeys={['ordering.order.view', 'identity.customer-account.view']}
        />,
      ),
    );
    expect(screen.queryByRole('list', { name: 'Needs attention' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Recent orders' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Held prices' })).toBeNull();
    const actions = within(screen.getByRole('region', { name: 'Quick actions' }));
    expect(actions.getAllByRole('link').map((a) => a.textContent)).toEqual(['Find a customer']);
  });

  it('needs both keys of the page a quick action opens', () => {
    render(wrap(<AdminDashboard data={none} permissionKeys={['identity.admin-account.invite']} />));
    expect(screen.queryByRole('link', { name: 'Invite an admin' })).toBeNull();
    expect(screen.getByText('Nothing to show here yet')).toBeTruthy();
  });

  it('says there is nothing to show for a role with no dashboard widget', () => {
    render(
      wrap(<AdminDashboard data={none} permissionKeys={['notifications.support-contact.view']} />),
    );
    expect(screen.getByText('Nothing to show here yet')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Quick actions' })).toBeNull();
  });
});

const session = (permissionKeys: string[]): AdminSession => ({
  accountId: 'a',
  roleId: 'r',
  permissionKeys,
  secondFactorActive: true,
  lastSignInAt: null,
  timezone: null,
  locale: null,
  email: 'ada@example.test',
  displayName: 'Ada',
  csrfToken: 'csrf-1',
});

describe('loadAdminDashboard', () => {
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
      'ordering/admin/orders?limit=5',
      'payments/admin/connected-accounts?status=restricted',
      'pricing/admin/price-holds?limit=50',
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

  it('sends a rejected session to the session-ended page', async () => {
    mocks.get.mockResolvedValue({ kind: 'signed-out' });
    await expect(loadAdminDashboard(session(ALL_KEYS))).rejects.toThrow('redirect:/session-ended');
  });
});
