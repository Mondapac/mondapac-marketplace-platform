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
import { SignInForm } from './sign-in-form.tsx';
import { UserMenu } from './user-menu.tsx';

const call = vi.mocked(callApi);
const wrap = (node: ReactNode) => (
  <NextIntlClientProvider locale="en-AU" messages={messages}>
    {node}
  </NextIntlClientProvider>
);

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
});
afterEach(cleanup);

function fillSignIn(email: string, password: string) {
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: email } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: password } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
}

describe('SignInForm second step', () => {
  it('asks for the code after the password and signs in with it', async () => {
    call
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: { code: 'second-factor-required', challengeToken: 'chal' },
      })
      .mockResolvedValueOnce({ ok: true, status: 200, body: { code: 'signed-in' } });
    render(wrap(<SignInForm notice={null} />));
    fireEvent.click(screen.getByLabelText('Keep me signed in on this device'));
    fillSignIn('a@example.com', 'right password');
    expect(await screen.findByText('Enter your 6-digit code')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('6-digit code'), { target: { value: '123 456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/'));
    expect(call).toHaveBeenLastCalledWith('POST', 'identity/seller/sign-in/second-factor', {
      challengeToken: 'chal',
      code: '123456',
      keepSignedIn: true,
    });
  });

  it('goes back to the password step when the challenge has ended', async () => {
    call
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: { code: 'second-factor-required', challengeToken: 'chal' },
      })
      .mockResolvedValueOnce({ ok: false, failure: { status: 400, code: 'challenge.rejected' } });
    render(wrap(<SignInForm notice={null} />));
    fillSignIn('a@example.com', 'right password');
    await screen.findByText('Enter your 6-digit code');
    fireEvent.change(screen.getByLabelText('6-digit code'), { target: { value: '000000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Too many wrong codes. Sign in again to try once more.',
    );
    expect(screen.getByLabelText('Email')).toBeTruthy();
  });

  it('keeps the code step on a wrong code and offers a backup code', async () => {
    call
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: { code: 'second-factor-required', challengeToken: 'chal' },
      })
      .mockResolvedValueOnce({
        ok: false,
        failure: { status: 400, code: 'second-factor.invalid' },
      });
    render(wrap(<SignInForm notice={null} />));
    fillSignIn('a@example.com', 'right password');
    await screen.findByText('Enter your 6-digit code');
    fireEvent.change(screen.getByLabelText('6-digit code'), { target: { value: '111111' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      "That code didn't work. Enter the newest code from your app.",
    );
    fireEvent.click(screen.getByRole('button', { name: 'Use a backup code instead' }));
    expect(screen.getByLabelText('Backup code')).toBeTruthy();
  });
});

describe('SignInForm code step exit', () => {
  it('goes back to the password step with "Use a different account"', async () => {
    call.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: { code: 'second-factor-required', challengeToken: 'chal' },
    });
    render(wrap(<SignInForm notice={null} />));
    fillSignIn('a@example.com', 'right password');
    await screen.findByText('Enter your 6-digit code');
    fireEvent.click(screen.getByRole('button', { name: 'Use a different account' }));
    expect(screen.getByLabelText('Email')).toBeTruthy();
  });
});

