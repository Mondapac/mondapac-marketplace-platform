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
    // One guidance line, in a banner; no status help and no "Lost your phone?" section.
    expect(
      screen.getAllByText(/Ask an admin who manages Roles & permissions to send you a reset link/),
    ).toHaveLength(1);
    expect(screen.queryByRole('region', { name: 'Lost your phone?' })).toBeNull();
    expect(screen.queryByText(/cannot be turned off/)).toBeNull();
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

    expect(await screen.findByText('Step 1 of 2: Add the new key')).toBeTruthy();
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
    fireEvent.click(screen.getByRole('button', { name: 'Confirm replacement' }));
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
    expect(screen.queryByText('Step 1 of 2: Add the new key')).toBeNull();
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

  const START = {
    ok: true as const,
    status: 200,
    body: {
      code: 'second-factor-replacement-started',
      secret: 'JBSWY3DPEHPK3PXP',
      otpauthUri: URI,
    },
  };
  const toSecretStep = async () => {
    call.mockResolvedValueOnce(START);
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Replace authenticator' }));
    typeCode('123456');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByText('Step 1 of 2: Add the new key');
  };

  it('sends a 401 to the session-ended page', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    call.mockResolvedValueOnce({ ok: false, failure: { status: 401, code: 'session.invalid' } });
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Replace authenticator' }));
    typeCode('123456');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/session-ended'));
    vi.unstubAllGlobals();
  });

  it('shows the minutes to wait from retryAfterSeconds when throttled', async () => {
    call.mockResolvedValueOnce({
      ok: false,
      failure: { status: 429, code: 'request.throttled', details: { retryAfterSeconds: 150 } },
    });
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Replace authenticator' }));
    typeCode('123456');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText(/Try again in 3 minutes/)).toBeTruthy();
  });

  it('says nothing is waiting when confirm answers 409 second-factor.unavailable', async () => {
    await toSecretStep();
    call.mockResolvedValueOnce({
      ok: false,
      failure: { status: 409, code: 'second-factor.unavailable' },
    });
    typeCode('654321');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm replacement' }));
    expect(await screen.findByText(/Nothing is waiting to be confirmed/)).toBeTruthy();
  });

  it('cannot cancel while the request runs, so no secret appears after a cancel', async () => {
    let resolve: (value: typeof START) => void = () => {};
    call.mockReturnValueOnce(new Promise((done) => (resolve = done)));
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Replace authenticator' }));
    typeCode('123456');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    expect((cancel as HTMLButtonElement).disabled).toBe(true);
    resolve(START);
    await waitFor(() => expect(screen.queryByText('Step 1 of 2: Add the new key')).not.toBeNull());
  });

  it('sends the new CSRF token on the next call after the swap', async () => {
    await toSecretStep();
    call.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: { code: 'second-factor-replaced', csrfToken: 'fresh' },
    });
    typeCode('654321');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm replacement' }));
    await screen.findByText(/Your authenticator was replaced/);
    call.mockResolvedValueOnce({
      ok: false,
      failure: { status: 400, code: 'second-factor.invalid' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Replace authenticator' }));
    typeCode('111111');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(3));
    expect(call.mock.calls[2]?.[3]).toBe('fresh');
  });
});

describe('AccountSecurity focus and copy', () => {
  it('moves focus to the step heading, back to the code after a wrong code, and to the button on cancel', async () => {
    call.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: {
        code: 'second-factor-replacement-started',
        secret: 'JBSWY3DPEHPK3PXP',
        otpauthUri: URI,
      },
    });
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Replace authenticator' }));
    typeCode('123456');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    const heading = await screen.findByText('Step 1 of 2: Add the new key');
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(heading.getAttribute('tabindex')).toBe('-1');

    call.mockResolvedValueOnce({
      ok: false,
      failure: { status: 400, code: 'second-factor.invalid' },
    });
    typeCode('000000');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm replacement' }));
    await screen.findByText(/That code didn't work/);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Digit 1 of 6')));

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: 'Replace authenticator' }),
      ),
    );
  });

  it('moves focus to the success banner when the swap is done', async () => {
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
      body: { code: 'second-factor-replaced', csrfToken: 'n' },
    });
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Replace authenticator' }));
    typeCode('123456');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByText('Step 2 of 2: Confirm the code');
    typeCode('654321');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm replacement' }));
    const banner = await screen.findByText(/Your authenticator was replaced/);
    await waitFor(() => expect(document.activeElement).toBe(banner.closest('[tabindex="-1"]')));
  });

  it('announces a failed copy and labels the key by its caption', async () => {
    call.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: {
        code: 'second-factor-replacement-started',
        secret: 'JBSWY3DPEHPK3PXP',
        otpauthUri: URI,
      },
    });
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn(() => Promise.reject(new Error('denied'))) },
    });
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Replace authenticator' }));
    typeCode('123456');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByText('Step 1 of 2: Add the new key');
    expect(screen.getByText('JBSW Y3DP EHPK 3PXP').getAttribute('aria-labelledby')).toBe(
      'replace-key-label',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Copy key' }));
    const status = await screen.findByText("Couldn't copy. Select the key and copy it manually.");
    expect(status.getAttribute('role')).toBe('status');
  });
});
