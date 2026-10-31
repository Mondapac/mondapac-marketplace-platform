// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';
import type { OfferView } from '../catalog/types.ts';
import type { SellerOrderView } from '../orders/types.ts';
import type { SellerSession } from '../server/session.ts';
import { SellerDashboard } from './dashboard.tsx';
import type { SellerDashboardData, Widget } from './types.ts';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  redirect: vi.fn((to: string) => {
    throw new Error(`redirect:${to}`);
  }),
}));
vi.mock('../server/server-fetch.ts', () => ({ serverGet: mocks.get }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));

import { loadSellerDashboard } from './load.ts';

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
const offer = (n: number, status: string): OfferView => ({
  offerId: ID(n),
  productId: ID(900 + n),
  product: { productCode: `P${n}`, typeCode: 'food', name: `Product ${n}` },
  sellerSku: `SKU-${n}`,
  conditionCode: 'new',
  description: {},
  status,
  listed: status === 'published',
  offSaleCauses: [],
  handling: null,
  attestationRecorded: true,
  submittedAt: '2026-10-12T01:00:00.000Z',
  firstPublishedAt: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  version: 1,
});

const full: SellerDashboardData = {
  orders: ok({
    sellerOrders: [order(1, 'to-ship'), order(2, 'to-ship'), order(3, 'shipped')],
    nextCursor: null,
  }),
  offers: ok({
    items: [
      offer(10, 'published'),
      offer(11, 'pending-first-publish'),
      offer(12, 'changes-needed'),
      offer(13, 'draft'),
    ],
    nextAfterId: null,
  }),
  ledger: ok({
    sellerId: ID(1),
    currency: 'AUD',
    totals: {
      sales: '100000',
      shipping: '5000',
      commission: '10000',
      refundedSales: '0',
      refundedShipping: '0',
      refundedCommission: '0',
      disputeDebits: '0',
      disputeReinstated: '0',
      balance: '123450',
    },
    entries: [
      {
        entryId: ID(70),
        orderId: ID(1),
        kind: 'sale',
        direction: 'credit',
        amount: '4000',
        occurredAt: '2026-10-14T01:00:00.000Z',
      },
      {
        entryId: ID(71),
        orderId: ID(1),
        kind: 'commission',
        direction: 'debit',
        amount: '400',
        occurredAt: '2026-10-14T01:00:00.000Z',
      },
    ],
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
  orders: null,
  offers: null,
  ledger: null,
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
  it('counts what needs attention and says what each figure covers', () => {
    render(wrap(<SellerDashboard data={full} permissionKeys={KEYS} />));
    const stats = within(screen.getByRole('list', { name: 'Needs attention' }));
    const toShip = stats.getByRole('link', { name: /Orders to ship/ });
    expect(toShip.getAttribute('href')).toBe('/orders');
    expect(toShip.textContent).toContain('2');
    expect(toShip.textContent).toContain('All your paid orders');
    expect(stats.getByRole('link', { name: /Offers waiting for review/ }).textContent).toContain(
      '1',
    );
    expect(stats.getByRole('link', { name: /Offers needing changes/ }).textContent).toContain('1');
    // The balance is the backend's number, formatted in the Market locale and currency.
    expect(stats.getByRole('link', { name: /Your balance/ }).textContent).toContain('$1,234.50');
  });

  it('shows 50+ and its scope, never an exact count, when more pages exist', () => {
    const more: SellerDashboardData = {
      ...full,
      orders: ok({
        sellerOrders: Array.from({ length: 50 }, (_, i) => order(i + 1, 'to-ship')),
        nextCursor: ID(999),
      }),
    };
    render(wrap(<SellerDashboard data={more} permissionKeys={KEYS} />));
    const card = screen.getByRole('link', { name: /Orders to ship/ });
    expect(card.textContent).toContain('50+');
    expect(card.textContent).toContain('Among your latest 50 paid orders');
  });

  it('formats money with the Market locale, not a fixed one', () => {
    render(wrap(<SellerDashboard data={full} permissionKeys={KEYS} />, 'de-DE'));
    expect(screen.getByRole('link', { name: /Your balance/ }).textContent).toMatch(/1\.234,50/);
  });

  it('links recent orders and waiting offers to their pages', () => {
    render(wrap(<SellerDashboard data={full} permissionKeys={KEYS} />));
    expect(
      screen.getByRole('link', { name: ID(1).slice(-8).toUpperCase() }).getAttribute('href'),
    ).toBe(`/orders/${ID(1)}`);
    const offers = within(screen.getByRole('region', { name: /Offers waiting on you/ }));
    expect(offers.getByRole('link', { name: 'Product 12' }).getAttribute('href')).toBe(
      `/offers/${ID(12)}`,
    );
    expect(offers.queryByText('Product 10')).toBeNull();
  });

  it('draws the offers-by-status chart with every part as text', () => {
    render(wrap(<SellerDashboard data={full} permissionKeys={KEYS} />));
    const card = within(screen.getByRole('region', { name: 'Offers by status' }));
    expect(card.getByText('Published').closest('li')?.textContent).toBe('Published1');
    expect(card.getByText('Draft').closest('li')?.textContent).toBe('Draft1');
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
    render(wrap(<SellerDashboard data={data} permissionKeys={KEYS} />));
    expect(screen.getByRole('link', { name: 'Set up payouts' }).getAttribute('href')).toBe(
      '/settings/payout-account',
    );
    expect(screen.getByRole('link', { name: 'Add a location' }).getAttribute('href')).toBe(
      '/settings/stock-locations',
    );
  });

  it('shows no banner when payout and stock are in order', () => {
    render(wrap(<SellerDashboard data={full} permissionKeys={KEYS} />));
    expect(screen.queryByRole('link', { name: 'Set up payouts' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Add a location' })).toBeNull();
  });

  it('fails one widget in place and renders the rest', () => {
    const partly: SellerDashboardData = {
      ...full,
      orders: { kind: 'error' },
      ledger: { kind: 'error' },
    };
    render(wrap(<SellerDashboard data={partly} permissionKeys={KEYS} />));
    expect(screen.getAllByText(/This could not be loaded/).length).toBe(4);
    expect(screen.queryByRole('link', { name: /Orders to ship/ })).toBeNull();
    expect(screen.getByRole('link', { name: /Offers needing changes/ })).toBeTruthy();
  });

  it('says a list is empty instead of showing an empty table', () => {
    const empty: SellerDashboardData = {
      ...none,
      orders: ok({ sellerOrders: [], nextCursor: null }),
      offers: ok({ items: [], nextAfterId: null }),
    };
    render(wrap(<SellerDashboard data={empty} permissionKeys={[]} />));
    expect(screen.getByText('No paid orders yet.')).toBeTruthy();
    expect(screen.getByText('No offers are waiting for review or changes.')).toBeTruthy();
    expect(screen.queryAllByRole('table')).toHaveLength(0);
  });

  it('lists low and out-of-stock items, each linking to its stock page', () => {
    render(wrap(<SellerDashboard data={full} permissionKeys={KEYS} />));
    const card = within(screen.getByRole('region', { name: 'Low stock' }));
    const lamb = card.getByRole('link', { name: 'Lamb mince · 500 g' });
    expect(lamb.getAttribute('href')).toBe(`/offers/${ID(20)}/stock`);
    const row = lamb.closest('tr') ?? lamb.closest('li') ?? lamb.parentElement;
    expect(row?.textContent).toContain('Low');
    expect(row?.textContent).toContain('1,200');
    // A missing name falls back; an out-of-stock unit shows no count.
    const unnamed = card.getByRole('link', { name: 'Unnamed product' });
    expect(unnamed.getAttribute('href')).toBe(`/offers/${ID(22)}/stock`);
    expect(unnamed.closest('tr')?.textContent).toContain('None left');
    expect(screen.queryByRole('link', { name: /Low stock/ })).toBeNull();
  });

  it('formats units in the Market locale', () => {
    render(wrap(<SellerDashboard data={full} permissionKeys={KEYS} />, 'de-DE'));
    const card = within(screen.getByRole('region', { name: 'Low stock' }));
    expect(card.getByRole('link', { name: /Lamb mince/ }).closest('tr')?.textContent).toContain(
      '1.200',
    );
  });

  it('says nothing is low or out of stock when the list is empty', () => {
    const data: SellerDashboardData = { ...none, lowStock: ok({ items: [], nextCursor: null }) };
    render(wrap(<SellerDashboard data={data} permissionKeys={[]} />));
    expect(screen.getByText('Nothing is low or out of stock.')).toBeTruthy();
  });

  it('fails the low-stock card in place while the others render', () => {
    render(
      wrap(
        <SellerDashboard data={{ ...full, lowStock: { kind: 'error' } }} permissionKeys={KEYS} />,
      ),
    );
    const card = within(screen.getByRole('region', { name: 'Low stock' }));
    expect(card.getByText(/This could not be loaded/)).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Recent orders' })).toBeTruthy();
  });

  it('hides the low-stock card when the session lacks the key or the API refuses', () => {
    render(wrap(<SellerDashboard data={{ ...full, lowStock: null }} permissionKeys={KEYS} />));
    expect(screen.queryByRole('region', { name: 'Low stock' })).toBeNull();
  });

  it('shows a staff member only the widgets and actions their keys allow', () => {
    const staff: SellerDashboardData = { ...none, orders: full.orders };
    render(
      wrap(
        <SellerDashboard
          data={staff}
          permissionKeys={['ordering.seller-order.view', 'inventory.stock.view']}
        />,
      ),
    );
    expect(screen.getByRole('region', { name: 'Recent orders' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Latest earnings entries' })).toBeNull();
    expect(screen.queryByRole('link', { name: /Your balance/ })).toBeNull();
    const actions = within(screen.getByRole('region', { name: 'Quick actions' }));
    expect(actions.getAllByRole('link').map((a) => a.textContent)).toEqual(['Stock locations']);
  });

  it('needs both keys of the page a quick action opens', () => {
    render(wrap(<SellerDashboard data={none} permissionKeys={['identity.team-member.invite']} />));
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

describe('loadSellerDashboard', () => {
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
      'catalog/seller/offers?limit=50',
      'commission-payouts/seller/ledger?limit=5',
      'inventory/seller/low-stock?limit=50',
      'inventory/seller/sources',
      'ordering/seller/orders?limit=50',
      'payments/seller/payout-account',
    ]);
  });

  it('keeps going when one read fails', async () => {
    mocks.get.mockImplementation((path: string) =>
      Promise.resolve(
        path.startsWith('ordering') ? { kind: 'unavailable' } : { kind: 'ok', body: {} },
      ),
    );
    const data = await loadSellerDashboard(session(KEYS));
    expect(data.orders).toEqual({ kind: 'error' });
    expect(data.offers?.kind).toBe('ok');
  });

  it('hides a widget the API refuses instead of showing an error', async () => {
    mocks.get.mockImplementation((path: string) =>
      Promise.resolve(
        path.startsWith('commission-payouts') ? { kind: 'forbidden' } : { kind: 'ok', body: {} },
      ),
    );
    const data = await loadSellerDashboard(session(KEYS));
    expect(data.ledger).toBeNull();
    expect(data.orders?.kind).toBe('ok');
  });

  it('sends a rejected session to the session-ended page', async () => {
    mocks.get.mockResolvedValue({ kind: 'signed-out' });
    await expect(loadSellerDashboard(session(KEYS))).rejects.toThrow('redirect:/session-ended');
  });
});