describe('SignInForm', () => {
  it('keeps the email, clears the password and says so after wrong credentials', async () => {
    call.mockResolvedValue({ ok: false, failure: { status: 401, code: 'credentials.invalid' } });
    render(wrap(<SignInForm notice={null} />));
    fillSignIn('a@example.com', 'wrong');
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Email or password is incorrect. Check both and try again.',
    );
    expect(screen.getByLabelText<HTMLInputElement>('Email').value).toBe('a@example.com');
    expect(screen.getByLabelText<HTMLInputElement>('Password').value).toBe('');
  });

  it('disables submit while throttled and points to the reset link', async () => {
    call.mockResolvedValue({
      ok: false,
      failure: { status: 429, code: 'request.throttled', details: { retryAfterSeconds: 120 } },
    });
    render(wrap(<SignInForm notice={null} />));
    fillSignIn('a@example.com', 'x');
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('2 minutes');
    expect(alert.textContent).toContain('You can still reset your password.');
    const submit = screen.getByRole<HTMLButtonElement>('button', { name: 'Sign in' });
    expect(submit.disabled).toBe(true);
  });

  it('sends an unverified account to the check-email page', async () => {
    call.mockResolvedValue({
      ok: false,
      failure: { status: 403, code: 'email-verification-required' },
    });
    render(wrap(<SignInForm notice={null} />));
    fillSignIn('a@example.com', 'secret');
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/check-email?from=sign-in'));
  });

  it('goes home after a successful sign-in', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: { code: 'signed-in' } });
    render(wrap(<SignInForm notice={null} />));
    fillSignIn('a@example.com', 'secret');
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/'));
  });

  it('focuses the first invalid field after a validation failure', async () => {
    call.mockResolvedValue({
      ok: false,
      failure: {
        status: 400,
        code: 'validation.failed',
        details: { fields: [{ path: 'email', code: 'required' }] },
      },
    });
    render(wrap(<SignInForm notice={null} />));
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    const field = await screen.findByLabelText('Email');
    await waitFor(() => expect(document.activeElement).toBe(field));
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(field.getAttribute('aria-describedby')).toBeTruthy();
  });

  it('shows the notice it was given', () => {
    render(wrap(<SignInForm notice="session-ended" />));
    expect(screen.getByRole('status').textContent).toBe(
      'Your session has ended. Sign in again to continue.',
    );
  });
});

describe('UserMenu', () => {
  const menu = (approved = true) => (
    <UserMenu
      name="Sam Lee"
      email="sam@example.test"
      theme="system"
      approved={approved}
      csrfToken="csrf-1"
    />
  );
  const open = () =>
    fireEvent.click(screen.getByRole('button', { name: 'Account menu for Sam Lee' }));

  it('shows who is signed in, their pages and the theme once opened', () => {
    render(wrap(menu()));
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
    open();
    expect(screen.getByText('sam@example.test')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'My profile' }).getAttribute('href')).toBe(
      '/account/profile',
    );
    expect(screen.getByRole('link', { name: 'Security' }).getAttribute('href')).toBe(
      '/account/security',
    );
    expect(screen.getByRole('radio', { name: 'System' }).getAttribute('aria-checked')).toBe('true');
  });

  it('leaves Security out until the seller is approved', () => {
    render(wrap(menu(false)));
    open();
    expect(screen.queryByRole('link', { name: 'Security' })).toBeNull();
  });

  it('closes on Escape and returns focus to the avatar', () => {
    render(wrap(menu()));
    open();
    fireEvent.keyDown(screen.getByRole('link', { name: 'My profile' }), { key: 'Escape' });
    expect(screen.queryByRole('link', { name: 'My profile' })).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Account menu for Sam Lee' }),
    );
  });

  it('signs out with the CSRF token and goes to sign-in', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: {} });
    render(wrap(menu()));
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/sign-in?notice=signed-out'));
    expect(call).toHaveBeenCalledWith('POST', 'identity/seller/sign-out', {}, 'csrf-1');
  });

  it('treats an already ended session as signed out', async () => {
    call.mockResolvedValue({ ok: false, failure: { status: 401, code: 'session.invalid' } });
    render(wrap(menu()));
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(router.replace).toHaveBeenCalled());
  });

  it('stays and says so when sign-out failed', async () => {
    call.mockResolvedValue({ ok: false, failure: { status: 0, code: 'network' } });
    render(wrap(menu()));
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect((await screen.findByRole('alert')).textContent).toContain("couldn't sign you out");
    expect(router.replace).not.toHaveBeenCalled();
  });
});
