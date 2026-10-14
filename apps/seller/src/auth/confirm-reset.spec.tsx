// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { ConfirmResetForm } from './confirm-reset-form.tsx';

const call = vi.mocked(callApi);
const mount = () =>
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <ConfirmResetForm />
    </NextIntlClientProvider>,
  );
const submit = () =>
  fireEvent.click(screen.getByRole('button', { name: 'Turn off two-step sign-in' }));

beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState(null, '', '/second-factor/confirm-reset#tok123');
});
afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

describe('ConfirmResetForm', () => {
  it('changes nothing until the owner presses the button, then sends the fragment token', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: { code: 'second-factor.reset' } });
    mount();
    expect(await screen.findByText(/signed out everywhere/)).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
    expect(window.location.hash).toBe('');
    submit();
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(call).toHaveBeenCalledWith('POST', 'identity/seller/second-factor/reset/confirm', {
      token: 'tok123',
    });
    expect(await screen.findByText('Two-step sign-in is off')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to sign in' }).getAttribute('href')).toBe(
      '/sign-in',
    );
  });

  it('shows one answer for every unusable link', async () => {
    call.mockResolvedValue({ ok: false, failure: { status: 400, code: 'link.rejected' } });
    mount();
    submit();
    expect(await screen.findByText("This link can't be used")).toBeTruthy();
    expect(screen.getByText(/Ask MondaPac support to send a new one/)).toBeTruthy();
  });

  it('says the link cannot be used when there is no fragment', async () => {
    window.history.replaceState(null, '', '/second-factor/confirm-reset');
    mount();
    expect(await screen.findByText("This link can't be used")).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('blocks the button while throttled and shows the wait', async () => {
    call.mockResolvedValue({
      ok: false,
      failure: { status: 429, code: 'request.throttled', details: { retryAfterSeconds: 120 } },
    });
    mount();
    submit();
    expect(await screen.findByText('Too many attempts. Try again in 2 minutes.')).toBeTruthy();
    const button = screen.getByRole<HTMLButtonElement>('button', {
      name: 'Turn off two-step sign-in',
    });
    expect(button.disabled).toBe(true);
  });

  it('treats a malformed token as an unusable link', async () => {
    call.mockResolvedValue({ ok: false, failure: { status: 400, code: 'validation.failed' } });
    mount();
    submit();
    expect(await screen.findByText("This link can't be used")).toBeTruthy();
  });

  it('sends one request for a double press, and keeps the form after a server error', async () => {
    let answer: (value: unknown) => void = () => undefined;
    call.mockReturnValue(new Promise((resolve) => (answer = resolve)) as never);
    mount();
    submit();
    submit();
    expect(call).toHaveBeenCalledTimes(1);
    answer({ ok: false, failure: { status: 500, code: 'internal' } });
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Turn off two-step sign-in' })).toBeTruthy();
  });

  it('shows a network failure and keeps the form', async () => {
    call.mockResolvedValue({ ok: false, failure: { status: 0, code: 'network' } });
    mount();
    submit();
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Turn off two-step sign-in' })).toBeTruthy();
  });
});
