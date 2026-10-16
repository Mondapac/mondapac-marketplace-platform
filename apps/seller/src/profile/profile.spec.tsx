// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

const router = { refresh: vi.fn() };
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { DisplayNameCard } from './display-name-card.tsx';
import { nameProblemOf, passwordProblemOf } from './errors.ts';
import { PasswordCard } from './password-card.tsx';

const call = vi.mocked(callApi);
const wrap = (node: ReactNode) => (
  <NextIntlClientProvider locale="en-AU" messages={messages}>
    {node}
  </NextIntlClientProvider>
);
const LIMITS = { min: 15, max: 128 };
const NEW_PASSWORD = 'a long and easy sentence';

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('DisplayNameCard', () => {
  const mount = () => render(wrap(<DisplayNameCard initial="Amina Rahman" csrfToken="csrf" />));
  const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
  const typeName = (value: string) =>
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value } });

  it('shows the current name and saves a trimmed one, then refreshes the page', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: { changed: true } });
    mount();
    expect(screen.getByLabelText<HTMLInputElement>('Display name').value).toBe('Amina Rahman');

    typeName('  Amina R.  ');
    save();

    expect(await screen.findByText('Your name was updated.')).toBeTruthy();
    expect(call).toHaveBeenCalledWith(
      'PUT',
      'identity/seller/profile/display-name',
      { displayName: 'Amina R.' },
      'csrf',
    );
    expect(screen.getByLabelText<HTMLInputElement>('Display name').value).toBe('Amina R.');
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it('says so when the name did not change, without refreshing', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: { changed: false } });
    mount();
    save();
    expect(await screen.findByText('That is already your name.')).toBeTruthy();
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it('refuses an empty or too long name before calling the API', () => {
    mount();
    typeName('   ');
    save();
    expect(screen.getByText('Enter a name of 1 to 100 characters.')).toBeTruthy();
    typeName('x'.repeat(101));
    save();
    expect(screen.getByText('Enter a name of 1 to 100 characters.')).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
  });

  it('puts the API refusal under the field, in words', async () => {
    call.mockResolvedValue({
      ok: false,
      failure: {
        status: 400,
        code: 'validation.failed',
        details: { fields: [{ path: 'displayName', code: 'characters' }] },
      },
    });
    mount();
    typeName('www.example.com');
    save();
    const message = await screen.findByText(/Remove web addresses/);
    expect(screen.getByLabelText('Display name').getAttribute('aria-invalid')).toBe('true');
    expect(message).toBeTruthy();
  });
});

