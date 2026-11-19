// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';
import { decodeSetupQr } from '../../test/decode-qr.ts';
import { servePerks } from '../../test/serve-perks.ts';
import { expectToast } from '../../test/toast-spy.ts';
import { sellerNavItems } from '../nav.ts';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

import { callApi } from '../api/client.ts';
import { CustomerDetail } from './customer-detail.tsx';
import { CustomersList, failureOf } from './customers-list.tsx';
import { exportBody, exportFailure } from './customers-export.tsx';
import {
  ExclusivePerks,
  displayStatus,
  exclusiveOf,
  problemOf,
  promotionBody,
  type OwnPromotion,
} from './exclusive-perks.tsx';
import { InviteCustomers, inviteUrl } from './invite-customers.tsx';
import { DEFAULT_QUERY, filterCount, listBody, searchIsValid, selectorOf } from './query.ts';
import type { InviteLinkAnswer, SellerCustomerPage, SellerCustomerRow } from './types.ts';

const call = vi.mocked(callApi);
const wrap = (node: ReactNode, locale = 'en-AU') => (
  <NextIntlClientProvider locale={locale} messages={messages} timeZone="Australia/Brisbane">
    {node}
  </NextIntlClientProvider>
);

const row = (over: Partial<SellerCustomerRow> = {}): SellerCustomerRow => ({
  code: 'AB12-CD34',
  firstName: 'Mina',
  orderCount: 3,
  firstOrderAt: '2026-09-01T00:00:00.000Z',
  lastOrderAt: '2026-11-01T00:00:00.000Z',
  spentMinor: '12550',
  currency: 'AUD',
  follower: true,
  followedAt: '2026-09-02T00:00:00.000Z',
  exclusive: true,
  since: '2026-09-01T00:00:00.000Z',
  ...over,
});
const page = (items: SellerCustomerRow[], total = items.length): SellerCustomerPage => ({
  items,
  counts: { all: total, buyers: 2, followers: 1, referred: 1 },
  paging: { total, page: 1, pageSize: 25, maxRows: 10000 },
  nextCursor: null,
});
const ok = <T,>(body: T) => ({ ok: true as const, status: 200, body });
const fail = (status: number, code: string, details?: object) => ({
  ok: false as const,
  failure: { status, code, ...(details === undefined ? {} : { details }) },
});

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute('open');
  };
  vi.clearAllMocks();
});
afterEach(cleanup);

describe('query', () => {
  it('builds the list body with only what is set, flags as booleans and counts as numbers', () => {
    const body = listBody({
      ...DEFAULT_QUERY,
      view: 'referred',
      q: 'ab1',
      filters: { follower: 'yes', ordersMin: '2', spentMax: '5000', lastOrderFrom: '2026-10-01' },
    });
    expect(body).toMatchObject({
      view: 'referred',
      q: 'ab1',
      filters: { follower: true, ordersMin: 2, spentMax: '5000', lastOrderFrom: '2026-10-01' },
      page: 1,
      pageSize: 25,
    });
    expect(selectorOf(DEFAULT_QUERY)).toEqual({ view: 'all' });
  });

  it('accepts 2 to 8 code symbols, with a dash or spaces, and nothing else', () => {
    expect(searchIsValid('ab')).toBe(true);
    expect(searchIsValid('AB12-CD3')).toBe(true);
    expect(searchIsValid('a')).toBe(false);
    expect(searchIsValid('AB12-CD345')).toBe(false);
    expect(searchIsValid('ab@')).toBe(false);
    expect(filterCount({ ordersMin: '1', ordersMax: '5', follower: 'no' })).toBe(2);
  });

  it('maps a 429 to minutes and a 403 to hidden', () => {
    expect(
      failureOf({ status: 429, code: 'request.throttled', details: { retryAfterSeconds: 90 } }),
    ).toEqual({
      kind: 'throttled',
      minutes: 2,
    });
    expect(failureOf({ status: 403, code: 'access.denied' })).toEqual({ kind: 'denied' });
    expect(failureOf({ status: 400, code: 'validation.failed' })).toEqual({ kind: 'refused' });
    expect(failureOf({ status: 503, code: 'access.unavailable' })).toEqual({ kind: 'unavailable' });
  });
});

