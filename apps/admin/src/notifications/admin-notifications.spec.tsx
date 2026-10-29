// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Ui from '@mondapac/ui';
import en from '../../messages/en.json';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh: vi.fn() }) }));
vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));
const chime = { ready: vi.fn(() => true), unlock: vi.fn(), play: vi.fn() };
vi.mock('@mondapac/ui', async (original) => ({
  ...(await original<typeof Ui>()),
  createChime: () => chime,
}));

import { callApi } from '../api/client.ts';
import { AdminNotifications } from './admin-notifications.tsx';
import { showsNoticeBell, type AdminNotice } from './types.ts';

const call = vi.mocked(callApi);
const OLD = '0190a000-0000-7000-8000-000000000001';
const NEW = '0190a000-0000-7000-8000-000000000002';
const SELLER = '0190a000-0000-7000-8000-0000000000b1';
const notice = (id: string, over: Partial<AdminNotice> = {}): AdminNotice => ({
  id,
  kind: 'admin.seller-file-submitted',
  params: { sellerId: SELLER, fileKind: 'onboarding' },
  createdAt: '2026-10-18T10:00:00.000Z',
  read: false,
  ...over,
});
const LISTED: readonly AdminNotice[] = [
  notice('0190a000-0000-7000-8000-000000000014', {
    kind: 'admin.seller-certificate-submitted',
    params: { sellerId: SELLER, sellerCertificationId: OLD, submission: 'renewal' },
  }),
  notice('0190a000-0000-7000-8000-000000000013', {
    kind: 'admin.product-revision-submitted',
    params: { productId: OLD, revisionId: NEW },
  }),
  notice('0190a000-0000-7000-8000-000000000012', {
    params: { sellerId: SELLER, fileKind: 'identity-change' },
    read: true,
  }),
  notice('0190a000-0000-7000-8000-000000000011', {
    kind: 'admin.price-hold-opened',
    params: { recordId: OLD, offerId: NEW, direction: 'down' },
  }),
  notice('0190a000-0000-7000-8000-000000000010', {
    kind: 'admin.delivery-fallback-over-cap',
    params: { sellerId: SELLER, sellerOrderId: OLD },
  }),
];

let counts: { unread: number; newest: AdminNotice | null }[] = [];
let visibility: DocumentVisibilityState = 'visible';

function answer(path: string, method: string) {
  if (path.endsWith('/unread-count')) {
    const next = counts.length > 1 ? counts.shift()! : counts[0]!;
    return { ok: true as const, status: 200, body: next };
  }
  if (method === 'POST') return { ok: true as const, status: 200, body: { marked: 1 } };
  return { ok: true as const, status: 200, body: { items: LISTED, next: null } };
}

const unreadCalls = () => call.mock.calls.filter(([, path]) => path.endsWith('/unread-count'));
const mount = () =>
  render(
    <NextIntlClientProvider locale="en-AU" messages={en} timeZone="UTC">
      <AdminNotifications csrfToken="csrf-1" />
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

describe('AdminNotifications polling', () => {
  it('asks for the count at once and every 60 s, and caps the badge at 99+', async () => {
    counts = [{ unread: 140, newest: notice(OLD) }];
    mount();
    const bell = await screen.findByRole('button', { name: 'Notifications, 140 unread' });
    expect(bell.textContent).toBe('99+');
    expect(call).toHaveBeenCalledWith('GET', 'notifications/admin/notices/unread-count');
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(unreadCalls()).toHaveLength(1);
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(unreadCalls()).toHaveLength(2);
  });

  it('pauses while the tab is hidden and asks again as soon as it is back', async () => {
    mount();
    await waitFor(() => expect(unreadCalls()).toHaveLength(1));
    visibility = 'hidden';
    act(() => void document.dispatchEvent(new Event('visibilitychange')));
    await act(() => vi.advanceTimersByTimeAsync(240_000));
    expect(unreadCalls()).toHaveLength(1);
    visibility = 'visible';
    act(() => void document.dispatchEvent(new Event('visibilitychange')));
    await waitFor(() => expect(unreadCalls()).toHaveLength(2));
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(unreadCalls()).toHaveLength(3);
  });

  it('stops asking once the admin may no longer see notices', async () => {
    call.mockResolvedValue({ ok: false, failure: { status: 403, code: 'access.denied' } });
    mount();
    await waitFor(() => expect(unreadCalls()).toHaveLength(1));
    await act(() => vi.advanceTimersByTimeAsync(180_000));
    expect(unreadCalls()).toHaveLength(1);
  });
});

describe('AdminNotifications sound', () => {
  it('is off by default: a new notice changes the badge and the live region, with no sound', async () => {
    counts = [
      { unread: 1, newest: notice(OLD) },
      { unread: 2, newest: notice(NEW) },
    ];
    mount();
    await waitFor(() => expect(unreadCalls()).toHaveLength(1));
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    await waitFor(() => expect(screen.getByText('2 unread notifications')).toBeTruthy());
    expect(chime.play).not.toHaveBeenCalled();
    expect(chime.unlock).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Enable notification sound' })).toBeNull();
  });

  it('switched on in the drawer, rings once for a new burst of any approval kind', async () => {
    counts = [
      { unread: 1, newest: notice(OLD) },
      { unread: 3, newest: notice(NEW, { kind: 'admin.price-hold-opened' }) },
      { unread: 3, newest: notice(NEW, { kind: 'admin.price-hold-opened' }) },
    ];
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Notifications, 1 unread' }));
    fireEvent.click(await screen.findByRole('button', { name: /Notification sound off/ }));
    expect(window.localStorage.getItem('mp.admin.notices.sound')).toBe('on');
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    await waitFor(() => expect(chime.play).toHaveBeenCalledTimes(1));
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(chime.play).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem('mp.admin.notices.heard')).toBe(NEW);
  });

  it('offers to enable sound while the browser blocks a sound switched on here', async () => {
    window.localStorage.setItem('mp.admin.notices.sound', 'on');
    chime.unlock.mockResolvedValue(false);
    mount();
    const enable = await screen.findByRole('button', { name: 'Enable notification sound' });
    chime.unlock.mockResolvedValue(true);
    fireEvent.click(enable);
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Enable notification sound' })).toBeNull(),
    );
  });
});

