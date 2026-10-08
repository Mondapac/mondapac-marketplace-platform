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
  it('signs out with the CSRF token and goes to sign-in', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: {} });
    render(wrap(<UserMenu name="Sam" csrfToken="csrf-1" />));
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/sign-in?notice=signed-out'));
    expect(call).toHaveBeenCalledWith('POST', 'identity/seller/sign-out', {}, 'csrf-1');
  });

  it('treats an already ended session as signed out', async () => {
    call.mockResolvedValue({ ok: false, failure: { status: 401, code: 'session.invalid' } });
    render(wrap(<UserMenu name="Sam" csrfToken="csrf-1" />));
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(router.replace).toHaveBeenCalled());
  });

  it('stays and says so when sign-out failed', async () => {
    call.mockResolvedValue({ ok: false, failure: { status: 0, code: 'network' } });
    render(wrap(<UserMenu name="Sam" csrfToken="csrf-1" />));
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect((await screen.findByRole('alert')).textContent).toContain("couldn't sign you out");
    expect(router.replace).not.toHaveBeenCalled();
  });
});