describe('CustomersList', () => {
  const mount = (props: Partial<Parameters<typeof CustomersList>[0]> = {}, locale = 'en-AU') =>
    render(wrap(<CustomersList csrfToken="csrf" paging="pages" {...props} />, locale));

  it('shows code and first name only, with text badges, counts on the views and a total', async () => {
    call.mockResolvedValue(
      ok(
        page([
          row(),
          row({
            code: 'ZZ99-ZZ99',
            firstName: null,
            orderCount: 0,
            spentMinor: null,
            currency: null,
            follower: true,
            exclusive: false,
          }),
        ]),
      ),
    );
    mount();
    expect(await screen.findByText('AB12-CD34')).toBeTruthy();
    expect(screen.getByText('Mina')).toBeTruthy();
    expect(screen.getAllByText('Exclusive').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Buyer').length).toBeGreaterThan(0);
    expect(screen.getByText('Referred (1)')).toBeTruthy();
    expect(screen.getByText('$125.50')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/@/);
    const [method, path, body, csrf] = call.mock.calls[0] ?? [];
    expect([method, path, csrf]).toEqual(['POST', 'customers/seller/customers/list', 'csrf']);
    expect(body).toMatchObject({ view: 'all', sort: 'last-order', direction: 'desc', page: 1 });
  });

  it('writes money in the currency the API gives (a second Market: JPY)', async () => {
    call.mockResolvedValue(ok(page([row({ spentMinor: '12550', currency: 'JPY' })])));
    mount({}, 'ja-JP');
    expect(await screen.findByText(/12,550/)).toBeTruthy();
    expect(screen.queryByText('$125.50')).toBeNull();
  });

  it('asks for the Referred view when its tab is chosen', async () => {
    call.mockResolvedValue(ok(page([row()])));
    mount();
    fireEvent.click(await screen.findByText('Referred (1)'));
    await waitFor(() =>
      expect(call.mock.calls.at(-1)?.[2]).toMatchObject({ view: 'referred', page: 1 }),
    );
  });

  it('offers Export only with the export key', async () => {
    call.mockResolvedValue(ok(page([row()])));
    mount();
    await screen.findByText('AB12-CD34');
    expect(screen.queryByRole('button', { name: /Export/ })).toBeNull();
    cleanup();
    mount({ canExport: true });
    await screen.findByText('AB12-CD34');
    expect(screen.getByRole('button', { name: /Export/ })).toBeTruthy();
  });

  it('says there are no customers yet and links to Invite customers with the invite key', async () => {
    call.mockResolvedValue(ok(page([], 0)));
    mount({ canInvite: true });
    expect(await screen.findByText(/People appear here when they buy from you/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Invite customers' }).getAttribute('href')).toBe(
      '/settings/invite-customers',
    );
    cleanup();
    mount();
    await screen.findByText(/People appear here/);
    expect(screen.queryByRole('link', { name: 'Invite customers' })).toBeNull();
  });

  it('hides the page on 403, says when to retry on 429 and offers Try again on a failure', async () => {
    call.mockResolvedValueOnce(fail(403, 'access.denied'));
    mount();
    expect(await screen.findByText('Customers are not available')).toBeTruthy();
    cleanup();
    call.mockResolvedValueOnce(fail(429, 'request.throttled', { retryAfterSeconds: 180 }));
    mount();
    expect(await screen.findByText('Try again in 3 minutes.')).toBeTruthy();
    cleanup();
    call.mockResolvedValueOnce(fail(503, 'access.unavailable'));
    call.mockResolvedValueOnce(ok(page([row()])));
    mount();
    expect(await screen.findByText("Couldn't load customers.")).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'Try again' })[0] as HTMLElement);
    expect(await screen.findByText('AB12-CD34')).toBeTruthy();
  });
});

describe('export', () => {
  it('sends the ticked codes, or the list selector for all matching', () => {
    expect(exportBody('csv', DEFAULT_QUERY, ['AB12-CD34'])).toEqual({
      format: 'csv',
      codes: ['AB12-CD34'],
    });
    expect(exportBody('xlsx', { ...DEFAULT_QUERY, view: 'buyers' }, null)).toEqual({
      format: 'xlsx',
      view: 'buyers',
    });
  });

  it('words a refusal', () => {
    expect(exportFailure(413, 'batch.too-large', { max: 10000, total: 12000 })).toEqual({
      key: 'too-large',
      values: { total: 12000, max: 10000 },
    });
    expect(exportFailure(413, 'batch.too-large', { max: 1000 }).key).toBe('too-many-selected');
    expect(exportFailure(403, 'access.denied', null).key).toBe('denied');
    expect(exportFailure(503, 'x', null).key).toBe('unavailable');
  });
});

