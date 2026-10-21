// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Ui from '@mondapac/ui';
import messages from '../../messages/en.json';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh: vi.fn() }) }));
vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));
const chime = { ready: vi.fn(() => true), unlock: vi.fn(), play: vi.fn() };
vi.mock('@mondapac/ui', async (original) => ({
  ...(await original<typeof Ui>()),
  createChime: () => chime,
}));

import { callApi } from '../api/client.ts';
import { SellerNotifications } from './seller-notifications.tsx';
import type { Notice } from './types.ts';

const call = vi.mocked(callApi);
const OLD = '0190a000-0000-7000-8000-000000000001';
const NEW = '0190a000-0000-7000-8000-000000000002';
const ORDER = '0190a000-0000-7000-8000-0000000000a1';
const OFFER = '0190a000-0000-7000-8000-0000000000b1';
const PRODUCT = '0190a000-0000-7000-8000-0000000000c1';
const VARIANT = '0190a000-0000-7000-8000-0000000000d1';
const notice = (id: string, over: Partial<Notice> = {}): Notice => ({
  id,
  kind: 'seller.order-paid',
  params: { sellerOrderId: ORDER, items: 2 },
  createdAt: '2026-10-18T10:00:00.000Z',
  read: false,
  ...over,
});

let counts: { unread: number; newest: Notice | null }[] = [];
let visibility: DocumentVisibilityState = 'visible';

function answer(path: string, method: string) {
  if (path.endsWith('/unread-count')) {
    const next = counts.length > 1 ? counts.shift()! : counts[0]!;
    return { ok: true as const, status: 200, body: next };
  }
  if (method === 'POST') return { ok: true as const, status: 200, body: { marked: 1 } };
  return { ok: true as const, status: 200, body: { items: [notice(NEW)], next: null } };
}

const unreadCalls = () => call.mock.calls.filter(([, path]) => path.endsWith('/unread-count'));
const mount = () =>
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages} timeZone="UTC">
      <SellerNotifications csrfToken="csrf-1" />
    </NextIntlClientProvider>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  window.localStorage.clear();
  counts = [{ unread: 0, newest: null }];
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  call.mockImplementation((method, path) => Promise.resolve(answer(path, method)));
  chime.unlock.mockResolvedValue(true);
  chime.play.mockResolvedValue(true);
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('SellerNotifications polling', () => {
  it('asks for the count at once and every 30 s, and shows it on the bell', async () => {
    counts = [{ unread: 3, newest: notice(OLD) }];
    mount();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Notifications, 3 unread' })));
    expect(unreadCalls()).toHaveLength(1);
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(unreadCalls()).toHaveLength(2);
  });

  it('pauses while the tab is hidden and asks again as soon as it is back', async () => {
    mount();
    await waitFor(() => expect(unreadCalls()).toHaveLength(1));
    visibility = 'hidden';
    act(() => void document.dispatchEvent(new Event('visibilitychange')));
    await act(() => vi.advanceTimersByTimeAsync(120_000));
    expect(unreadCalls()).toHaveLength(1);
    visibility = 'visible';
    act(() => void document.dispatchEvent(new Event('visibilitychange')));
    await waitFor(() => expect(unreadCalls()).toHaveLength(2));
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(unreadCalls()).toHaveLength(3);
  });

  it('stops asking once the session is gone', async () => {
    call.mockResolvedValue({ ok: false, failure: { status: 401, code: 'session.invalid' } });
    mount();
    await waitFor(() => expect(unreadCalls()).toHaveLength(1));
    await act(() => vi.advanceTimersByTimeAsync(90_000));
    expect(unreadCalls()).toHaveLength(1);
  });
});

describe('SellerNotifications sound', () => {
  it('does not ring for orders already waiting, rings once for a new one, and says so', async () => {
    counts = [
      { unread: 1, newest: notice(OLD) },
      { unread: 2, newest: notice(NEW) },
      { unread: 2, newest: notice(NEW) },
    ];
    mount();
    await waitFor(() => expect(unreadCalls()).toHaveLength(1));
    expect(chime.play).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    await waitFor(() => expect(chime.play).toHaveBeenCalledTimes(1));
    expect(screen.getByText('2 unread notifications')).toBeTruthy();
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(chime.play).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem('mp.seller.notices.heard')).toBe(NEW);
  });

  it('does not ring when an older unread notice becomes the newest after a read', async () => {
    window.localStorage.setItem('mp.seller.notices.heard', NEW);
    counts = [{ unread: 1, newest: notice(OLD) }];
    mount();
    await waitFor(() => expect(unreadCalls()).toHaveLength(1));
    expect(chime.play).not.toHaveBeenCalled();
  });

  it('stays silent when muted on this device, and the switch is in the drawer', async () => {
    window.localStorage.setItem('mp.seller.notices.heard', OLD);
    window.localStorage.setItem('mp.seller.notices.sound', 'off');
    counts = [{ unread: 1, newest: notice(NEW) }];
    mount();
    await waitFor(() => expect(unreadCalls()).toHaveLength(1));
    expect(chime.play).not.toHaveBeenCalled();
    // The count call can resolve before the bell's label re-renders, so wait for the label too.
    fireEvent.click(await screen.findByRole('button', { name: 'Notifications, 1 unread' }));
    fireEvent.click(await screen.findByRole('button', { name: /Order sound off/ }));
    expect(window.localStorage.getItem('mp.seller.notices.sound')).toBe('on');
  });

  it('offers to enable sound while the browser blocks it', async () => {
    chime.unlock.mockResolvedValue(false);
    mount();
    const enable = await screen.findByRole('button', { name: 'Enable order sound' });
    chime.unlock.mockResolvedValue(true);
    fireEvent.click(enable);
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Enable order sound' })).toBeNull(),
    );
  });
});

