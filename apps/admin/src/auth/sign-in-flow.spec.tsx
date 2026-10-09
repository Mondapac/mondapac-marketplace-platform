// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

const router = { replace: vi.fn(), push: vi.fn(), refresh: vi.fn() };
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { SignInFlow } from './sign-in-flow.tsx';

const call = vi.mocked(callApi);
const wrap = (node: ReactNode) => (
  <NextIntlClientProvider locale="en-AU" messages={messages}>
    {node}
  </NextIntlClientProvider>
);

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

function signIn() {
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'a@example.com' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
}

describe('admin sign-in', () => {
  it('keeps the email, clears the password and says so after wrong credentials', async () => {
    call.mockResolvedValue({ ok: false, failure: { status: 401, code: 'credentials.invalid' } });
    render(wrap(<SignInFlow notice={null} />));
    signIn();
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Email or password is incorrect. Check both and try again.',
    );
    expect(screen.getByLabelText<HTMLInputElement>('Email').value).toBe('a@example.com');
    expect(screen.getByLabelText<HTMLInputElement>('Password').value).toBe('');
  });

  it('offers no "keep me signed in" and no sign-up link', () => {
    render(wrap(<SignInFlow notice={null} />));
    expect(screen.queryByText(/keep me signed in/i)).toBeNull();
    expect(screen.queryByText(/create/i)).toBeNull();
  });

  it('asks for the code after the password and signs in with it', async () => {
    call.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: { code: 'second-factor-required', challengeToken: 'tok' },
    });
    render(wrap(<SignInFlow notice={null} />));
    signIn();
    expect(await screen.findByText('Enter your 6-digit code')).toBeTruthy();
    expect(screen.queryByLabelText('Password')).toBeNull();
    call.mockResolvedValueOnce({ ok: true, status: 200, body: { code: 'signed-in' } });
    fireEvent.change(screen.getByLabelText('6-digit code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/'));
    expect(call).toHaveBeenLastCalledWith('POST', 'identity/admin/second-factor', {
      challengeToken: 'tok',
      code: '123456',
    });
  });

  it('shows a rejected code and switches to a backup code', async () => {
    call.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: { code: 'second-factor-required', challengeToken: 'tok' },
    });
    render(wrap(<SignInFlow notice={null} />));
    signIn();
    await screen.findByText('Enter your 6-digit code');
    call.mockResolvedValueOnce({
      ok: false,
      failure: { status: 400, code: 'second-factor.invalid' },
    });
    fireEvent.change(screen.getByLabelText('6-digit code'), { target: { value: '000000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByText(/That code didn't work/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Use a backup code instead' }));
    expect(screen.getByText('Enter a backup code')).toBeTruthy();
    expect(screen.getByLabelText('Backup code')).toBeTruthy();
  });

  it('goes back to the password step when the challenge ended', async () => {
    call.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: { code: 'second-factor-required', challengeToken: 'tok' },
    });
    render(wrap(<SignInFlow notice={null} />));
    signIn();
    await screen.findByText('Enter your 6-digit code');
    call.mockResolvedValueOnce({
      ok: false,
      failure: { status: 400, code: 'challenge.rejected' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByLabelText('Password')).toBeTruthy();
    expect(screen.getByText(/Too many wrong codes. Sign in again/)).toBeTruthy();
  });

  it('shows the pause and disables Sign in when the second factor is locked', async () => {
    call.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: { code: 'second-factor-required', challengeToken: 'tok' },
    });
    render(wrap(<SignInFlow notice={null} />));
    signIn();
    await screen.findByText('Enter your 6-digit code');
    call.mockResolvedValueOnce({
      ok: false,
      failure: { status: 429, code: 'second-factor.locked', details: { retryAfterSeconds: 86400 } },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByText(/paused for 24 hours/)).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Sign in' }).disabled).toBe(
        true,
      ),
    );
  });

  it('says a set-up link was mailed after a two-step reset', async () => {
    call.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: { code: 'second-factor-enrolment-required' },
    });
    render(wrap(<SignInFlow notice={null} />));
    signIn();
    expect(await screen.findByText(/We've sent a link to a@example.com/)).toBeTruthy();
  });

  it('disables Sign in while throttled and does not point at a reset link that is not there', async () => {
    call.mockResolvedValue({
      ok: false,
      failure: { status: 429, code: 'request.throttled', details: { retryAfterSeconds: 120 } },
    });
    render(wrap(<SignInFlow notice={null} />));
    signIn();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('2 minutes');
    expect(alert.textContent).not.toContain('reset your password');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Sign in' }).disabled).toBe(true);
  });

  it('removes spaces and hyphens from the code before sending it', async () => {
    call.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: { code: 'second-factor-required', challengeToken: 'tok' },
    });
    render(wrap(<SignInFlow notice={null} />));
    signIn();
    await screen.findByText('Enter your 6-digit code');
    call.mockResolvedValueOnce({ ok: true, status: 200, body: { code: 'signed-in' } });
    fireEvent.change(screen.getByLabelText('6-digit code'), { target: { value: '123 456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    await waitFor(() => expect(router.replace).toHaveBeenCalled());
    expect(call).toHaveBeenLastCalledWith('POST', 'identity/admin/second-factor', {
      challengeToken: 'tok',
      code: '123456',
    });
  });

  it('shows the notice banners and changes the title on the code step', async () => {
    call.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: { code: 'second-factor-required', challengeToken: 'tok' },
    });
    const view = render(wrap(<SignInFlow notice="account-ready" />));
    expect(screen.getByText('Your account is ready. Sign in.')).toBeTruthy();
    signIn();
    await screen.findByText('Enter your 6-digit code');
    expect(document.title).toBe('Two-step verification – Admin account – MondaPac');
    view.unmount();
  });
});