describe('CustomerDetail', () => {
  const detail = (orders: boolean) => ({
    customer: row(),
    orders: orders
      ? {
          items: [
            {
              sellerOrderId: '0190a000-0000-7000-8000-0000000000a1',
              orderId: '0190a000-0000-7000-8000-0000000000b1',
              paidAt: '2026-11-01T00:00:00.000Z',
              totalMinor: '4200',
              currency: 'AUD',
              fulfilment: 'shipped' as const,
              deliveredAt: null,
            },
          ],
          total: 1,
          page: 1,
          pageSize: 25,
        }
      : null,
  });

  it("shows the code, first name, the privacy note and this shop's orders with a link", async () => {
    call.mockResolvedValue(ok(detail(true)));
    render(wrap(<CustomerDetail code="AB12-CD34" />));
    expect(await screen.findByRole('heading', { name: 'AB12-CD34' })).toBeTruthy();
    expect(screen.getByText('Mina')).toBeTruthy();
    expect(screen.getByText(/Email and account details are never shown to sellers/)).toBeTruthy();
    expect(screen.getByText('Orders placed with your shop only')).toBeTruthy();
    expect(screen.getByRole('link', { name: /000000A1/ }).getAttribute('href')).toBe(
      '/orders/0190a000-0000-7000-8000-0000000000a1',
    );
    expect(call.mock.calls[0]?.[1]).toBe('customers/seller/customers/AB12-CD34?page=1&pageSize=25');
  });

  it('hides the orders section without the order key (orders is null)', async () => {
    call.mockResolvedValue(ok(detail(false)));
    render(wrap(<CustomerDetail code="AB12-CD34" />));
    await screen.findByRole('heading', { name: 'AB12-CD34' });
    expect(screen.queryByText('Orders with your shop')).toBeNull();
  });

  it('says not found for a code of another shop, with a way back', async () => {
    call.mockResolvedValue(fail(404, 'customers.seller-customer-not-found'));
    render(wrap(<CustomerDetail code="NOPE-NOPE" />));
    expect(await screen.findByText('Customer not found')).toBeTruthy();
    expect(screen.getByRole('link', { name: /Back to Customers/ }).getAttribute('href')).toBe(
      '/customers',
    );
  });

  it('shows the error with Try again', async () => {
    call.mockResolvedValueOnce(fail(503, 'access.unavailable'));
    call.mockResolvedValueOnce(ok(detail(false)));
    render(wrap(<CustomerDetail code="AB12-CD34" />));
    expect(await screen.findByText("Couldn't load this customer.")).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'AB12-CD34' })).toBeTruthy();
  });
});