describe('AdminNotifications drawer', () => {
  it('shows all five kinds, linking only those with an admin page', async () => {
    counts = [{ unread: 3, newest: notice(NEW) }];
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Notifications, 3 unread' }));
    expect(call).toHaveBeenCalledWith('GET', 'notifications/admin/notices?show=unread');
    const certificate = await screen.findByRole('button', {
      name: /A seller submitted a certificate renewal for review/,
    });
    expect(certificate.closest('a')).toBeNull();
    expect(screen.getByRole('button', { name: /A product version is waiting for review/ }));
    const seller = screen.getByRole('link', { name: /A seller changed their business details/ });
    expect(seller.getAttribute('href')).toBe(`/sellers/${SELLER}`);
    const price = screen.getByRole('link', { name: /A price drop is held for approval/ });
    expect(price.getAttribute('href')).toBe('/price-holds');
    const delivery = screen.getByRole('link', { name: /A different fleet was booked/ });
    expect(delivery.getAttribute('href')).toBe('/delivery-settings');
  });

  it('marks a notice without a page read in place, and opens a linked one after marking it', async () => {
    counts = [{ unread: 3, newest: notice(NEW) }];
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Notifications, 3 unread' }));
    const product = await screen.findByRole('button', { name: /A product version/ });
    expect(product.textContent).toContain('Unread');
    fireEvent.click(product);
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'POST',
        'notifications/admin/notices/0190a000-0000-7000-8000-000000000013/read',
        {},
        'csrf-1',
      ),
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /A product version/ }).textContent).not.toContain(
        'Unread',
      ),
    );
    expect(push).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('link', { name: /A price drop/ }));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/price-holds'));
  });

  it('shows an error with Retry, and marks all as read', async () => {
    counts = [{ unread: 1, newest: notice(NEW) }];
    call.mockImplementationOnce((method, path) => Promise.resolve(answer(path, method)));
    call.mockImplementationOnce(() =>
      Promise.resolve({ ok: false, failure: { status: 503, code: 'access.unavailable' } }),
    );
    mount();
    await waitFor(() => expect(unreadCalls()).toHaveLength(1));
    fireEvent.click(await screen.findByRole('button', { name: 'Notifications, 1 unread' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    await screen.findByRole('button', { name: /A product version/ });
    fireEvent.click(screen.getByRole('button', { name: 'Mark all as read' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'POST',
        'notifications/admin/notices/read-all',
        {},
        'csrf-1',
      ),
    );
    await waitFor(() => expect(screen.getByRole('button', { name: 'Notifications' })));
  });
});

describe('admin notice bell', () => {
  it('is shown to an admin holding any one of the four review permissions', () => {
    expect(showsNoticeBell(['pricing.price-hold.decide'])).toBe(true);
    expect(showsNoticeBell(['certification.seller-certificate.review'])).toBe(true);
    expect(showsNoticeBell(['catalog.product.approve', 'identity.role.manage'])).toBe(true);
    expect(showsNoticeBell(['sellers.seller-file.review'])).toBe(true);
    expect(showsNoticeBell(['shipping.delivery-settings.view'])).toBe(true);
    expect(showsNoticeBell(['identity.role.manage'])).toBe(false);
    expect(showsNoticeBell([])).toBe(false);
  });
});
