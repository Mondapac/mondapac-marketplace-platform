// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { OwnerSecondFactorCard, ownerResetProblemOf } from './owner-second-factor-card.tsx';
import { expectToast } from '../../test/toast-spy.ts';

const call = vi.mocked(callApi);
const SELLER = '0190a000-0000-7000-8000-0000000000a1';
const mount = () =>
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <OwnerSecondFactorCard sellerId={SELLER} csrfToken="csrf" />
    </NextIntlClientProvider>,
  );
const start = async () => {
  fireEvent.click(screen.getByRole('button', { name: 'Start two-step reset' }));
  expect(screen.getByText('Start a two-step reset?')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Send link' }));
  await waitFor(() => expect(call).toHaveBeenCalled());
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

describe('OwnerSecondFactorCard', () => {
  it('starts the reset only after confirmation and says nothing changes until the owner confirms', async () => {
    call.mockResolvedValue({
      ok: true,
      status: 200,
      body: { code: 'second-factor-reset.requested', sellerId: SELLER },
    });
    mount();
    expect(call).not.toHaveBeenCalled();
    await start();
    expect(call).toHaveBeenCalledWith(
      'POST',
      `identity/admin/sellers/${SELLER}/second-factor/reset`,
      {},
      'csrf',
    );
    await expectToast('Link sent to the store owner');
    await expectToast(/Nothing changes until the owner confirms/);
    expect(screen.getByRole('button', { name: 'Send a new link' })).toBeTruthy();
  });

  it('cancels without a call', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Start two-step reset' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText('Start a two-step reset?')).toBeNull();
    expect(call).not.toHaveBeenCalled();
  });

  it('explains an owner without two-step sign-in as information', async () => {
    call.mockResolvedValue({ ok: false, failure: { status: 409, code: 'second-factor.none' } });
    mount();
    await start();
    expect((await screen.findByRole('status')).textContent).toContain('does not use two-step');
  });

  it('waits out a 429 before it can start again', async () => {
    call.mockResolvedValue({
      ok: false,
      failure: { status: 429, code: 'request.throttled', details: { retryAfterSeconds: 1 } },
    });
    mount();
    await start();
    expect(await screen.findByText('Too many requests. Try again in 1 second.')).toBeTruthy();
    const button = screen.getByRole<HTMLButtonElement>('button', { name: 'Start two-step reset' });
    expect(button.disabled).toBe(true);
    await waitFor(() => expect(button.disabled).toBe(false), { timeout: 3000 });
  });

  it('shows the service error as an alert', async () => {
    call.mockResolvedValue({ ok: false, failure: { status: 503, code: 'access.unavailable' } });
    mount();
    await start();
    expect((await screen.findByRole('alert')).textContent).toContain('not available');
  });
});

describe('OwnerSecondFactorCard refusals', () => {
  it('shows a refused start as an alert', async () => {
    call.mockResolvedValue({ ok: false, failure: { status: 403, code: 'access.denied' } });
    mount();
    await start();
    expect((await screen.findByRole('alert')).textContent).toContain('permission');
  });

  it('asks to try again after a concurrent change', async () => {
    call.mockResolvedValue({ ok: false, failure: { status: 409, code: 'conflict.stale' } });
    mount();
    await start();
    expect((await screen.findByRole('alert')).textContent).toContain('Try again');
  });

  it('sends a signed-out admin to the session-ended page', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    call.mockResolvedValue({ ok: false, failure: { status: 401, code: 'session.invalid' } });
    mount();
    await start();
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/session-ended'));
    vi.unstubAllGlobals();
  });
});

describe('ownerResetProblemOf', () => {
  it('maps codes, and falls back by status', () => {
    expect(ownerResetProblemOf({ status: 404, code: 'account.unknown' })).toBe('no-owner');
    expect(ownerResetProblemOf({ status: 409, code: 'conflict.stale' })).toBe('retry');
    expect(ownerResetProblemOf({ status: 429, code: 'x' })).toBe('throttled');
    expect(ownerResetProblemOf({ status: 403, code: 'x' })).toBe('denied');
    expect(ownerResetProblemOf({ status: 0, code: 'network' })).toBe('unavailable');
    expect(ownerResetProblemOf({ status: 500, code: 'x' })).toBe('unknown');
  });
});