describe('InviteCustomers', () => {
  const answer = (over: Partial<InviteLinkAnswer> = {}): InviteLinkAnswer => ({
    link: { token: 'tok123ABC', createdAt: '2026-11-01T00:00:00.000Z' },
    signups: { active: 5, rejected: 0 },
    ...over,
  });
  const mount = (origin: string | null = 'https://shop.example') =>
    render(wrap(<InviteCustomers storefrontOrigin={origin} csrfToken="csrf" />));

  it('builds the link from the configured origin and draws a QR that decodes to it', async () => {
    call.mockResolvedValue(ok(answer()));
    mount();
    const field = await screen.findByLabelText<HTMLInputElement>('Invite link');
    expect(field.value).toBe('https://shop.example/invite/tok123ABC');
    expect(field.readOnly).toBe(true);
    const qr = screen.getByRole('img', { name: 'QR code for your invite link' });
    expect(decodeSetupQr(qr)).toBe('https://shop.example/invite/tok123ABC');
    expect(inviteUrl('https://shop.example/', 't')).toBe('https://shop.example/invite/t');
  });

  it('shows the sign-up total, and the hint only when some were not counted', async () => {
    call.mockResolvedValue(ok(answer({ signups: { active: 5, rejected: 2 } })));
    mount();
    expect(await screen.findByText('7')).toBeTruthy();
    expect(screen.getByText(/not counted as exclusive/)).toBeTruthy();
    cleanup();
    call.mockResolvedValue(ok(answer()));
    mount();
    await screen.findByText('5');
    expect(screen.queryByText(/not counted as exclusive/)).toBeNull();
  });

  it('asks before refreshing, then replaces the link and says so', async () => {
    call.mockResolvedValueOnce(ok(answer()));
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Refresh link…' }));
    expect(screen.getByText(/The old link and its QR stop working at once/)).toBeTruthy();
    expect(call).toHaveBeenCalledTimes(1);
    call.mockResolvedValueOnce(
      ok(answer({ link: { token: 'newTOKEN9', createdAt: '2026-11-02T00:00:00.000Z' } })),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Create new link' }));
    await waitFor(() =>
      expect(screen.getByLabelText<HTMLInputElement>('Invite link').value).toBe(
        'https://shop.example/invite/newTOKEN9',
      ),
    );
    expect(call.mock.calls[1]).toEqual([
      'POST',
      'customers/seller/invite-link/refresh',
      undefined,
      'csrf',
    ]);
    await expectToast('New link created');
  });

  it('keeps the confirm open and shows the error when the refresh fails', async () => {
    call.mockResolvedValueOnce(ok(answer()));
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Refresh link…' }));
    call.mockResolvedValueOnce(fail(503, 'customers.unavailable'));
    fireEvent.click(screen.getByRole('button', { name: 'Create new link' }));
    expect(await screen.findByText('The new link could not be created. Try again.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create new link' })).toBeTruthy();
  });

  it('offers Create link without a confirm when there is no link yet', async () => {
    call.mockResolvedValueOnce(ok(answer({ link: null, signups: { active: 0, rejected: 0 } })));
    mount();
    expect(await screen.findByText('You have no invite link yet.')).toBeTruthy();
    call.mockResolvedValueOnce(ok(answer()));
    fireEvent.click(screen.getByRole('button', { name: 'Create link' }));
    await waitFor(() => expect(screen.getByLabelText('Invite link')).toBeTruthy());
  });

  it('shows a notice, not a link, when the storefront address is not set; 403 hides the page', async () => {
    call.mockResolvedValue(ok(answer()));
    mount(null);
    expect(await screen.findByText(/storefront address is not set/)).toBeTruthy();
    cleanup();
    call.mockResolvedValue(fail(403, 'access.denied'));
    mount();
    expect(await screen.findByText('Invite customers is not available')).toBeTruthy();
  });

  it('shows Try again on a failed read', async () => {
    call.mockResolvedValueOnce(fail(503, 'customers.unavailable'));
    call.mockResolvedValueOnce(ok(answer()));
    mount();
    expect(await screen.findByText("Couldn't load your invite link.")).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByLabelText('Invite link')).toBeTruthy();
  });
});

