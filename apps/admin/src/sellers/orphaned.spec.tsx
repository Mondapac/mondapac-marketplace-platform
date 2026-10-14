// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { NoticeProvider } from '../team/notice.tsx';
import { OrphanedList } from './orphaned-list.tsx';
import type { InviteHint, OrphanPage, OrphanRow } from './orphaned-types.ts';

const call = vi.mocked(callApi);
const ALLOWED: InviteHint = { allowed: true, code: null };
const A = '0190a000-0000-7000-8000-00000000a001';
const B = '0190a000-0000-7000-8000-00000000a002';
const C = '0190a000-0000-7000-8000-00000000a003';

const row = (sellerId: string, over: Partial<OrphanRow> = {}): OrphanRow => ({
  type: 'orphan',
  sellerId,
  state: 'pending',
  stateChangedAt: '2026-10-13T01:00:00.000Z',
  createdAt: '2026-10-01T03:30:00.000Z',
  actions: { invite: ALLOWED },
  ...over,
});
const page = (items: OrphanRow[], next: string | null = null) => ({
  ok: true as const,
  status: 200,
  body: { items, next } satisfies OrphanPage,
});
const fail = (status: number, code: string, details?: object) => ({
  ok: false as const,
  failure: { status, code, ...(details === undefined ? {} : { details }) },
});

function mount() {
  return render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <NoticeProvider>
        <OrphanedList csrfToken="csrf-1" />
      </NoticeProvider>
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  call.mockReset();
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

/** Opens the dialog of the first row and fills it in. */
async function openAndFill(email = 'owner@example.com', name = 'Ola Owner') {
  fireEvent.click((await screen.findAllByRole('button', { name: /Invite owner for seller/ }))[0]!);
  fireEvent.change(await screen.findByLabelText(/^Email/), { target: { value: email } });
  fireEvent.change(screen.getByLabelText(/^Owner name/), { target: { value: name } });
}
const assign = vi.fn();
beforeEach(() => {
  assign.mockReset();
  Object.defineProperty(window, 'location', { value: { assign }, configurable: true });
});
const sendButton = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Send invitation' });
const submit = () => fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }));

