// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

const router = { replace: vi.fn(), push: vi.fn(), refresh: vi.fn() };
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { TwoStepPanel } from './two-step-panel.tsx';

const call = vi.mocked(callApi);
const panel = (active: boolean) => (
  <NextIntlClientProvider locale="en-AU" messages={messages}>
    <TwoStepPanel active={active} csrfToken="csrf-1" />
  </NextIntlClientProvider>
);
const type = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('TwoStepPanel', () => {
  it('turns two-step on: password, key and first code, then backup codes shown once', async () => {
    call
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: {
          code: 'second-factor-enrolment-started',
          challengeToken: 'chal',
          secret: 'ABCDEFGHIJKLMNOP',
          otpauthUri: 'otpauth://totp/MondaPac:a@example.com?secret=ABCDEFGHIJKLMNOP',
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: { code: 'second-factor-activated', recoveryCodes: ['AAAAA-BBBBB', 'CCCCC-DDDDD'] },
      });
    render(panel(false));
    expect(screen.getByRole('status').textContent).toBe('Two-step verification is off.');
    fireEvent.click(screen.getByRole('button', { name: 'Turn on' }));
    type('Password', 'a long enough password');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByTestId('setup-qr')).toBeTruthy();
    expect(call).toHaveBeenNthCalledWith(
      1,
      'POST',
      'identity/seller/second-factor/enrolment',
      { password: 'a long enough password' },
      'csrf-1',
    );
    expect(screen.getByText('ABCD EFGH IJKL MNOP')).toBeTruthy();
    type('6-digit code', '123 456');
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByText('AAAAA-BBBBB')).toBeTruthy();
    expect(call).toHaveBeenNthCalledWith(
      2,
      'POST',
      'identity/seller/second-factor/enrolment/confirm',
      { challengeToken: 'chal', code: '123456' },
      'csrf-1',
    );
    const next = screen.getByRole('button', { name: 'Continue to sign in' });
    expect((next as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("I've saved these codes"));
    fireEvent.click(next);
    expect(router.replace).toHaveBeenCalledWith('/sign-in?notice=two-step-enabled');
  });

  it('says a wrong password on the form and stays on it', async () => {
    call.mockResolvedValue({
      ok: false,
      failure: { status: 400, code: 'password.current-incorrect' },
    });
    render(panel(false));
    fireEvent.click(screen.getByRole('button', { name: 'Turn on' }));
    type('Password', 'wrong');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect((await screen.findByRole('alert')).textContent).toBe('That password is incorrect.');
    expect(screen.getByLabelText<HTMLInputElement>('Password').value).toBe('');
  });

  it('goes back to the password with a message when the enrolment challenge ended', async () => {
    call
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: { code: 'x', challengeToken: 'c', secret: 'ABCD', otpauthUri: 'otpauth://x' },
      })
      .mockResolvedValueOnce({ ok: false, failure: { status: 400, code: 'challenge.rejected' } });
    render(panel(false));
    fireEvent.click(screen.getByRole('button', { name: 'Turn on' }));
    type('Password', 'a long enough password');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByTestId('setup-qr');
    type('6-digit code', '123456');
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Setup timed out. Enter your password to start again.',
    );
    expect(screen.getByLabelText('Password')).toBeTruthy();
  });

  it('turns two-step off with a code, and refreshes the page', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: { code: 'second-factor-removed' } });
    render(panel(true));
    expect(screen.getByRole('status').textContent).toBe('Two-step verification is on.');
    fireEvent.click(screen.getByRole('button', { name: 'Turn off' }));
    type('Code', '654321');
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
    expect(call).toHaveBeenCalledWith(
      'POST',
      'identity/seller/second-factor/remove',
      { code: '654321' },
      'csrf-1',
    );
    expect(screen.getByText(/Two-step verification is off/)).toBeTruthy();
  });

  it('shows new backup codes once and returns to the status after them', async () => {
    call.mockResolvedValue({
      ok: true,
      status: 200,
      body: { code: 'recovery-codes-regenerated', recoveryCodes: ['EEEEE-FFFFF'] },
    });
    render(panel(true));
    fireEvent.click(screen.getByRole('button', { name: 'Get new backup codes' }));
    type('Code', '654321');
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByText('EEEEE-FFFFF')).toBeTruthy();
    fireEvent.click(screen.getByLabelText("I've saved these codes"));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.getByRole('status').textContent).toBe('Two-step verification is on.');
  });
});
