// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { STEP_UP_CANCELLED } from '../step-up/step-up.tsx';
import { SettingsForm } from './settings-form.tsx';
import type { WalletSettings } from './types.ts';
import { expectToast } from '../../test/toast-spy.ts';

const call = vi.mocked(callApi);
const settings = (over: Partial<WalletSettings> = {}): WalletSettings => ({
  status: 'off',
  reason: null,
  updatedAt: null,
  version: 0,
  ...over,
});
const ok = (body: unknown) => ({ ok: true as const, status: 200, body });
const refused = (status: number, code: string) => ({
  ok: false as const,
  failure: { status, code },
});

function mount(canManage = true) {
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <SettingsForm canManage={canManage} csrfToken="csrf" />
    </NextIntlClientProvider>,
  );
}
const choose = (state: string) =>
  fireEvent.change(screen.getByLabelText('New state'), { target: { value: state } });
const review = () => fireEvent.click(screen.getByRole('button', { name: 'Review change' }));
const confirmDialog = (name: string) => screen.findByRole('dialog', { name });

beforeEach(() => {
  vi.resetAllMocks();
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute('open');
  };
});
afterEach(cleanup);

describe('SettingsForm', () => {
  it('shows a loading state, then a never-changed Off wallet and the meaning of every state', async () => {
    call.mockResolvedValue(ok(settings()));
    mount();
    expect(screen.getByText('Loading')).toBeTruthy();
    expect(await screen.findByText('Never changed')).toBeTruthy();
    expect(call).toHaveBeenCalledWith('GET', 'wallet/admin/settings');
    expect(screen.getAllByText('Off').length).toBeGreaterThan(0);
    expect(screen.getByText(/Like paused, but for a security or legal problem/)).toBeTruthy();
  });

  it('shows the change time and reason of a paused wallet', async () => {
    call.mockResolvedValue(
      ok(
        settings({
          status: 'paused',
          reason: 'maintenance',
          updatedAt: '2026-10-01T02:30:00.000Z',
        }),
      ),
    );
    mount();
    expect(await screen.findByText('Changed 1 Oct 2026, 2:30 am UTC')).toBeTruthy();
    expect(screen.getByText('Reason: Maintenance')).toBeTruthy();
    expect(screen.getByText('Paused', { selector: 'span' })).toBeTruthy();
  });

  it('shows a load error with a retry that loads again', async () => {
    call.mockResolvedValueOnce(refused(503, 'access.unavailable'));
    call.mockResolvedValueOnce(ok(settings()));
    mount();
    expect(await screen.findByRole('alert')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Never changed')).toBeTruthy();
  });

  it('leaves the change card out for a view-only admin', async () => {
    call.mockResolvedValue(ok(settings()));
    mount(false);
    await screen.findByText('Never changed');
    expect(screen.queryByLabelText('New state')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Review change' })).toBeNull();
  });

  it('keeps Review off until the state differs and a required reason is chosen', async () => {
    call.mockResolvedValue(
      ok(settings({ status: 'active', updatedAt: '2026-10-01T00:00:00.000Z' })),
    );
    mount();
    await screen.findByText('Changed 1 Oct 2026, 12:00 am UTC');
    const button = screen.getByRole<HTMLButtonElement>('button', { name: 'Review change' });
    expect(button.disabled).toBe(true);
    expect(screen.getByRole('option', { name: 'Active (current)' })).toBeTruthy();
    choose('paused');
    expect(screen.getByLabelText('Reason')).toBeTruthy();
    expect(button.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'maintenance' } });
    expect(button.disabled).toBe(false);
    choose('off');
    expect(screen.queryByLabelText('Reason')).toBeNull();
  });

  it('confirms a pause with its reason, then sends it and shows the new state', async () => {
    call.mockResolvedValueOnce(
      ok(settings({ status: 'active', updatedAt: '2026-10-01T00:00:00.000Z' })),
    );
    mount();
    await screen.findByText(/Changed/);
    choose('paused');
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'maintenance' } });
    review();
    const dialog = await confirmDialog('Pause the wallet?');
    expect(dialog.textContent).toContain('Reason: Maintenance');
    call.mockResolvedValueOnce(
      ok(
        settings({
          status: 'paused',
          reason: 'maintenance',
          updatedAt: '2026-10-27T01:00:00.000Z',
        }),
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Pause wallet' }));
    await expectToast('Wallet is now paused.');
    expect(call).toHaveBeenLastCalledWith(
      'PUT',
      'wallet/admin/settings',
      { status: 'paused', reasonCode: 'maintenance', expectedVersion: 0 },
      'csrf',
    );
    expect(screen.getByText('Reason: Maintenance')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('has a confirm for frozen and off with their own words', async () => {
    call.mockResolvedValueOnce(
      ok(settings({ status: 'active', updatedAt: '2026-10-01T00:00:00.000Z' })),
    );
    mount();
    await screen.findByText(/Changed/);
    choose('frozen');
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'legal-hold' } });
    review();
    expect(await confirmDialog('Freeze the wallet?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    choose('off');
    review();
    const off = await confirmDialog('Turn the wallet off?');
    expect(off.textContent).toContain('use Paused instead');
  });

  it('applies Active without a confirm dialog', async () => {
    call.mockResolvedValueOnce(
      ok(
        settings({
          status: 'paused',
          reason: 'maintenance',
          updatedAt: '2026-10-01T00:00:00.000Z',
        }),
      ),
    );
    mount();
    await screen.findByText(/Changed/);
    choose('active');
    call.mockResolvedValueOnce(
      ok(settings({ status: 'active', updatedAt: '2026-10-27T01:00:00.000Z' })),
    );
    review();
    await expectToast('Wallet is now active.');
    expect(call).toHaveBeenLastCalledWith(
      'PUT',
      'wallet/admin/settings',
      { status: 'active', expectedVersion: 0 },
      'csrf',
    );
  });

  it.each([
    ['wallet.cannot-turn-off-with-history', 409, /Choose Paused instead/],
    ['wallet.busy', 409, /Another change is in progress/],
    ['access.denied', 403, /permission to change the wallet/],
    ['access.unavailable', 503, /We could not save the change/],
    ['something.else', 500, /Something went wrong/],
  ])('says what %s means', async (code, status, text) => {
    call.mockResolvedValueOnce(
      ok(settings({ status: 'active', updatedAt: '2026-10-01T00:00:00.000Z' })),
    );
    mount();
    await screen.findByText(/Changed/);
    choose('off');
    review();
    await confirmDialog('Turn the wallet off?');
    call.mockResolvedValueOnce(refused(status, code));
    fireEvent.click(screen.getByRole('button', { name: 'Turn off' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(text);
    // The state shown stays the one the server last told us.
    expect(screen.getByText('Changed 1 Oct 2026, 12:00 am UTC')).toBeTruthy();
  });

  it('sends the version it loaded, and on a conflict shows the banner, the current state and keeps the chosen one', async () => {
    call.mockResolvedValueOnce(
      ok(settings({ status: 'active', updatedAt: '2026-10-01T00:00:00.000Z', version: 3 })),
    );
    mount();
    await screen.findByText(/Changed/);
    choose('paused');
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'maintenance' } });
    review();
    await confirmDialog('Pause the wallet?');
    call.mockResolvedValueOnce(refused(409, 'wallet.settings-conflict'));
    // The reload after the conflict: another admin froze the wallet meanwhile.
    call.mockResolvedValueOnce(
      ok(
        settings({
          status: 'frozen',
          reason: 'legal-hold',
          updatedAt: '2026-10-02T00:00:00.000Z',
          version: 4,
        }),
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Pause wallet' }));
    expect(
      await screen.findByText('The wallet state changed while you were on this page'),
    ).toBeTruthy();
    expect(call).toHaveBeenNthCalledWith(
      2,
      'PUT',
      'wallet/admin/settings',
      { status: 'paused', reasonCode: 'maintenance', expectedVersion: 3 },
      'csrf',
    );
    expect(await screen.findByText('Reason: Legal hold')).toBeTruthy();
    expect(screen.getByLabelText<HTMLSelectElement>('New state').value).toBe('paused');
    expect(screen.getByLabelText<HTMLSelectElement>('Reason').value).toBe('maintenance');
    // The next save carries the new version and clears the banner.
    review();
    await confirmDialog('Pause the wallet?');
    call.mockResolvedValueOnce(
      ok(
        settings({
          status: 'paused',
          reason: 'maintenance',
          updatedAt: '2026-10-03T00:00:00.000Z',
          version: 5,
        }),
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Pause wallet' }));
    await expectToast('Wallet is now paused.');
    expect(call).toHaveBeenLastCalledWith(
      'PUT',
      'wallet/admin/settings',
      { status: 'paused', reasonCode: 'maintenance', expectedVersion: 4 },
      'csrf',
    );
    expect(screen.queryByText('The wallet state changed while you were on this page')).toBeNull();
  });

  it('puts a validation answer on the reason field', async () => {
    call.mockResolvedValueOnce(
      ok(settings({ status: 'active', updatedAt: '2026-10-01T00:00:00.000Z' })),
    );
    mount();
    await screen.findByText(/Changed/);
    choose('paused');
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'maintenance' } });
    review();
    await confirmDialog('Pause the wallet?');
    call.mockResolvedValueOnce(refused(400, 'validation.failed'));
    fireEvent.click(screen.getByRole('button', { name: 'Pause wallet' }));
    expect(await screen.findByText('Choose a reason for this state.')).toBeTruthy();
  });

  it('says nothing when the code dialog was cancelled', async () => {
    call.mockResolvedValueOnce(
      ok(settings({ status: 'active', updatedAt: '2026-10-01T00:00:00.000Z' })),
    );
    mount();
    await screen.findByText(/Changed/);
    choose('off');
    review();
    await confirmDialog('Turn the wallet off?');
    call.mockResolvedValueOnce({ ok: false, failure: { status: 0, code: STEP_UP_CANCELLED } });
    fireEvent.click(screen.getByRole('button', { name: 'Turn off' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/Wallet is now/)).toBeNull();
  });
});

describe('SettingsForm: unusual data from the server', () => {
  it('treats a wallet state it does not know as a load error', async () => {
    call.mockResolvedValue(ok({ status: 'short', reason: null, updatedAt: null, version: 0 }));
    mount();
    expect(await screen.findByRole('alert')).toBeTruthy();
  });

  it('shows a reason with dots as plain text', async () => {
    call.mockResolvedValue(
      ok(settings({ status: 'paused', reason: 'a.b', updatedAt: '2026-10-01T00:00:00.000Z' })),
    );
    mount();
    expect(await screen.findByText('Reason: a.b')).toBeTruthy();
  });
});