describe('ExclusivePerks', () => {
  const promo = (over: Partial<OwnPromotion> = {}): OwnPromotion => ({
    id: '0190a000-0000-7000-8000-0000000000e1',
    type: 'CUSTOMER_GROUP',
    status: 'ACTIVE',
    name: 'Friends 10',
    funding: 'SELLER',
    startsAt: '2026-11-01T00:00:00.000Z',
    endsAt: null,
    currency: 'AUD',
    reward: { kind: 'PERCENT', bps: 1000, amountMinor: null },
    segment: { kind: 'SELLER_EXCLUSIVE' },
    pausedBy: null,
    ...over,
  });
  const mount = (canManage = true) =>
    render(
      wrap(<ExclusivePerks canManage={canManage} csrfToken="csrf" timeZone="Australia/Brisbane" />),
    );

  it('picks the exclusive promotion among the customer-group ones', () => {
    const other = promo({ id: 'x', segment: { kind: 'RETURNING_CUSTOMER' } });
    expect(exclusiveOf([other, promo()])?.name).toBe('Friends 10');
    expect(exclusiveOf([other])).toBeNull();
    expect(displayStatus(promo({ endsAt: '2020-01-01T00:00:00.000Z' }), new Date())).toBe('ENDED');
    expect(displayStatus(promo(), new Date())).toBe('ACTIVE');
  });

  it('fixes the segment and the funding in the body, and maps the API codes', () => {
    expect(
      promotionBody({
        name: 'A',
        reward: { kind: 'PERCENT', bps: 500 },
        startsAt: null,
        endsAt: null,
      }),
    ).toEqual({
      type: 'CUSTOMER_GROUP',
      name: 'A',
      funding: 'SELLER',
      segment: { kind: 'SELLER_EXCLUSIVE' },
      reward: { kind: 'PERCENT', bps: 500 },
    });
    expect(problemOf({ status: 409, code: 'promotions.too-many-active' })).toBe('too-many');
    expect(problemOf({ status: 400, code: 'validation.failed' })).toBe('invalid');
    expect(problemOf({ status: 429, code: 'x' })).toBe('throttled');
  });

  it('shows the current discount with a status word and the manage actions', async () => {
    servePerks(call, { discount: [ok({ items: [promo()] })] });
    mount();
    expect(await screen.findByText('Friends 10')).toBeTruthy();
    expect(screen.getAllByText('Active').length).toBe(1);
    expect(screen.getByText('10%')).toBeTruthy();
    expect(screen.getByText('Your exclusive customers')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Edit…' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Pause…' })).toBeTruthy();
    expect(call.mock.calls.map((c) => c[1])).toContain(
      'promotions/seller/promotions?type=CUSTOMER_GROUP&limit=100',
    );
  });

  it('is view only without the manage key, and offers Resume only for a seller pause', async () => {
    call.mockResolvedValue(ok({ items: [promo({ status: 'PAUSED', pausedBy: 'SELLER' })] }));
    mount(false);
    await screen.findByText('Friends 10');
    expect(screen.queryByRole('button', { name: 'Edit…' })).toBeNull();
    cleanup();
    call.mockResolvedValue(ok({ items: [promo({ status: 'PAUSED', pausedBy: 'ADMIN' })] }));
    mount();
    await screen.findByText(/MondaPac paused this discount/);
    expect(screen.queryByRole('button', { name: 'Resume…' })).toBeNull();
  });

  it('creates the discount through the dialog and shows the API refusal as given', async () => {
    servePerks(call, {
      writes: [fail(400, 'validation.failed', { fields: [{ path: 'reward', code: 'range' }] })],
    });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Create exclusive discount…' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Friends' } });
    fireEvent.change(screen.getByLabelText('Discount (%)'), { target: { value: '90' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create discount' }));
    expect(await screen.findByText(/above the limit for sellers/)).toBeTruthy();
    expect(call.mock.calls.find((c) => c[0] === 'POST')).toEqual([
      'POST',
      'promotions/seller/promotions',
      expect.objectContaining({
        type: 'CUSTOMER_GROUP',
        funding: 'SELLER',
        segment: { kind: 'SELLER_EXCLUSIVE' },
        reward: { kind: 'PERCENT', bps: 9000 },
      }),
      'csrf',
    ]);
  });

  it('says promotions are off in the Market on 404, and hides on 403', async () => {
    servePerks(call, { discount: [fail(404, 'promotions.disabled')] });
    mount();
    expect(await screen.findByText('Promotions are not available in your Market')).toBeTruthy();
    cleanup();
    servePerks(call, {
      discount: [fail(403, 'access.denied')],
      cashback: [fail(403, 'access.denied')],
    });
    const { container } = mount();
    await waitFor(() => expect(container.textContent).toBe(''));
  });
});

describe('nav', () => {
  it('shows Customers only with its key, between Orders and Reviews', () => {
    const ids = (keys: string[]) => sellerNavItems('approved', keys).map((item) => item.id);
    expect(ids(['customers.seller-customers.view'])).toContain('s_customers');
    expect(ids(['ordering.seller-order.view'])).not.toContain('s_customers');
    const all = ids([
      'ordering.seller-order.view',
      'customers.seller-customers.view',
      'reviews.seller.view',
    ]);
    expect(all.indexOf('s_orders')).toBeLessThan(all.indexOf('s_customers'));
    expect(all.indexOf('s_customers')).toBeLessThan(all.indexOf('s_reviews'));
  });
});