describe('SellerNotifications drawer', () => {
  it('lists unread first, switches tabs, and opens a notice on its order after marking it read', async () => {
    counts = [{ unread: 1, newest: notice(NEW) }];
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Notifications, 1 unread' }));
    const link = await screen.findByRole('link', { name: /New order with 2 items/ });
    expect(link.getAttribute('href')).toBe(`/orders/${ORDER}`);
    expect(call).toHaveBeenCalledWith('GET', 'notifications/seller/notices?show=unread');
    fireEvent.click(screen.getByRole('button', { name: 'Read' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith('GET', 'notifications/seller/notices?show=read'),
    );
    fireEvent.click(await screen.findByRole('link', { name: /New order with 2 items/ }));
    await waitFor(() => expect(push).toHaveBeenCalledWith(`/orders/${ORDER}`));
    expect(call).toHaveBeenCalledWith(
      'POST',
      `notifications/seller/notices/${NEW}/read`,
      {},
      'csrf-1',
    );
  });

  it("shows the customer's short name, as text, when the list carries one", async () => {
    counts = [{ unread: 1, newest: notice(NEW) }];
    call.mockImplementation((method, path) =>
      Promise.resolve(
        path.includes('?show=')
          ? {
              ok: true as const,
              status: 200,
              body: {
                items: [{ ...notice(NEW), customerShortName: '<b>Maryam</b> R.' }],
                next: null,
              },
            }
          : answer(path, method),
      ),
    );
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Notifications, 1 unread' }));
    const link = await screen.findByRole('link', {
      name: /New order from <b>Maryam<\/b> R\. with 2\u00a0items is paid/,
    });
    expect(link.querySelector('b')).toBeNull();
  });

  it('marks all as read', async () => {
    counts = [{ unread: 1, newest: notice(NEW) }];
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Notifications, 1 unread' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Mark all as read' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'POST',
        'notifications/seller/notices/read-all',
        {},
        'csrf-1',
      ),
    );
    await waitFor(() => expect(screen.getByRole('button', { name: 'Notifications' })));
  });

  it.each([
    [
      'low stock',
      { kind: 'seller.low-stock', params: { offerId: OFFER, variantId: VARIANT, onlyLeft: 2 } },
      /Low stock: 2\u00a0units left of an offer/,
      `/offers/${OFFER}/stock`,
    ],
    [
      'a rejected held price',
      {
        kind: 'seller.price-hold-decided',
        params: {
          offerId: OFFER,
          variantId: VARIANT,
          recordId: VARIANT,
          outcome: 'rejected',
          priceKind: 'special',
        },
      },
      /Your special price change was rejected/,
      `/offers/${OFFER}/prices`,
    ],
    [
      'an Offer that needs changes',
      {
        kind: 'seller.offer-changes-requested',
        params: { offerId: OFFER, productId: PRODUCT, reason: 'description-claim' },
      },
      /Your offer needs changes: the description makes a claim/,
      `/offers/${OFFER}`,
    ],
    [
      'an image taken down',
      {
        kind: 'seller.image-taken-down',
        params: { productId: PRODUCT, imageId: VARIANT, reason: 'rights' },
      },
      /A product image was taken down after a rights claim/,
      `/products/${PRODUCT}`,
    ],
    [
      'a tag suspended',
      {
        kind: 'seller.offer-tag-changed',
        params: { offerId: OFFER, tagId: VARIANT, change: 'suspended' },
      },
      /A certification tag was suspended and the offer is off sale/,
      `/offers/${OFFER}`,
    ],
    [
      'the store approved',
      { kind: 'seller.access-changed', params: { change: 'approved' } },
      /Your store is approved/,
      '/',
    ],
  ])('opens %s on its page', async (_label, over, text, href) => {
    counts = [{ unread: 1, newest: null }];
    call.mockImplementation((method, path) =>
      Promise.resolve(
        path.includes('?show=')
          ? {
              ok: true as const,
              status: 200,
              body: { items: [notice(NEW, over as Partial<Notice>)], next: null },
            }
          : answer(path, method),
      ),
    );
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Notifications, 1 unread' }));
    const link = await screen.findByRole('link', { name: text });
    expect(link.getAttribute('href')).toBe(href);
  });

  it('shows a certificate notice, which has no seller page yet, as a row that only marks it read', async () => {
    counts = [{ unread: 1, newest: null }];
    call.mockImplementation((method, path) =>
      Promise.resolve(
        path.includes('?show=')
          ? {
              ok: true as const,
              status: 200,
              body: {
                items: [
                  notice(NEW, {
                    kind: 'seller.certificate-expiring',
                    params: { sellerCertificationId: VARIANT, days: 14 },
                  }),
                ],
                next: null,
              },
            }
          : answer(path, method),
      ),
    );
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Notifications, 1 unread' }));
    expect(
      await screen.findByRole('button', { name: /Your certificate expires in 14\u00a0days/ }),
    ).toBeTruthy();
    const row = screen.getByRole('button', { name: /Your certificate expires in 14/ });
    fireEvent.click(row);
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'POST',
        `notifications/seller/notices/${NEW}/read`,
        {},
        'csrf-1',
      ),
    );
    expect(push).not.toHaveBeenCalled();
  });
});
