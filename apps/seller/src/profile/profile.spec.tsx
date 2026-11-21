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
import { nameProblemOf, passwordProblemOf, preferencesProblemOf } from './errors.ts';
import { PasswordCard } from './password-card.tsx';
import { ProfileEditor } from './profile-editor.tsx';
import { expectToast } from '../../test/toast-spy.ts';

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

const ZONES = ['UTC', 'Australia/Brisbane', 'Asia/Kuala_Lumpur'];
const editor = (
  name = 'Amina Rahman',
  timezone: string | null = null,
  locale: string | null = null,
) =>
  render(
    wrap(
      <ProfileEditor
        name={name}
        timezone={timezone}
        locale={locale}
        zones={ZONES}
        csrfToken="csrf"
      />,
    ),
  );
const saveBar = () => screen.queryByRole('region', { name: 'Unsaved changes' });
const saveAll = () => fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

describe('ProfileEditor: display name', () => {
  const mount = () => editor();
  const save = saveAll;
  const typeName = (value: string) =>
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value } });

  it('shows the current name and saves a trimmed one, then refreshes the page', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: { changed: true } });
    mount();
    expect(screen.getByLabelText<HTMLInputElement>('Display name').value).toBe('Amina Rahman');

    typeName('  Amina R.  ');
    save();

    await expectToast('Your name was updated.');
    expect(call).toHaveBeenCalledWith(
      'PUT',
      'identity/seller/profile/display-name',
      { displayName: 'Amina R.' },
      'csrf',
    );
    expect(screen.getByLabelText<HTMLInputElement>('Display name').value).toBe('Amina R.');
    expect(router.refresh).toHaveBeenCalledTimes(1);
    expect(saveBar()).toBeNull();
  });

  it('says so when the name did not change, without refreshing', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: { changed: false } });
    mount();
    typeName('Amina Rahman ');
    save();
    await expectToast('That is already your name.', 'info');
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it('refuses an empty or too long name before calling the API', async () => {
    mount();
    typeName('   ');
    save();
    expect(await screen.findByText('Enter a name of 1 to 100 characters.')).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save changes' })).toBeTruthy());
    typeName('x'.repeat(101));
    save();
    expect(await screen.findByText('Enter a name of 1 to 100 characters.')).toBeTruthy();
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

describe('ProfileEditor: one save bar', () => {
  const zone = () => screen.getByLabelText<HTMLSelectElement>('Time zone');

  it('shows no bar until something changes, and counts each changed part', () => {
    editor();
    expect(saveBar()).toBeNull();
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Amina R.' } });
    expect(saveBar()?.textContent).toContain('1 unsaved change');
    fireEvent.change(zone(), { target: { value: 'UTC' } });
    expect(saveBar()?.textContent).toContain('2 unsaved changes');
  });

  it('saves both parts in turn with one Save', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: { changed: true } });
    editor();
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Amina R.' } });
    fireEvent.change(zone(), { target: { value: 'UTC' } });
    saveAll();
    await waitFor(() => expect(call).toHaveBeenCalledTimes(2));
    expect(call.mock.calls.map((c) => c[1])).toEqual([
      'identity/seller/profile/display-name',
      'identity/seller/profile/preferences',
    ]);
    await waitFor(() => expect(saveBar()).toBeNull());
    await expectToast('Your profile was saved.');
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it('moves focus to the message of a part that failed without a field error', async () => {
    call
      .mockResolvedValueOnce({ ok: true, status: 200, body: { changed: true } })
      .mockResolvedValueOnce({ ok: false, failure: { status: 503, code: 'access.unavailable' } });
    editor();
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Amina R.' } });
    fireEvent.change(zone(), { target: { value: 'UTC' } });
    saveAll();
    await expectToast('Your name was updated.');
    const alert = await screen.findByRole('alert');
    await waitFor(() => expect(document.activeElement).toBe(alert.parentElement));
    expect(saveBar()?.textContent).toContain('1 unsaved change');
  });

  it('keeps a failed part dirty while the other part saves', async () => {
    call
      .mockResolvedValueOnce({ ok: false, failure: { status: 503, code: 'access.unavailable' } })
      .mockResolvedValueOnce({ ok: true, status: 200, body: { changed: true } });
    editor();
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Amina R.' } });
    fireEvent.change(zone(), { target: { value: 'UTC' } });
    saveAll();
    await expectToast('Your settings were saved.');
    await waitFor(() => expect(saveBar()?.textContent).toContain('1 unsaved change'));
    expect(screen.getByLabelText<HTMLInputElement>('Display name').value).toBe('Amina R.');
  });

  it('Discard puts every part back', () => {
    editor('Amina Rahman', 'UTC', 'en');
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'X' } });
    fireEvent.change(zone(), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.getByLabelText<HTMLInputElement>('Display name').value).toBe('Amina Rahman');
    expect(zone().value).toBe('UTC');
    expect(saveBar()).toBeNull();
  });

  it('asks before unload with changes, and leaves quietly on a signed-out answer', async () => {
    const assign = vi.fn();
    Object.defineProperty(window, 'location', { value: { assign }, writable: true });
    call.mockResolvedValue({ ok: false, failure: { status: 401, code: 'session.invalid' } });
    editor();
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Amina R.' } });
    const asked = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(asked);
    expect(asked.defaultPrevented).toBe(true);
    saveAll();
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/session-ended'));
    const quiet = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(quiet);
    expect(quiet.defaultPrevented).toBe(false);
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

    await expectToast(/Your password was changed/);
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

describe('ProfileEditor: preferences', () => {
  const mount = (timezone: string | null = null, locale: string | null = null) =>
    editor('Amina Rahman', timezone, locale);
  const save = saveAll;
  const zone = () => screen.getByLabelText<HTMLSelectElement>('Time zone');
  const language = () => screen.getByLabelText<HTMLSelectElement>('Language');

  it('starts on the saved choice, or on the default when none was made', () => {
    mount('Australia/Brisbane', 'en');
    expect(zone().value).toBe('Australia/Brisbane');
    expect(language().value).toBe('en');
    cleanup();
    mount();
    expect(zone().value).toBe('');
    expect(zone().selectedOptions[0]?.textContent).toBe('Default (store time zone)');
    expect(language().value).toBe('');
  });

  it('lists the zones with spaces for underscores', () => {
    mount();
    expect(screen.getByRole('option', { name: 'Asia/Kuala Lumpur' })).toBeTruthy();
  });

  it('saves the choice, then refreshes the page', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: { changed: true } });
    mount();
    fireEvent.change(zone(), { target: { value: 'Australia/Brisbane' } });
    fireEvent.change(language(), { target: { value: 'en' } });
    save();

    await expectToast('Your settings were saved.');
    expect(call).toHaveBeenCalledWith(
      'PUT',
      'identity/seller/profile/preferences',
      { timezone: 'Australia/Brisbane', locale: 'en' },
      'csrf',
    );
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it('sends null for the default choices', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: { changed: false } });
    mount('UTC', 'en');
    fireEvent.change(zone(), { target: { value: '' } });
    fireEvent.change(language(), { target: { value: '' } });
    save();

    await expectToast('Those settings are already saved.', 'info');
    expect(call).toHaveBeenCalledWith(
      'PUT',
      'identity/seller/profile/preferences',
      { timezone: null, locale: null },
      'csrf',
    );
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it('shows a refusal and keeps the form', async () => {
    call.mockResolvedValue({
      ok: false,
      failure: {
        status: 400,
        code: 'validation.failed',
        details: { fields: [{ path: 'timezone', code: 'invalid' }] },
      },
    });
    mount();
    fireEvent.change(zone(), { target: { value: 'UTC' } });
    save();
    expect(
      await screen.findByText(
        'That time zone or language is not available. Choose one from the list.',
      ),
    ).toBeTruthy();
    expect(preferencesProblemOf({ status: 503, code: 'access.unavailable' }).key).toBe(
      'unavailable',
    );
  });
});
