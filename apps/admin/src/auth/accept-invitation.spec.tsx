// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

const router = { replace: vi.fn(), push: vi.fn(), refresh: vi.fn() };
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { AcceptInvitationFlow } from './accept-invitation-flow.tsx';

const call = vi.mocked(callApi);
const enrolment = {
  ok: true as const,
  status: 200,
  body: {
    code: 'invitation.enrolment-ready',
    secret: 'ABCDEFGHIJKLMNOP',
    otpauthUri: 'otpauth://totp/MondaPac?secret=ABCDEFGHIJKLMNOP',
    tag: 'tag-1',
    expiresAt: '2026-10-09T14:00:00Z',
  },
};
const codes = ['AAAAA-BBBBB', 'CCCCC-DDDDD'];

function mount() {
  return render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <AcceptInvitationFlow passwordMin={12} passwordMax={128} />
    </NextIntlClientProvider>,
  );
}

function fail(code: string, details?: object) {
  return { ok: false as const, failure: { status: 400, code, ...(details ? { details } : {}) } };
}

async function fillDetails() {
  fireEvent.change(await screen.findByLabelText('Your name'), { target: { value: ' Jo Admin ' } });
  fireEvent.change(screen.getByLabelText('New password'), {
    target: { value: 'a long password!' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
}

beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState(null, '', '/accept-invitation#the-token');
});
afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

describe('admin accept invitation', () => {
  it('takes the token from the fragment, removes it from the address bar and shows the key', async () => {
    call.mockResolvedValueOnce(enrolment);
    mount();
    await fillDetails();
    expect(await screen.findByText('ABCD EFGH IJKL MNOP')).toBeTruthy();
    expect(call).toHaveBeenCalledWith('POST', 'identity/admin/invitation/enrolment', {
      token: 'the-token',
    });
    expect(window.location.hash).toBe('');
  });

  it('shows "not usable" for a missing token and calls nothing', async () => {
    window.history.replaceState(null, '', '/accept-invitation');
    mount();
    expect(await screen.findByText("This invitation can't be used")).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
  });

  it('shows "not usable" when the invitation is rejected', async () => {
    call.mockResolvedValueOnce(fail('invitation.rejected'));
    mount();
    await fillDetails();
    expect(await screen.findByText("This invitation can't be used")).toBeTruthy();
  });

  it('asks for a name and a password before any request', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('Enter your name.')).toBeTruthy();
    expect(screen.getByText('Enter your password.')).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
  });

  it('accepts with the secret parts and the code, then shows the codes behind a checkbox', async () => {
    call.mockResolvedValueOnce(enrolment);
    call.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: { code: 'invitation.accepted', recoveryCodes: codes },
    });
    mount();
    await fillDetails();
    fireEvent.change(await screen.findByLabelText('6-digit code'), {
      target: { value: '123 456' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByText('AAAAA-BBBBB')).toBeTruthy();
    expect(call).toHaveBeenLastCalledWith('POST', 'identity/admin/invitation/accept', {
      token: 'the-token',
      displayName: 'Jo Admin',
      password: 'a long password!',
      secret: 'ABCDEFGHIJKLMNOP',
      tag: 'tag-1',
      expiresAt: '2026-10-09T14:00:00Z',
      code: '123456',
    });
    const next = screen.getByRole('button', { name: 'Continue to sign in' });
    expect((next as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("I've saved these codes"));
    fireEvent.click(next);
    expect(router.replace).toHaveBeenCalledWith('/sign-in?notice=account-ready');
  });

  it('shows a wrong code on the code field and keeps the key', async () => {
    call.mockResolvedValueOnce(enrolment);
    call.mockResolvedValueOnce(fail('second-factor.invalid'));
    mount();
    await fillDetails();
    fireEvent.change(await screen.findByLabelText('6-digit code'), { target: { value: '000000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByText(/That code didn't work/)).toBeTruthy();
    expect(screen.getByText('ABCD EFGH IJKL MNOP')).toBeTruthy();
  });

  it('fetches a new key when the old one expired and says so', async () => {
    call.mockResolvedValueOnce(enrolment);
    call.mockResolvedValueOnce(fail('invitation.enrolment-expired'));
    call.mockResolvedValueOnce({
      ...enrolment,
      body: { ...enrolment.body, secret: 'ZZZZYYYYXXXXWWWW', tag: 'tag-2' },
    });
    mount();
    await fillDetails();
    fireEvent.change(await screen.findByLabelText('6-digit code'), { target: { value: '111111' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByText('ZZZZ YYYY XXXX WWWW')).toBeTruthy();
    expect(screen.getByText(/That setup key expired/)).toBeTruthy();
  });

  it('goes back to the details with the password rule when the password is refused', async () => {
    call.mockResolvedValueOnce(enrolment);
    call.mockResolvedValueOnce(fail('password.rejected', { rule: 'common' }));
    mount();
    await fillDetails();
    fireEvent.change(await screen.findByLabelText('6-digit code'), { target: { value: '111111' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByText(/That password is too easy to guess/)).toBeTruthy();
    expect(screen.getByLabelText('Your name')).toBeTruthy();
  });

  it('sends one accept request for a double click', async () => {
    call.mockResolvedValueOnce(enrolment);
    let release: (value: ReturnType<typeof fail>) => void = () => undefined;
    call.mockImplementationOnce(
      () => new Promise((resolve) => (release = resolve as typeof release)),
    );
    mount();
    await fillDetails();
    fireEvent.change(await screen.findByLabelText('6-digit code'), { target: { value: '111111' } });
    const verify = screen.getByRole('button', { name: 'Verify' });
    fireEvent.click(verify);
    fireEvent.click(verify);
    release(fail('second-factor.invalid'));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(2));
  });

  it('keeps the token, the secret and the codes out of storage and the address bar', async () => {
    call.mockResolvedValueOnce(enrolment);
    call.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: { code: 'invitation.accepted', recoveryCodes: codes },
    });
    mount();
    await fillDetails();
    fireEvent.change(await screen.findByLabelText('6-digit code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    await screen.findByText('AAAAA-BBBBB');
    const stored = JSON.stringify({ ...localStorage, ...sessionStorage });
    for (const secret of ['the-token', 'ABCDEFGHIJKLMNOP', 'AAAAA-BBBBB', 'a long password!'])
      expect(stored).not.toContain(secret);
    expect(window.location.href).not.toContain('the-token');
  });
});