describe('PasswordCard', () => {
  const mount = (codeRequired: boolean) =>
    render(
      wrap(
        <PasswordCard
          codeRequired={codeRequired}
          csrfToken="csrf"
          passwordMin={15}
          passwordMax={128}
        />,
      ),
    );
  const fill = (current = 'old password value', next = NEW_PASSWORD) => {
    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: current } });
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: next } });
  };
  const typeCode = (digits: string) =>
    digits.split('').forEach((digit, index) => {
      fireEvent.keyDown(screen.getByLabelText(`Digit ${index + 1} of 6`), { key: digit });
    });
  const submit = () => fireEvent.click(screen.getByRole('button', { name: 'Change password' }));

  it('without two-step verification: no code field, and none is sent', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: { code: 'password-changed' } });
    mount(false);
    expect(screen.queryByLabelText('Digit 1 of 6')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Use a backup code instead' })).toBeNull();
    fill();
    submit();

    expect(await screen.findByText(/Your password was changed/)).toBeTruthy();
    expect(call).toHaveBeenCalledWith(
      'POST',
      'identity/seller/change-password',
      { currentPassword: 'old password value', newPassword: NEW_PASSWORD },
      'csrf',
    );
    expect(router.refresh).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText<HTMLInputElement>('Current password').value).toBe('');
    expect(screen.getByLabelText<HTMLInputElement>('New password').value).toBe('');
  });

  it('with two-step verification: asks for the code first and sends it', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: { code: 'password-changed' } });
    mount(true);
    fill();
    submit();
    expect(screen.getByText('Enter the code.')).toBeTruthy();
    expect(call).not.toHaveBeenCalled();

    typeCode('123456');
    submit();
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(call.mock.calls[0]![2]).toEqual({
      currentPassword: 'old password value',
      newPassword: NEW_PASSWORD,
      code: '123456',
    });
  });

  it('asks for the current password and a long enough new one before calling the API', () => {
    mount(false);
    submit();
    expect(screen.getByText('Enter your current password.')).toBeTruthy();
    fill('old password value', 'short');
    submit();
    expect(screen.getByText('Use 15 to 128 characters.', { selector: 'p' })).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
  });

  it('switches to a backup code and sends it', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: { code: 'password-changed' } });
    mount(true);
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Use a backup code instead' }));
    fireEvent.change(screen.getByLabelText('Backup code'), { target: { value: ' ABCD-EFGH ' } });
    submit();
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(call.mock.calls[0]![2]).toMatchObject({ code: 'ABCD-EFGH' });
  });

  it.each([
    ['password.current-incorrect', 400, 'That password is incorrect.', false],
    [
      'second-factor.invalid',
      400,
      "That code didn't work. Enter the newest code from your app.",
      true,
    ],
    ['password.rejected', 400, 'Use 15 to 128 characters.', false],
  ])('shows %s under its field', async (code, status, text, codeRequired) => {
    call.mockResolvedValue({ ok: false, failure: { status, code } });
    mount(codeRequired);
    fill();
    if (codeRequired) typeCode('123456');
    submit();
    expect(await screen.findByText(text, { selector: 'p' })).toBeTruthy();
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it('shows a wait', async () => {
    call.mockResolvedValue({
      ok: false,
      failure: { status: 429, code: 'request.throttled', details: { retryAfterSeconds: 600 } },
    });
    mount(false);
    fill();
    submit();
    expect(await screen.findByText('Too many attempts. Try again in 10 minutes.')).toBeTruthy();
  });
});

describe('problems of failed calls', () => {
  it('maps a name refusal to the right field message', () => {
    const failed = (code: string) => ({
      status: 400,
      code: 'validation.failed',
      details: { fields: [{ path: 'displayName', code }] },
    });
    expect(nameProblemOf(failed('length'))).toEqual({ key: 'name-length', field: 'name' });
    expect(nameProblemOf(failed('characters'))).toEqual({ key: 'name-characters', field: 'name' });
    expect(nameProblemOf({ status: 503, code: 'access.unavailable' })).toEqual({
      key: 'unavailable',
      field: null,
    });
    expect(nameProblemOf({ status: 0, code: 'network' }).key).toBe('network');
    expect(nameProblemOf({ status: 403, code: 'request.csrf' }).key).toBe('csrf');
  });

  it('maps password refusals to the field and the limits the message needs', () => {
    expect(passwordProblemOf({ status: 400, code: 'password.current-incorrect' }, LIMITS)).toEqual({
      key: 'current-incorrect',
      field: 'current',
    });
    expect(
      passwordProblemOf(
        { status: 400, code: 'password.rejected', details: { rule: 'contains-identity' } },
        LIMITS,
      ),
    ).toEqual({ key: 'new-contains-identity', field: 'new', values: LIMITS });
    expect(
      passwordProblemOf(
        { status: 400, code: 'password.rejected', details: { rule: 'length' } },
        LIMITS,
      ).key,
    ).toBe('new-length');
    expect(passwordProblemOf({ status: 429, code: 'second-factor.locked' }, LIMITS).key).toBe(
      'code-locked',
    );
    expect(
      passwordProblemOf(
        {
          status: 400,
          code: 'validation.failed',
          details: { fields: [{ path: 'code', code: 'required' }] },
        },
        LIMITS,
      ),
    ).toEqual({ key: 'code-required', field: 'code' });
  });
});
