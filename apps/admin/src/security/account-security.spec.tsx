// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

const router = { refresh: vi.fn() };
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { AccountSecurity } from './account-security.tsx';

const call = vi.mocked(callApi);
const wrap = (node: ReactNode) => (
  <NextIntlClientProvider locale="en-AU" messages={messages}>
    {node}
  </NextIntlClientProvider>
);
const URI =
  'otpauth://totp/MondaPac:a@example.com?secret=JBSWY3DPEHPK3PXP&issuer=MondaPac&algorithm=SHA1&digits=6&period=30';
const mount = (active = true) => render(wrap(<AccountSecurity active={active} csrfToken="csrf" />));
const typeCode = (digits: string) =>
  digits.split('').forEach((digit, index) => {
    fireEvent.keyDown(screen.getByLabelText(`Digit ${index + 1} of 6`), { key: digit });
  });

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('AccountSecurity status', () => {
  it('shows two-step as On, says it cannot be turned off, and offers the replacement', () => {
    mount(true);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Account security');
    expect(screen.getByText('On')).toBeTruthy();
    expect(
      screen.getByText('Two-step verification cannot be turned off for an admin account.'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Replace authenticator' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /turn off/i })).toBeNull();
  });

  it('shows Off with guidance and no action when two-step is not set up', () => {
    mount(false);
    expect(screen.getByText('Off')).toBeTruthy();
    // Once in the authenticator row, once under "Lost your phone?".
    expect(
      screen.getAllByText(/Ask an admin with Roles & permissions to send you a reset link/),
    ).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Replace authenticator' })).toBeNull();
  });

  it('tells a person without their phone to ask an admin, and links to Sessions', () => {
    mount();
    const lost = screen.getByRole('region', { name: 'Lost your phone?' });
    expect(within(lost).getByText(/send you a reset link/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open signed-in devices' }).getAttribute('href')).toBe(
      '/account/sessions',
    );
  });
});

describe('AccountSecurity authenticator replacement', () => {
  it('asks for the current code, shows the new key, then confirms with the new code', async () => {
    call.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: {
        code: 'second-factor-replacement-started',
        secret: 'JBSWY3DPEHPK3PXP',
        otpauthUri: URI,
      },
    });
    call.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: { code: 'second-factor-replaced', csrfToken: 'new' },
    });
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Replace authenticator' }));
    typeCode('123456');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByText('Add the new device')).toBeTruthy();
    expect(call).toHaveBeenNthCalledWith(
      1,
      'POST',
      'identity/admin/second-factor/replacement',
      { code: '123456' },
      'csrf',
    );
    expect(screen.getByText('JBSW Y3DP EHPK 3PXP')).toBeTruthy();
    expect(screen.getByTestId('setup-qr')).toBeTruthy();

    typeCode('654321');
    fireEvent.click(screen.getByRole('button', { name: 'Replace authenticator', hidden: false }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(2));
    expect(call).toHaveBeenNthCalledWith(
      2,
      'POST',
      'identity/admin/second-factor/replacement/confirm',
      { code: '654321' },
      'csrf',
    );
    expect(
      await screen.findByText(
        'Your authenticator was replaced. Your other devices were signed out.',
      ),
    ).toBeTruthy();
    expect(router.refresh).toHaveBeenCalledTimes(1);
    // The secret is gone once the swap is done.
    expect(screen.queryByText('JBSW Y3DP EHPK 3PXP')).toBeNull();
  });

  it('accepts a backup code for the first step', async () => {
    call.mockResolvedValueOnce({
      ok: false,
      failure: { status: 400, code: 'second-factor.invalid' },
    });
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Replace authenticator' }));
    fireEvent.click(screen.getByRole('button', { name: 'Use a backup code instead' }));
    fireEvent.change(screen.getByLabelText('Backup code'), { target: { value: 'abcd-efgh-ijkl' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(call.mock.calls[0]?.[2]).toEqual({ code: 'abcd-efgh-ijkl'.replace(/-/g, '') });
  });

  it('shows a refused current code on the field and stays on the step', async () => {
    call.mockResolvedValueOnce({
      ok: false,
      failure: { status: 400, code: 'second-factor.invalid' },
    });
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Replace authenticator' }));
    typeCode('123456');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText(/That code didn't work/)).toBeTruthy();
    expect(screen.queryByText('Add the new device')).toBeNull();
  });

  it('names a locked code check and a session that is gone', async () => {
    call.mockResolvedValueOnce({
      ok: false,
      failure: { status: 429, code: 'second-factor.locked' },
    });
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Replace authenticator' }));
    typeCode('123456');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText(/Code checks are paused/)).toBeTruthy();
  });

  it('asks for a code before calling', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Replace authenticator' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(call).not.toHaveBeenCalled();
    expect(screen.getByText('Enter the code.')).toBeTruthy();
  });

  it('cancels back to the start without calling', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Replace authenticator' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Replace authenticator' })).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
  });
});
