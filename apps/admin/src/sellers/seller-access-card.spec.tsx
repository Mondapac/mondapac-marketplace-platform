// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

const router = { refresh: vi.fn(), push: vi.fn(), replace: vi.fn() };
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { accessProblemOf, SellerAccessCard, SUSPEND_REASON_MAX } from './seller-access-card.tsx';
import { expectNoToast, expectToast } from '../../test/toast-spy.ts';

const call = vi.mocked(callApi);
const SELLER = '0190a000-0000-7000-8000-0000000000a1';

function mount(access: 'approved' | 'suspended') {
  return render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <SellerAccessCard sellerId={SELLER} access={access} csrfToken="csrf" />
    </NextIntlClientProvider>,
  );
}

const dialog = () => within(screen.getByRole('dialog'));

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

describe('SellerAccessCard: suspend', () => {
  it('suspends an approved seller with the trimmed reason and re-reads the page', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: { code: 'seller-access.suspended' } });
    mount('approved');
    expect(screen.queryByRole('button', { name: 'Lift suspension' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Suspend…' }));
    expect(call).not.toHaveBeenCalled();
    const reason = dialog().getByLabelText('Reason for the seller');
    expect(reason.getAttribute('maxlength')).toBe(String(SUSPEND_REASON_MAX));
    fireEvent.change(reason, { target: { value: '  Expired food licence.\nSend the new one.  ' } });
    fireEvent.click(dialog().getByRole('button', { name: 'Suspend seller' }));
    await waitFor(() => expect(router.refresh).toHaveBeenCalledOnce());
    expect(call).toHaveBeenCalledWith(
      'POST',
      `identity/admin/sellers/${SELLER}/suspend`,
      { reason: 'Expired food licence.\nSend the new one.' },
      'csrf',
    );
    await expectToast('Seller suspended. Their team has been signed out.');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('sends nothing for an empty reason and marks the field', async () => {
    mount('approved');
    fireEvent.click(screen.getByRole('button', { name: 'Suspend…' }));
    fireEvent.change(dialog().getByLabelText('Reason for the seller'), {
      target: { value: '   ' },
    });
    fireEvent.click(dialog().getByRole('button', { name: 'Suspend seller' }));
    expect(await dialog().findByText('Give a reason for the suspension.')).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
    expect(dialog().getByLabelText('Reason for the seller').getAttribute('aria-invalid')).toBe(
      'true',
    );
  });

  it('shows a refused reason on the field and keeps the dialog open', async () => {
    call.mockResolvedValue({
      ok: false,
      failure: {
        status: 400,
        code: 'validation.failed',
        details: { fields: [{ path: 'reason', code: 'characters' }] },
      },
    });
    mount('approved');
    fireEvent.click(screen.getByRole('button', { name: 'Suspend…' }));
    fireEvent.change(dialog().getByLabelText('Reason for the seller'), {
      target: { value: 'Bad' },
    });
    fireEvent.click(dialog().getByRole('button', { name: 'Suspend seller' }));
    expect(await dialog().findByText(/Give a reason of 1 to 2000 characters/)).toBeTruthy();
    expect(router.refresh).not.toHaveBeenCalled();
    expectNoToast();
  });

  it('offers to read the page again when the state changed meanwhile', async () => {
    call.mockResolvedValue({
      ok: false,
      failure: { status: 409, code: 'seller-access.wrong-state' },
    });
    mount('approved');
    fireEvent.click(screen.getByRole('button', { name: 'Suspend…' }));
    fireEvent.change(dialog().getByLabelText('Reason for the seller'), {
      target: { value: 'Reason' },
    });
    fireEvent.click(dialog().getByRole('button', { name: 'Suspend seller' }));
    expect(
      await dialog().findByText("This seller's status changed after the page was opened."),
    ).toBeTruthy();
    fireEvent.click(dialog().getByRole('button', { name: 'Read the page again' }));
    expect(router.refresh).toHaveBeenCalledOnce();
  });

  it('sends a signed-out admin to the session-ended page', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    call.mockResolvedValue({ ok: false, failure: { status: 401, code: 'session.required' } });
    mount('approved');
    fireEvent.click(screen.getByRole('button', { name: 'Suspend…' }));
    fireEvent.change(dialog().getByLabelText('Reason for the seller'), {
      target: { value: 'Reason' },
    });
    fireEvent.click(dialog().getByRole('button', { name: 'Suspend seller' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/session-ended'));
    vi.unstubAllGlobals();
  });
});

describe('SellerAccessCard: lift suspension', () => {
  it('lifts a suspension after one confirmation, with an empty body', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: { code: 'seller-access.reinstated' } });
    mount('suspended');
    expect(screen.queryByRole('button', { name: 'Suspend…' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Lift suspension' }));
    expect(call).not.toHaveBeenCalled();
    expect(dialog().queryByLabelText('Reason for the seller')).toBeNull();
    fireEvent.click(dialog().getByRole('button', { name: 'Lift suspension' }));
    await waitFor(() => expect(router.refresh).toHaveBeenCalledOnce());
    expect(call).toHaveBeenCalledWith(
      'POST',
      `identity/admin/sellers/${SELLER}/reinstate`,
      {},
      'csrf',
    );
    await expectToast('Suspension lifted. The seller can sign in again.');
  });

  it('says so when the role lacks the key', async () => {
    call.mockResolvedValue({ ok: false, failure: { status: 403, code: 'access.denied' } });
    mount('suspended');
    fireEvent.click(screen.getByRole('button', { name: 'Lift suspension' }));
    fireEvent.click(dialog().getByRole('button', { name: 'Lift suspension' }));
    expect(
      await dialog().findByText("Your role can't suspend sellers or lift a suspension."),
    ).toBeTruthy();
    expect(router.refresh).not.toHaveBeenCalled();
  });
});

describe('accessProblemOf', () => {
  it.each([
    [{ status: 409, code: 'seller-access.wrong-state' }, 'wrong-state', true],
    [{ status: 404, code: 'seller.unknown' }, 'not-found', true],
    [{ status: 409, code: 'conflict.stale' }, 'retry', false],
    [{ status: 403, code: 'request.csrf' }, 'csrf', false],
    [{ status: 429, code: 'request.throttled' }, 'throttled', false],
    [{ status: 503, code: 'access.unavailable' }, 'unavailable', false],
    [{ status: 0, code: 'network' }, 'unavailable', false],
    [{ status: 400, code: 'validation.failed' }, 'invalid', false],
    [{ status: 500, code: 'internal' }, 'unknown', false],
  ])('maps %o to %s', (failure, key, reload) => {
    expect(accessProblemOf(failure)).toMatchObject({ key, reload });
  });

  it('has a message for every key it can return', () => {
    const errors = messages.sellers.access.error as Record<string, string>;
    for (const key of [
      'reason-required',
      'reason-invalid',
      'wrong-state',
      'not-found',
      'retry',
      'denied',
      'csrf',
      'throttled',
      'invalid',
      'unavailable',
      'unknown',
    ]) {
      expect(errors[key]).toBeTruthy();
    }
  });
});