describe('sellers without an owner', () => {
  it('lists the sellers with a short id, the access badge and the created date', async () => {
    call.mockResolvedValueOnce(
      page([row(A), row(B, { state: 'suspended', createdAt: '2025-01-02T00:00:00.000Z' })]),
    );
    mount();
    const table = await screen.findByRole('table');
    expect(within(table).getByText('0000A001').getAttribute('title')).toBe(A);
    expect(within(table).getByText('Pending')).toBeTruthy();
    expect(within(table).getByText('Suspended')).toBeTruthy();
    expect(within(table).getByText(/1 Oct/)).toBeTruthy();
    expect(within(table).getByText(/2 Jan 2025/)).toBeTruthy();
    expect(table.querySelector('time')?.getAttribute('datetime')).toBe('2026-10-01T03:30:00.000Z');
    expect(within(table).getAllByRole('columnheader')).toHaveLength(4);
    expect(call).toHaveBeenCalledWith('GET', 'identity/admin/sellers?state=orphaned&limit=25');
  });

  it('says every seller has an owner when there are none', async () => {
    call.mockResolvedValueOnce(page([]));
    mount();
    expect(await screen.findByText('Every seller has an owner')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('shows the load error and retries', async () => {
    call
      .mockResolvedValueOnce(fail(503, 'access.unavailable'))
      .mockResolvedValueOnce(page([row(A)]));
    mount();
    expect(await screen.findByText("We couldn't load the sellers. Try again.")).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('table')).toBeTruthy();
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('shows the no-access message on a 403 without rows', async () => {
    call.mockResolvedValueOnce(fail(403, 'access.denied'));
    mount();
    expect(await screen.findByText("You don't have access to this page")).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Go to Home' })).toBeTruthy();
  });

  it('pages with Show more, each seller once; a failed page keeps the rows and the button', async () => {
    call
      .mockResolvedValueOnce(page([row(A), row(B)], B))
      .mockResolvedValueOnce(fail(503, 'access.unavailable'))
      .mockResolvedValueOnce(page([row(B), row(C)]));
    mount();
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getAllByRole('row')).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(4));
    expect(call).toHaveBeenLastCalledWith(
      'GET',
      `identity/admin/sellers?state=orphaned&limit=25&after=${B}`,
    );
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
  });

  it.each([
    ['access.denied', "You don't have permission to invite owners."],
    ['access.unavailable', "Invitations aren't available in this market."],
    ['seller-access.wrong-state', "You can't invite an owner for this seller right now."],
  ])('disables the invite with help text when the hint is %s', async (code, help) => {
    call.mockResolvedValueOnce(page([row(A, { actions: { invite: { allowed: false, code } } })]));
    mount();
    const button = await screen.findByRole('button', { name: 'Invite owner' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    const note = screen.getByText(help);
    expect(button.getAttribute('aria-describedby')).toBe(note.id);
  });

  it('sends the invitation, removes the row and says so', async () => {
    call.mockResolvedValueOnce(page([row(A), row(B)]));
    mount();
    await openAndFill('  owner@example.com ');
    call.mockResolvedValueOnce({ ok: true, status: 201, body: {} });
    submit();
    expect(await screen.findByText('Invitation sent to owner@example.com.')).toBeTruthy();
    expect(call).toHaveBeenLastCalledWith(
      'POST',
      `identity/admin/sellers/${A}/invitations`,
      { email: 'owner@example.com', displayName: 'Ola Owner' },
      'csrf-1',
    );
    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(2));
    expect(screen.queryByText('0000A001')).toBeNull();
    expect(screen.getByText('0000A002')).toBeTruthy();
  });

  it('checks the address and the name before sending', async () => {
    call.mockResolvedValueOnce(page([row(A)]));
    mount();
    await openAndFill('', 'Ola');
    submit();
    expect(await screen.findByText("Enter the owner's email address.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/^Email/), { target: { value: 'nope' } });
    submit();
    expect(await screen.findByText('Enter a valid email address.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/^Email/), { target: { value: 'a@b.example' } });
    fireEvent.change(screen.getByLabelText(/^Owner name/), { target: { value: ' ' } });
    submit();
    expect(await screen.findByText("Enter the owner's name.")).toBeTruthy();
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('shows a field error for a refused address or name', async () => {
    call.mockResolvedValueOnce(page([row(A)]));
    mount();
    await openAndFill();
    call.mockResolvedValueOnce(
      fail(400, 'validation.failed', { fields: [{ path: 'displayName', code: 'characters' }] }),
    );
    submit();
    expect(await screen.findByText(/Use a name of up to 100 characters/)).toBeTruthy();
  });

  it.each([
    [
      409,
      'account.exists',
      'Someone with this email already has an account. Use a different email.',
      false,
    ],
    [409, 'invitation.already-pending', 'An invitation is already waiting for this seller.', true],
    [409, 'seller.has-members', 'This seller already has an owner.', true],
    [409, 'conflict.stale', "This seller changed. We've refreshed the list, so try again.", true],
    [404, 'seller.unknown', 'This seller no longer exists.', true],
    [403, 'access.denied', "You don't have permission to invite owners.", false],
    [
      503,
      'access.unavailable',
      "We can't send invitations right now. Try again in a few minutes.",
      false,
    ],
    [0, 'network', 'Something went wrong. Try again.', false],
  ])('answers %s %s in the dialog, which stays open', async (status, code, text, refreshes) => {
    call.mockResolvedValueOnce(page([row(A)]));
    mount();
    await openAndFill();
    call.mockResolvedValueOnce(fail(status, code));
    if (refreshes) call.mockResolvedValueOnce(page([row(A)]));
    submit();
    const banner = await screen.findByRole('alert');
    expect(within(banner).getByText(text)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Send invitation' })).toBeTruthy();
    await waitFor(() => expect(call).toHaveBeenCalledTimes(refreshes ? 3 : 2));
  });

  it('keeps the dialog shut while sending twice: one request per press', async () => {
    call.mockResolvedValueOnce(page([row(A)]));
    mount();
    await openAndFill();
    let release: (value: Awaited<ReturnType<typeof callApi>>) => void = () => undefined;
    call.mockReturnValueOnce(new Promise((resolve) => (release = resolve)));
    submit();
    submit();
    expect(call).toHaveBeenCalledTimes(2);
    release({ ok: true, status: 201, body: {} });
    await screen.findByText('Invitation sent to owner@example.com.');
  });

  it('waits out a throttled send, in minutes, and the wait outlives the dialog', async () => {
    call.mockResolvedValueOnce(page([row(A)]));
    mount();
    await openAndFill();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    call.mockResolvedValueOnce(fail(429, 'request.throttled', { retryAfterSeconds: 125 }));
    submit();
    const message = "You've sent too many invitations. Try again in 3 minutes.";
    expect(await screen.findByText(message)).toBeTruthy();
    expect(sendButton().disabled).toBe(true);
    // Closing and opening again keeps the wait.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: /Invite owner for seller/ }));
    expect(await screen.findByText(message)).toBeTruthy();
    expect(sendButton().disabled).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(125_000);
    });
    expect(screen.queryByText(message)).toBeNull();
    expect(sendButton().disabled).toBe(false);
  });

  it('waits a minute when the throttle names no time', async () => {
    call.mockResolvedValueOnce(page([row(A)]));
    mount();
    await openAndFill();
    call.mockResolvedValueOnce(fail(429, 'request.throttled'));
    submit();
    expect(
      await screen.findByText("You've sent too many invitations. Try again in 1 minute."),
    ).toBeTruthy();
  });

  it('goes to /session-ended on a 401 of the list', async () => {
    call.mockResolvedValueOnce(fail(401, 'session.invalid'));
    mount();
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/session-ended'));
  });

  it('goes to /session-ended on a 401 of the invitation', async () => {
    call.mockResolvedValueOnce(page([row(A)]));
    mount();
    await openAndFill();
    call.mockResolvedValueOnce(fail(401, 'session.invalid'));
    submit();
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/session-ended'));
  });

  it('submits with Enter in the email field', async () => {
    call.mockResolvedValueOnce(page([row(A)]));
    mount();
    await openAndFill();
    call.mockResolvedValueOnce({ ok: true, status: 201, body: {} });
    fireEvent.submit(screen.getByLabelText(/^Email/).closest('form')!);
    await screen.findByText('Invitation sent to owner@example.com.');
  });

  it('blocks Cancel and Escape while the request is in flight', async () => {
    call.mockResolvedValueOnce(page([row(A)]));
    mount();
    await openAndFill();
    let release: (value: Awaited<ReturnType<typeof callApi>>) => void = () => undefined;
    call.mockReturnValueOnce(new Promise((resolve) => (release = resolve)));
    submit();
    const dialog = document.querySelector('dialog')!;
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Cancel' }).disabled).toBe(true);
    fireEvent(dialog, new Event('cancel', { cancelable: true }));
    expect(dialog.hasAttribute('open')).toBe(true);
    release({ ok: true, status: 201, body: {} });
    await waitFor(() => expect(dialog.hasAttribute('open')).toBe(false));
  });

  it('resets the fields and errors when the dialog is closed and opened again', async () => {
    call.mockResolvedValueOnce(page([row(A)]));
    mount();
    await openAndFill('bad', 'Ola');
    submit();
    expect(await screen.findByText('Enter a valid email address.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: /Invite owner for seller/ }));
    expect((await screen.findByLabelText<HTMLInputElement>(/^Email/)).value).toBe('');
    expect(screen.getByLabelText<HTMLInputElement>(/^Owner name/).value).toBe('');
    expect(screen.queryByText('Enter a valid email address.')).toBeNull();
  });

  it('lets a new attempt through once the wait has ended', async () => {
    call.mockResolvedValueOnce(page([row(A)]));
    mount();
    await openAndFill();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    call.mockResolvedValueOnce(fail(429, 'request.throttled', { retryAfterSeconds: 60 }));
    submit();
    const message = "You've sent too many invitations. Try again in 1 minute.";
    await screen.findByText(message);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(screen.queryByText(message)).toBeNull();
    call.mockResolvedValueOnce({ ok: true, status: 201, body: {} });
    submit();
    await screen.findByText('Invitation sent to owner@example.com.');
    expect(call).toHaveBeenCalledTimes(3);
  });
});
