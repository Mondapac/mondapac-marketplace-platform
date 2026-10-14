// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { AcceptInvitationForm } from './accept-invitation-form.tsx';

const call = vi.mocked(callApi);

function mount() {
  return render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <AcceptInvitationForm passwordMin={15} passwordMax={128} />
    </NextIntlClientProvider>,
  );
}
const fail = (status: number, code: string, details?: object) => ({
  ok: false as const,
  failure: { status, code, ...(details ? { details } : {}) },
});
async function fillAndSubmit(name = ' Sam Seller ', password = 'a long password!!') {
  fireEvent.change(await screen.findByLabelText('Your name'), { target: { value: name } });
  fireEvent.change(screen.getByLabelText('New password'), { target: { value: password } });
  fireEvent.click(screen.getByRole('button', { name: 'Create my account' }));
}

beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState(null, '', '/accept-invitation#the-token');
});
afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

describe('seller accept invitation', () => {
  it('reads the token from the fragment, removes it and shows the password help', async () => {
    mount();
    await screen.findByLabelText('Your name');
    expect(window.location.hash).toBe('');
    expect(screen.getByText('Use 15 to 128 characters. A short sentence works well.')).toBeTruthy();
  });

  it('sends token, trimmed name and password, then points to sign-in', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: { code: 'invitation.accepted' } });
    mount();
    await fillAndSubmit();
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith('POST', 'identity/seller/accept-invitation', {
        token: 'the-token',
        displayName: 'Sam Seller',
        password: 'a long password!!',
      }),
    );
    expect(await screen.findByText('Your account is ready')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe('/sign-in');
  });

  it('asks for a name and a password before sending', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Create my account' }));
    expect(screen.getByText('Enter your name.')).toBeTruthy();
    expect(screen.getByText('Enter your password.')).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
  });

  it('gives one answer for a rejected invitation, and for a missing link', async () => {
    call.mockResolvedValue(fail(409, 'invitation.rejected'));
    mount();
    await fillAndSubmit();
    expect(await screen.findByText("This invitation can't be used")).toBeTruthy();
    cleanup();
    window.history.replaceState(null, '', '/accept-invitation');
    mount();
    expect(await screen.findByText("This invitation can't be used")).toBeTruthy();
  });

  it('shows the rule of a rejected password at the field', async () => {
    call.mockResolvedValue(fail(400, 'password.rejected', { rule: 'common' }));
    mount();
    await fillAndSubmit();
    expect(
      await screen.findByText('That password is too easy to guess. Choose a different one.'),
    ).toBeTruthy();
  });

  it('shows the wait when throttled, and a retry message when busy', async () => {
    call.mockResolvedValueOnce(fail(429, 'request.throttled', { retryAfterSeconds: 120 }));
    mount();
    await fillAndSubmit();
    expect(await screen.findByText('Too many attempts. Try again in 2 minutes.')).toBeTruthy();
    call.mockResolvedValueOnce(fail(503, 'request.busy'));
    fireEvent.click(screen.getByRole('button', { name: 'Create my account' }));
    expect(await screen.findByText("We're busy right now. Try again in a moment.")).toBeTruthy();
  });

  it('flags a name the API refuses', async () => {
    call.mockResolvedValue(
      fail(400, 'validation.failed', { fields: [{ path: 'displayName', code: 'characters' }] }),
    );
    mount();
    await fillAndSubmit();
    expect(
      await screen.findByText(
        'Remove web addresses and special formatting characters from the name.',
      ),
    ).toBeTruthy();
  });
});
