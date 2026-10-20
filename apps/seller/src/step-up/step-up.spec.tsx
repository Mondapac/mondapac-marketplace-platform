// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi, type ApiResult } from '../api/client.ts';
import { StepUpProvider, STEP_UP_CANCELLED, useGuardedCall } from './step-up.tsx';

const call = vi.mocked(callApi);
const PATH = 'identity/seller/team/accounts/0190a000-0000-7000-8000-000000000001/remove';
const VERIFY = 'identity/seller/step-up/verify';

const refused = (status: number, code: string, details?: object) => ({
  ok: false as const,
  failure: { status, code, ...(details ? { details } : {}) },
});
const required = (actionKey = 'identity.team.invite-remove') =>
  refused(403, 'second-factor.required', { actionKey });
const done = { ok: true as const, status: 200, body: { code: 'done' } };
const verified = { ok: true as const, status: 200, body: { code: 'step-up-verified' } };

/** A screen that runs one guarded call and prints what came back. */
function Probe() {
  const guarded = useGuardedCall();
  const [answer, setAnswer] = useState<string>('');
  return (
    <>
      <button
        type="button"
        onClick={() =>
          void guarded('POST', PATH, {}, 'csrf-1').then((result: ApiResult<unknown>) =>
            setAnswer(result.ok ? 'ok' : result.failure.code),
          )
        }
      >
        Run
      </button>
      <output>{answer}</output>
    </>
  );
}

function show(withProvider = true) {
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      {withProvider ? (
        <StepUpProvider>
          <Probe />
        </StepUpProvider>
      ) : (
        <Probe />
      )}
    </NextIntlClientProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Run' }));
}

const answer = () => screen.getByRole('status');
const boxes = () => screen.getAllByRole('textbox', { name: /Digit \d of 6/ });
function typeCode(code: string) {
  fireEvent.paste(boxes()[0] as HTMLElement, { clipboardData: { getData: () => code } });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useRealTimers();
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});
afterEach(cleanup);

describe('step-up code dialog', () => {
  it('asks for a code naming the action, verifies it for that action, then repeats the request', async () => {
    call.mockResolvedValueOnce(required()).mockResolvedValueOnce(verified);
    call.mockResolvedValueOnce(done);
    show();
    const dialog = await screen.findByRole('dialog', { name: 'Enter your 6-digit code' });
    expect(dialog.textContent).toContain('Inviting or removing a team member needs a fresh code');
    typeCode('123 456');
    await waitFor(() => expect(answer().textContent).toBe('ok'));
    expect(call.mock.calls).toEqual([
      ['POST', PATH, {}, 'csrf-1'],
      ['POST', VERIFY, { actionKey: 'identity.team.invite-remove', code: '123456' }, 'csrf-1'],
      ['POST', PATH, {}, 'csrf-1'],
    ]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('hands a failed repeat back to the screen, which shows its own error', async () => {
    call.mockResolvedValueOnce(required()).mockResolvedValueOnce(verified);
    call.mockResolvedValueOnce(refused(409, 'conflict.stale'));
    show();
    await screen.findByRole('dialog');
    typeCode('123456');
    await waitFor(() => expect(answer().textContent).toBe('conflict.stale'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('clears the boxes and refocuses on a wrong code, and repeats nothing', async () => {
    call
      .mockResolvedValueOnce(required())
      .mockResolvedValueOnce(refused(400, 'second-factor.invalid'));
    show();
    await screen.findByRole('dialog');
    typeCode('111111');
    expect(await screen.findByText(/That code didn't work/)).toBeTruthy();
    expect(boxes().every((box) => (box as HTMLInputElement).value === '')).toBe(true);
    expect(document.activeElement).toBe(boxes()[0]);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('counts down a lock-out with the boxes read-only and Verify off', async () => {
    call
      .mockResolvedValueOnce(required())
      .mockResolvedValueOnce(refused(429, 'second-factor.locked', { retryAfterSeconds: 90 }));
    show();
    await screen.findByRole('dialog');
    vi.useFakeTimers({ shouldAdvanceTime: true });
    typeCode('111111');
    const banner = await screen.findByText(
      /Too many tries\. You can try again in about 2 minutes\./,
    );
    expect(banner.textContent).toContain('(1:30 left)');
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' })),
    );
    expect(boxes().every((box) => (box as HTMLInputElement).readOnly)).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Verify' }).disabled).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(91_000);
    });
    expect(screen.queryByText(/Too many tries/)).toBeNull();
    expect(boxes().every((box) => !(box as HTMLInputElement).readOnly)).toBe(true);
  });

  it('never sends part of an app code', async () => {
    call.mockResolvedValueOnce(required());
    show();
    await screen.findByRole('dialog');
    typeCode('123');
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByText('Enter all 6 digits.')).toBeTruthy();
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('names no action from a key that is not action-shaped', async () => {
    call.mockResolvedValueOnce(required('identity'));
    show();
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('This action needs a fresh code');
  });

  it('takes a backup code, with spaces and hyphens removed', async () => {
    call.mockResolvedValueOnce(required()).mockResolvedValueOnce(verified);
    call.mockResolvedValueOnce(done);
    show();
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Use a backup code instead' }));
    expect(screen.getByRole('dialog', { name: 'Enter a backup code' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Backup code'), { target: { value: 'AAAAA-BBBBB' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    await waitFor(() => expect(answer().textContent).toBe('ok'));
    expect(call.mock.calls[1]).toEqual([
      'POST',
      VERIFY,
      { actionKey: 'identity.team.invite-remove', code: 'AAAAABBBBB' },
      'csrf-1',
    ]);
  });

  it('answers cancelled when closed, and repeats nothing', async () => {
    call.mockResolvedValueOnce(required('identity.team.change-role'));
    show();
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain("Changing a team member's role");
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(answer().textContent).toBe(STEP_UP_CANCELLED));
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('sends a member without two-step to Security', async () => {
    call.mockResolvedValueOnce(
      refused(403, 'second-factor.enrolment-required', { actionKey: 'catalog.offer.delete' }),
    );
    show();
    const dialog = await screen.findByRole('dialog', { name: 'Set up two-step first' });
    expect(dialog.textContent).toContain('Deleting an offer needs a code');
    expect(screen.getByRole('link', { name: 'Go to Security' }).getAttribute('href')).toBe(
      '/account/security',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(answer().textContent).toBe(STEP_UP_CANCELLED));
  });

  it('keeps the dialog open with a message when the check cannot be reached', async () => {
    call.mockResolvedValueOnce(required()).mockResolvedValueOnce(refused(0, 'network'));
    show();
    await screen.findByRole('dialog');
    typeCode('123456');
    expect(await screen.findByText(/You're offline/)).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('passes every other answer through untouched', async () => {
    call.mockResolvedValueOnce(refused(403, 'access.denied'));
    show();
    await waitFor(() => expect(answer().textContent).toBe('access.denied'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('outside the provider the call goes as it is', async () => {
    call.mockResolvedValueOnce(required());
    show(false);
    await waitFor(() => expect(answer().textContent).toBe('second-factor.required'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
