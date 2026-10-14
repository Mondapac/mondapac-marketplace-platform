// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { CustomerLookup } from './customer-lookup.tsx';
import { customerProblemOf } from './errors.ts';
import type { CustomerAccount } from './types.ts';

const call = vi.mocked(callApi);
const wrap = (node: ReactNode) => (
  <NextIntlClientProvider locale="en-AU" messages={messages}>
    {node}
  </NextIntlClientProvider>
);
const ID = '0190a000-0000-7000-8000-0000000000c1';
const customer = (status: CustomerAccount['status'] = 'active'): CustomerAccount => ({
  accountId: ID,
  email: 'Sara@Example.com',
  status,
  createdAt: '2026-10-01T02:30:00.000Z',
  emailVerified: true,
});
const mount = (canChangeStatus = true) =>
  render(wrap(<CustomerLookup canChangeStatus={canChangeStatus} csrfToken="csrf" />));
const search = (value: string) => {
  fireEvent.change(screen.getByLabelText('Customer email'), { target: { value } });
  fireEvent.click(screen.getByRole('button', { name: 'Find customer' }));
};

beforeEach(() => {
  vi.clearAllMocks();
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute('open');
  };
});
afterEach(cleanup);

describe('CustomerLookup', () => {
  it('sends the trimmed address in a POST body and shows the account', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: customer() });
    mount();
    search('  sara@example.com ');
    expect(await screen.findByText('Sara@Example.com')).toBeTruthy();
    expect(call).toHaveBeenCalledWith(
      'POST',
      'identity/admin/customers/lookup',
      { email: 'sara@example.com' },
      'csrf',
    );
    expect(screen.getByText('Active')).toBeTruthy();
    expect(screen.getByText('Yes')).toBeTruthy();
    expect(screen.getByText('1 Oct 2026, 2:30 am UTC')).toBeTruthy();
  });

  it('refuses an empty or partial address before calling the API', () => {
    mount();
    for (const bad of ['', '   ', 'sara']) {
      search(bad);
      expect(screen.getByText('Enter a full email address.')).toBeTruthy();
    }
    expect(call).not.toHaveBeenCalled();
  });

  it('says no customer was found, as information rather than an error', async () => {
    call.mockResolvedValue({
      ok: false,
      failure: { status: 404, code: 'customer.not-found' },
    });
    mount();
    search('nobody@example.com');
    const banner = await screen.findByRole('status');
    expect(banner.textContent).toContain('No customer found');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows the service error as an alert', async () => {
    call.mockResolvedValue({ ok: false, failure: { status: 503, code: 'access.unavailable' } });
    mount();
    search('sara@example.com');
    expect((await screen.findByRole('alert')).textContent).toContain('not available');
  });

  it('waits out a 429 with its Retry-After before the next lookup', async () => {
    call.mockResolvedValue({
      ok: false,
      failure: { status: 429, code: 'request.throttled', details: { retryAfterSeconds: 1 } },
    });
    mount();
    search('sara@example.com');
    expect(await screen.findByText('Too many requests. Try again in 1 second.')).toBeTruthy();
    const button = screen.getByRole<HTMLButtonElement>('button', { name: 'Find customer' });
    expect(button.disabled).toBe(true);
    await waitFor(() => expect(button.disabled).toBe(false), { timeout: 3000 });
  });

  it('disables the account after confirmation, then offers to enable it', async () => {
    call.mockResolvedValueOnce({ ok: true, status: 200, body: customer() });
    mount();
    search('sara@example.com');
    fireEvent.click(await screen.findByRole('button', { name: 'Disable account' }));
    expect(screen.getByText('Disable this account?')).toBeTruthy();
    call.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: { code: 'account.disabled', accountId: ID },
    });
    const confirm = screen.getAllByRole('button', { name: 'Disable account' }).at(-1);
    fireEvent.click(confirm as HTMLElement);
    await waitFor(() => expect(call).toHaveBeenCalledTimes(2));
    expect(call.mock.calls[1]).toEqual([
      'POST',
      `identity/admin/customers/${ID}/disable`,
      {},
      'csrf',
    ]);
    expect(await screen.findByText(/Account disabled/)).toBeTruthy();
    expect(screen.getByText('Disabled')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Enable account' })).toBeTruthy();
  });

  it('enables a disabled account after confirmation', async () => {
    call.mockResolvedValueOnce({ ok: true, status: 200, body: customer('disabled') });
    mount();
    search('sara@example.com');
    fireEvent.click(await screen.findByRole('button', { name: 'Enable account' }));
    call.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: { code: 'account.enabled', accountId: ID },
    });
    const confirm = screen.getAllByRole('button', { name: 'Enable account' }).at(-1);
    fireEvent.click(confirm as HTMLElement);
    await waitFor(() => expect(call).toHaveBeenCalledTimes(2));
    expect(call.mock.calls[1]?.[1]).toBe(`identity/admin/customers/${ID}/enable`);
    expect(await screen.findByText(/Account enabled/)).toBeTruthy();
    expect(screen.getByText('Active')).toBeTruthy();
  });

  it('shows a refused status change on the card and keeps the dialog closed', async () => {
    call.mockResolvedValueOnce({ ok: true, status: 200, body: customer() });
    mount();
    search('sara@example.com');
    fireEvent.click(await screen.findByRole('button', { name: 'Disable account' }));
    call.mockResolvedValueOnce({
      ok: false,
      failure: { status: 409, code: 'account.already-disabled' },
    });
    fireEvent.click(
      screen.getAllByRole('button', { name: 'Disable account' }).at(-1) as HTMLElement,
    );
    expect((await screen.findByRole('alert')).textContent).toContain('changed in the meantime');
    expect(screen.queryByText('Disable this account?')).toBeNull();
  });

  it('clears the card when the address changes', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: customer() });
    mount();
    search('sara@example.com');
    expect(await screen.findByText('Sara@Example.com')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Customer email'), { target: { value: 'other@x.com' } });
    expect(screen.queryByText('Sara@Example.com')).toBeNull();
  });

  it('shows no status action without the disable permission', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: customer('disabled') });
    mount(false);
    search('sara@example.com');
    expect(await screen.findByText('Disabled')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /able account/ })).toBeNull();
  });
});

describe('customerProblemOf', () => {
  it('maps codes, and falls back by status', () => {
    expect(customerProblemOf({ status: 404, code: 'customer.not-found' })).toBe('not-found');
    expect(customerProblemOf({ status: 409, code: 'account.already-disabled' })).toBe('changed');
    expect(customerProblemOf({ status: 429, code: 'other' })).toBe('throttled');
    expect(customerProblemOf({ status: 0, code: 'network' })).toBe('unavailable');
    expect(customerProblemOf({ status: 500, code: 'boom' })).toBe('unknown');
  });
});
