// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../messages/en.json';
import { AccountArea } from '../src/account/account-area.tsx';
import { AccountAddresses } from '../src/account/addresses.tsx';
import { ConfirmEmail } from '../src/account/confirm-email.tsx';
import { forgetCsrfToken } from '../src/account/customer-api.ts';
import { forgetPasswordRules } from '../src/account/password-rules.ts';
import { AccountLists } from '../src/account/lists.tsx';
import { AccountSettings } from '../src/account/settings.tsx';
import { Header } from '../src/shell/header.tsx';
import { StoreProvider } from '../src/shell/store-context.tsx';
import { keepInvite, readInvite } from '../src/invite/invite-cookie.ts';
import { loadAccount } from '../src/storefront/source.ts';

vi.mock('next/navigation', () => ({
  usePathname: () => '/account',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
}));

interface Call {
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}
type Answer = { status: number; body?: unknown };

/** The API as the relay shows it: one answer per `METHOD path`, every call recorded. */
let answers: Record<string, Answer | (() => Answer)>;
let calls: Call[];
const fetchMock = vi.fn((url: string, init?: RequestInit) => {
  const method = init?.method ?? 'GET';
  const path = url.replace(/^\/api\//, '');
  calls.push({
    method,
    path,
    headers: (init?.headers ?? {}) as Record<string, string>,
    body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
  });
  const answer = answers[`${method} ${path}`] ?? { status: 404, body: { code: 'not-found' } };
  const { status, body } = typeof answer === 'function' ? answer() : answer;
  return Promise.resolve(
    new Response(JSON.stringify(body ?? {}), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );
});

const address = (id: string, first: string, isDefault: boolean) => ({
  id,
  recipientFirstName: first,
  recipientLastName: 'Citizen',
  phone: '0400000000',
  line1: `${id} Example Street`,
  line2: null,
  suburb: 'Kedron',
  region: 'QLD',
  postcode: '4031',
  countryCode: 'AU',
  deliveryNotes: null,
  isDefault,
  createdAt: '2026-10-20T00:00:00Z',
  updatedAt: '2026-10-20T00:00:00Z',
});
const ONE = '11111111-1111-4111-8111-111111111111';
const TWO = '22222222-2222-4222-8222-222222222222';

const session = (extra: object = {}) => ({
  status: 200,
  body: {
    accountId: 'a1',
    email: 'jo.citizen@example.com',
    displayName: 'Jo Citizen',
    appearance: null,
    csrfToken: 'csrf-1',
    ...extra,
  },
});
const book = (...list: object[]) => ({ status: 200, body: { addresses: list, limit: 10 } });

beforeEach(() => {
  calls = [];
  answers = {};
  forgetCsrfToken();
  forgetPasswordRules();
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  delete document.documentElement.dataset.palette;
  delete document.documentElement.dataset.textSize;
  window.matchMedia = (() => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const sample = await loadAccount();

function renderLive(children: ReactNode, live = true) {
  const source = { ...sample, live };
  return render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <StoreProvider live={live} initialCustomer={live ? null : sample.customer}>
        <Header delivery={{ label: 'Kedron 4031' }} />
        <main>
          <AccountArea source={source}>{children}</AccountArea>
        </main>
      </StoreProvider>
    </NextIntlClientProvider>,
  );
}

const main = () => screen.getByRole('main');
const type = (label: string, text: string) =>
  fireEvent.change(within(main()).getByLabelText(label), { target: { value: text } });
const called = (method: string, path: string) =>
  calls.filter((c) => c.method === method && c.path === path);

function signedIn(extra: Record<string, Answer | (() => Answer)> = {}) {
  answers = {
    'GET identity/customer/session': session(),
    'GET customers/me/addresses': book(address(ONE, 'Jo', true)),
    ...extra,
  };
}

describe('sample mode', () => {
  it('makes no request at all', async () => {
    renderLive(<AccountAddresses />, false);
    fireEvent.click(within(main()).getByRole('button', { name: 'Make Sam Nguyen the default' }));
    fireEvent.click(within(screen.getByRole('banner')).getByRole('button', { name: 'Log out' }));
    await screen.findByRole('heading', { level: 1, name: 'Log in' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('what the sample account never shows live', () => {
  it('says email choices are not available instead of showing toggles', async () => {
    signedIn();
    renderLive(<AccountSettings palette="B" textSize="auto" />);
    expect(await within(main()).findByText('Email choices are not available yet.')).toBeTruthy();
    expect(within(main()).queryByText('Offers and news')).toBeNull();
  });

  it('shows no sample list and no create button on the lists page', async () => {
    signedIn();
    renderLive(<AccountLists />);
    expect(await within(main()).findByText(/Named lists are not available yet/)).toBeTruthy();
    expect(within(main()).queryByRole('button', { name: 'Create a list' })).toBeNull();
  });
});

describe('session', () => {
  it('reads the session on first load, signs the buyer in and applies the account look', async () => {
    signedIn({
      'GET identity/customer/session': session({ appearance: { palette: 'A', textSize: 'large' } }),
    });
    renderLive(<p>Account page</p>);
    expect(await screen.findByText('Account page')).toBeTruthy();
    expect(document.documentElement.dataset.palette).toBe('A');
    expect(document.documentElement.dataset.textSize).toBe('large');
  });

  it('a 401 means signed out: the log-in page shows', async () => {
    answers = {
      'GET identity/customer/session': { status: 401, body: { code: 'access.unauthenticated' } },
    };
    renderLive(<p>Account page</p>);
    expect(await screen.findByRole('heading', { level: 1, name: 'Log in' })).toBeTruthy();
    expect(document.documentElement.dataset.palette).toBeUndefined();
  });

  it('falls back to the email name when the account has no display name', async () => {
    signedIn({ 'GET identity/customer/session': session({ displayName: null }) });
    renderLive(<AccountSettings palette="B" textSize="auto" />);
    expect((await screen.findByLabelText<HTMLInputElement>('Full name')).value).toBe('jo.citizen');
  });
});

describe('sign in', () => {
  const signedOut = {
    'GET identity/customer/session': { status: 401, body: { code: 'access.unauthenticated' } },
  };
  const submit = async (password = 'a-long-password') => {
    await screen.findByRole('heading', { level: 1, name: 'Log in' });
    type('Email', 'jo.citizen@example.com');
    type('Password', password);
    fireEvent.click(
      within(main())
        .getAllByRole('button', { name: 'Log in' })
        .find((b) => b.getAttribute('type') === 'submit')!,
    );
  };

  it('signs in, reads the session and the address book, and shows the account', async () => {
    answers = {
      ...signedOut,
      'POST identity/customer/sign-in': {
        status: 200,
        body: { code: 'signed-in', csrfToken: 'c' },
      },
    };
    renderLive(<p>Account page</p>);
    await screen.findByRole('heading', { level: 1, name: 'Log in' });
    signedIn({
      'POST identity/customer/sign-in': {
        status: 200,
        body: { code: 'signed-in', csrfToken: 'c' },
      },
    });
    await submit();
    expect(await screen.findByText('Account page')).toBeTruthy();
    expect(called('POST', 'identity/customer/sign-in')[0]?.body).toEqual({
      email: 'jo.citizen@example.com',
      password: 'a-long-password',
    });
    expect(
      within(screen.getByRole('banner')).getByRole('button', { name: 'Log out' }),
    ).toBeTruthy();
  });

  it.each([
    [401, 'credentials.invalid', 'The email or password is not right'],
    [403, 'account.disabled', 'This account is not available'],
    [429, 'request.throttled', 'Too many attempts'],
  ])('%i %s shows its message and stays signed out', async (status, code, message) => {
    answers = { ...signedOut, 'POST identity/customer/sign-in': { status, body: { code } } };
    renderLive(<p>Account page</p>);
    await submit();
    expect((await within(main()).findByRole('alert')).textContent).toContain(message);
    expect(screen.queryByText('Account page')).toBeNull();
  });
});

describe('sign in with an unconfirmed email', () => {
  it('shows Check your email, and Send it again asks for a new link for that address', async () => {
    answers = {
      'GET identity/customer/session': { status: 401, body: { code: 'access.unauthenticated' } },
      'POST identity/customer/sign-in': {
        status: 403,
        body: { code: 'email-verification-required' },
      },
      'POST identity/customer/verification-email': {
        status: 202,
        body: { code: 'verification-resend.accepted' },
      },
    };
    renderLive(<p>Account page</p>);
    await screen.findByRole('heading', { level: 1, name: 'Log in' });
    type('Email', ' jo.citizen@example.com ');
    type('Password', 'a-long-password');
    fireEvent.click(
      within(main())
        .getAllByRole('button', { name: 'Log in' })
        .find((b) => b.getAttribute('type') === 'submit')!,
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'Check your email' })).toBeTruthy();
    fireEvent.click(within(main()).getByRole('button', { name: 'Send it again' }));
    expect(await within(main()).findByText(/a new link is on its way/)).toBeTruthy();
    const resend = called('POST', 'identity/customer/verification-email')[0];
    expect(resend?.body).toEqual({ email: 'jo.citizen@example.com' });
    // Made without a session: no token is asked for or sent.
    expect(resend?.headers['x-csrf-token']).toBeUndefined();
    expect(screen.queryByText('Account page')).toBeNull();
  });
});

describe('create account', () => {
  const signedOut = {
    'GET identity/customer/session': { status: 401, body: { code: 'access.unauthenticated' } },
    'GET identity/customer/password-rules': {
      status: 200,
      body: { minLength: 16, maxLength: 100 },
    },
  };
  const openCreate = async () => {
    await screen.findByRole('heading', { level: 1, name: 'Log in' });
    fireEvent.click(within(main()).getByRole('button', { name: 'Create account' }));
  };
  const submit = () =>
    fireEvent.click(
      within(main())
        .getAllByRole('button', { name: 'Create account' })
        .find((b) => b.getAttribute('type') === 'submit')!,
    );

  it("shows the Market's rule from the API, sends email and password only, then Check your email", async () => {
    answers = {
      ...signedOut,
      'POST identity/customer/sign-up': { status: 202, body: { code: 'sign-up.accepted' } },
    };
    renderLive(<p>Account page</p>);
    await openCreate();
    // A Market with another rule than AU's: the form shows the API's numbers, never a constant.
    expect(await within(main()).findByText(/^16 to 100 characters\./)).toBeTruthy();
    expect(within(main()).getByLabelText('Password').getAttribute('minlength')).toBe('16');
    expect(within(main()).queryByLabelText('Full name')).toBeNull();
    type('Email', 'new.buyer@example.com');
    type('Password', 'correct horse battery staple');
    submit();
    expect(await screen.findByRole('heading', { level: 1, name: 'Check your email' })).toBeTruthy();
    expect(within(main()).getByText(/If new\.buyer@example\.com can be used/)).toBeTruthy();
    const sent = called('POST', 'identity/customer/sign-up')[0];
    expect(sent?.body).toEqual({
      email: 'new.buyer@example.com',
      password: 'correct horse battery staple',
    });
    expect(sent?.headers['x-csrf-token']).toBeUndefined();
    expect(screen.queryByText('Account page')).toBeNull();
  });

  it('shows no number until the API answers the rule, and still signs up', async () => {
    answers = {
      'GET identity/customer/session': { status: 401, body: { code: 'access.unauthenticated' } },
      'GET identity/customer/password-rules': { status: 503, body: { code: 'access.unavailable' } },
      'POST identity/customer/sign-up': { status: 202, body: { code: 'sign-up.accepted' } },
    };
    renderLive(<p>Account page</p>);
    await openCreate();
    await waitFor(() => expect(called('GET', 'identity/customer/password-rules')).toHaveLength(1));
    expect(within(main()).queryByText(/characters\./)).toBeNull();
    expect(within(main()).getByLabelText('Password').getAttribute('minlength')).toBeNull();
    type('Email', 'new.buyer@example.com');
    type('Password', 'correct horse battery staple');
    submit();
    expect(await screen.findByRole('heading', { level: 1, name: 'Check your email' })).toBeTruthy();
  });

  it.each([
    [
      { code: 'password.rejected', details: { rule: 'length' } },
      'Password',
      'Use 16 to 100 characters.',
    ],
    [
      { code: 'password.rejected', details: { rule: 'common' } },
      'Password',
      'This password is too common',
    ],
    [
      { code: 'password.rejected', details: { rule: 'contains-identity' } },
      'Password',
      'Do not use your email address',
    ],
    [
      { code: 'validation.failed', details: { fields: [{ path: 'email', code: 'format' }] } },
      'Email',
      'Enter an email address like',
    ],
  ])('a 400 %j shows its message on the %s field', async (body, field, message) => {
    answers = {
      ...signedOut,
      'POST identity/customer/sign-up': { status: 400, body: { statusCode: 400, ...body } },
    };
    renderLive(<p>Account page</p>);
    await openCreate();
    await within(main()).findByText(/^16 to 100 characters\./);
    type('Email', 'new.buyer@example.com');
    type('Password', 'correct horse battery staple');
    submit();
    await waitFor(() =>
      expect(within(main()).getByLabelText(field).getAttribute('aria-describedby') ?? '').not.toBe(
        '',
      ),
    );
    expect(await within(main()).findByText(new RegExp(message))).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Check your email' })).toBeNull();
  });

  it.each([
    [429, 'request.throttled', 'Too many attempts'],
    [503, 'request.busy', 'We could not create your account'],
  ])('%i %s shows its note', async (status, code, message) => {
    answers = { ...signedOut, 'POST identity/customer/sign-up': { status, body: { code } } };
    renderLive(<p>Account page</p>);
    await openCreate();
    type('Email', 'new.buyer@example.com');
    type('Password', 'correct horse battery staple');
    submit();
    expect((await within(main()).findByRole('alert')).textContent).toContain(message);
  });
});

describe('confirm email (the mailed link)', () => {
  const TOKEN = 'ml1_secret-token';
  function renderConfirm() {
    window.history.replaceState(null, '', `/account/confirm-email#${TOKEN}`);
    return render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <StoreProvider live initialCustomer={null}>
          <Header delivery={{ label: 'Kedron 4031' }} />
          <main>
            <ConfirmEmail />
          </main>
        </StoreProvider>
      </NextIntlClientProvider>,
    );
  }
  const confirm = (password: string) => {
    type('Password', password);
    fireEvent.click(within(main()).getByRole('button', { name: 'Confirm email' }));
  };

  it('takes the token from the fragment, removes it from the address, confirms and signs in', async () => {
    answers = {
      'GET identity/customer/session': { status: 401, body: { code: 'access.unauthenticated' } },
      'POST identity/customer/confirm-email': () => {
        // From now on the session exists.
        answers['GET identity/customer/session'] = session();
        answers['GET customers/me/addresses'] = book();
        return { status: 200, body: { code: 'signed-in', csrfToken: 'csrf-9' } };
      },
    };
    renderConfirm();
    await screen.findByRole('heading', { level: 1, name: 'Confirm your email' });
    expect(window.location.hash).toBe('');
    confirm('correct horse battery staple');
    expect(await screen.findByRole('heading', { level: 1, name: 'Email confirmed' })).toBeTruthy();
    const sent = called('POST', 'identity/customer/confirm-email')[0];
    expect(sent?.body).toEqual({ token: TOKEN, password: 'correct horse battery staple' });
    expect(sent?.headers['x-csrf-token']).toBeUndefined();
    expect(
      await within(screen.getByRole('banner')).findByRole('button', { name: 'Log out' }),
    ).toBeTruthy();
  });

  it('a wrong password says so and keeps the form', async () => {
    answers = {
      'GET identity/customer/session': { status: 401, body: { code: 'access.unauthenticated' } },
      'POST identity/customer/confirm-email': {
        status: 401,
        body: { code: 'credentials.invalid' },
      },
    };
    renderConfirm();
    await screen.findByRole('heading', { level: 1, name: 'Confirm your email' });
    confirm('not my password at all');
    expect((await within(main()).findByRole('alert')).textContent).toContain(
      'That password is not right',
    );
    expect(within(main()).getByRole('button', { name: 'Confirm email' })).toBeTruthy();
  });

  it('a link that cannot be used offers a new one for any address', async () => {
    answers = {
      'GET identity/customer/session': { status: 401, body: { code: 'access.unauthenticated' } },
      'POST identity/customer/confirm-email': { status: 400, body: { code: 'link.rejected' } },
      'POST identity/customer/verification-email': {
        status: 202,
        body: { code: 'verification-resend.accepted' },
      },
    };
    renderConfirm();
    await screen.findByRole('heading', { level: 1, name: 'Confirm your email' });
    confirm('correct horse battery staple');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'This link cannot be used' }),
    ).toBeTruthy();
    type('Email', 'jo.citizen@example.com');
    fireEvent.click(within(main()).getByRole('button', { name: 'Send a new link' }));
    expect(await within(main()).findByText(/a new link is on its way/)).toBeTruthy();
    expect(called('POST', 'identity/customer/verification-email')[0]?.body).toEqual({
      email: 'jo.citizen@example.com',
    });
  });

  it('a page opened without a token says the link cannot be used', async () => {
    answers = {
      'GET identity/customer/session': { status: 401, body: { code: 'access.unauthenticated' } },
    };
    window.history.replaceState(null, '', '/account/confirm-email');
    render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <StoreProvider live initialCustomer={null}>
          <main>
            <ConfirmEmail />
          </main>
        </StoreProvider>
      </NextIntlClientProvider>,
    );
    expect(
      await screen.findByRole('heading', { level: 1, name: 'This link cannot be used' }),
    ).toBeTruthy();
    expect(called('POST', 'identity/customer/confirm-email')).toHaveLength(0);
  });
});

describe('settings', () => {
  it('saves the name with the CSRF token, hides the mobile field and keeps the email read-only', async () => {
    signedIn({ 'PUT identity/customer/profile/display-name': { status: 200 } });
    renderLive(<AccountSettings palette="B" textSize="auto" />);
    const name = await screen.findByLabelText<HTMLInputElement>('Full name');
    expect(screen.queryByLabelText(/Mobile number/)).toBeNull();
    expect(screen.getByLabelText<HTMLInputElement>('Email').readOnly).toBe(true);
    expect(main().textContent).toContain(
      'Sellers you order from see your first name and last initial.',
    );
    fireEvent.change(name, { target: { value: 'Jo Q Citizen' } });
    fireEvent.click(within(main()).getByRole('button', { name: 'Save changes' }));
    expect(await within(main()).findByText('Saved')).toBeTruthy();
    const put = called('PUT', 'identity/customer/profile/display-name')[0];
    expect(put?.body).toEqual({ displayName: 'Jo Q Citizen' });
    expect(put?.headers['x-csrf-token']).toBe('csrf-1');
  });

  it('shows a refused name beside the field', async () => {
    signedIn({
      'PUT identity/customer/profile/display-name': {
        status: 400,
        body: {
          code: 'validation.failed',
          details: { fields: [{ path: 'displayName', code: 'length' }] },
        },
      },
    });
    renderLive(<AccountSettings palette="B" textSize="auto" />);
    fireEvent.change(await screen.findByLabelText('Full name'), {
      target: { value: 'x'.repeat(101) },
    });
    fireEvent.click(within(main()).getByRole('button', { name: 'Save changes' }));
    expect(await within(main()).findByText('Use between 1 and 100 characters.')).toBeTruthy();
  });

  it('sends both look values on a change', async () => {
    signedIn({ 'PUT identity/customer/profile/appearance': { status: 200 } });
    renderLive(<AccountSettings palette="B" textSize="auto" />);
    await screen.findByLabelText('Full name');
    fireEvent.click(within(main()).getByRole('button', { name: 'Large' }));
    await waitFor(() =>
      expect(called('PUT', 'identity/customer/profile/appearance')).toHaveLength(1),
    );
    expect(called('PUT', 'identity/customer/profile/appearance')[0]?.body).toEqual({
      palette: 'B',
      textSize: 'large',
    });
  });

  it('keeps the chosen language on the account only when Save is pressed, and null for English', async () => {
    signedIn({ 'PUT identity/customer/profile/language': { status: 200 } });
    renderLive(<AccountSettings palette="B" textSize="auto" languages={['en', 'fa']} />);
    await screen.findByLabelText('Full name');
    const select = within(main()).getByRole('combobox', { name: 'Site language' });
    const save = within(main()).getByRole('button', { name: 'Save language' });
    expect(save).toHaveProperty('disabled', true);

    fireEvent.change(select, { target: { value: 'fa' } });
    expect(called('PUT', 'identity/customer/profile/language')).toHaveLength(0);
    fireEvent.click(save);
    await waitFor(() =>
      expect(called('PUT', 'identity/customer/profile/language')).toHaveLength(1),
    );
    expect(called('PUT', 'identity/customer/profile/language')[0]?.body).toEqual({ locale: 'fa' });
    expect(await within(main()).findByText('Language saved to your account')).toBeTruthy();

    fireEvent.change(select, { target: { value: 'en' } });
    fireEvent.click(within(main()).getByRole('button', { name: 'Save language' }));
    await waitFor(() =>
      expect(called('PUT', 'identity/customer/profile/language')).toHaveLength(2),
    );
    expect(called('PUT', 'identity/customer/profile/language')[1]?.body).toEqual({ locale: null });
  });

  it('shows a refused save and puts the saved language back in the select', async () => {
    signedIn({
      'PUT identity/customer/profile/language': {
        status: 400,
        body: { code: 'validation.failed' },
      },
    });
    renderLive(<AccountSettings palette="B" textSize="auto" languages={['en', 'fa']} />);
    await screen.findByLabelText('Full name');
    const select = within(main()).getByRole<HTMLSelectElement>('combobox', {
      name: 'Site language',
    });

    fireEvent.change(select, { target: { value: 'fa' } });
    fireEvent.click(within(main()).getByRole('button', { name: 'Save language' }));

    const alert = await within(main()).findByRole('alert');
    expect(alert.textContent).toContain('We could not save your language');
    expect(select.value).toBe('en');
  });

  it.each([
    ['password.current-incorrect', 'That is not your current password.'],
    ['password.rejected', 'That password is not allowed. Choose a different one.'],
  ])('maps %s to a field error', async (code, message) => {
    signedIn({ 'POST identity/customer/change-password': { status: 400, body: { code } } });
    renderLive(<AccountSettings palette="B" textSize="auto" />);
    await screen.findByLabelText('Full name');
    type('Current password', 'old-password');
    type('New password', 'a-longer-password');
    type('Confirm new password', 'a-longer-password');
    fireEvent.click(within(main()).getByRole('button', { name: 'Update password' }));
    expect(await within(main()).findByText(message)).toBeTruthy();
    expect(called('POST', 'identity/customer/change-password')[0]?.body).toEqual({
      currentPassword: 'old-password',
      newPassword: 'a-longer-password',
    });
  });

  it('keeps the new CSRF token after a password change', async () => {
    signedIn({
      'POST identity/customer/change-password': { status: 200, body: { csrfToken: 'csrf-2' } },
      'PUT identity/customer/profile/display-name': { status: 200 },
    });
    renderLive(<AccountSettings palette="B" textSize="auto" />);
    await screen.findByLabelText('Full name');
    type('Current password', 'old-password');
    type('New password', 'a-longer-password');
    type('Confirm new password', 'a-longer-password');
    fireEvent.click(within(main()).getByRole('button', { name: 'Update password' }));
    await within(main()).findByText('Your password has been updated.');
    fireEvent.click(within(main()).getByRole('button', { name: 'Save changes' }));
    await within(main()).findByText('Saved');
    expect(
      called('PUT', 'identity/customer/profile/display-name')[0]?.headers['x-csrf-token'],
    ).toBe('csrf-2');
  });
});

describe('addresses', () => {
  it('creates an address from first and last name and reloads the book', async () => {
    let created = false;
    signedIn({
      'POST customers/me/addresses': () => {
        created = true;
        return { status: 201, body: address(TWO, 'Sam', false) };
      },
      'GET customers/me/addresses': () =>
        book(address(ONE, 'Jo', true), ...(created ? [address(TWO, 'Sam', false)] : [])),
    });
    renderLive(<AccountAddresses />);
    expect(await within(main()).findByRole('article', { name: 'Jo Citizen' })).toBeTruthy();
    fireEvent.click(within(main()).getByRole('button', { name: 'Add an address' }));
    type('First name', 'Sam');
    type('Last name', 'Citizen');
    type('Street address and unit', '2 Example Street');
    type('Suburb', 'Kedron');
    type('Postcode', '4031');
    type('Mobile number', '0400 000 000');
    fireEvent.click(within(main()).getByRole('button', { name: 'Save address' }));
    expect(await within(main()).findByRole('article', { name: 'Sam Citizen' })).toBeTruthy();
    expect(called('POST', 'customers/me/addresses')[0]).toMatchObject({
      body: {
        recipientFirstName: 'Sam',
        recipientLastName: 'Citizen',
        line1: '2 Example Street',
        suburb: 'Kedron',
        region: 'QLD',
        postcode: '4031',
        phone: '0400 000 000',
      },
      headers: { 'x-csrf-token': 'csrf-1' },
    });
  });

  it('says so when the address limit is reached', async () => {
    signedIn({
      'POST customers/me/addresses': {
        status: 422,
        body: { code: 'customers.address-limit-reached', details: { limit: 10 } },
      },
    });
    renderLive(<AccountAddresses />);
    fireEvent.click(await within(main()).findByRole('button', { name: 'Add an address' }));
    type('First name', 'Sam');
    type('Last name', 'Citizen');
    type('Street address and unit', '2 Example Street');
    type('Suburb', 'Kedron');
    type('Postcode', '4031');
    type('Mobile number', '0400 000 000');
    fireEvent.click(within(main()).getByRole('button', { name: 'Save address' }));
    expect((await within(main()).findByRole('alert')).textContent).toContain('most addresses');
  });

  it('deletes after asking and shows the book the API holds', async () => {
    let deleted = false;
    signedIn({
      [`DELETE customers/me/addresses/${TWO}`]: () => {
        deleted = true;
        return { status: 200, body: { deleted: true } };
      },
      'GET customers/me/addresses': () =>
        book(address(ONE, 'Jo', true), ...(deleted ? [] : [address(TWO, 'Sam', false)])),
    });
    renderLive(<AccountAddresses />);
    await within(main()).findByRole('article', { name: 'Sam Citizen' });
    fireEvent.click(within(main()).getByRole('button', { name: 'Delete Sam Citizen' }));
    fireEvent.click(within(main()).getByRole('button', { name: 'Delete' }));
    await waitFor(() =>
      expect(within(main()).queryByRole('article', { name: 'Sam Citizen' })).toBeNull(),
    );
    expect(called('DELETE', `customers/me/addresses/${TWO}`)).toHaveLength(1);
  });
});

describe('log out', () => {
  it('calls sign-out and shows the log-in page', async () => {
    signedIn({ 'POST identity/customer/sign-out': { status: 200 } });
    renderLive(<p>Account page</p>);
    await screen.findByText('Account page');
    fireEvent.click(within(screen.getByRole('banner')).getByRole('button', { name: 'Log out' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Log in' })).toBeTruthy();
    expect(called('POST', 'identity/customer/sign-out')).toHaveLength(1);
  });

  it('forgets a kept store invite on log out, and keeps it when log out fails', async () => {
    keepInvite('abcdEFGH1234_-', 'Green Grocer');
    signedIn({ 'POST identity/customer/sign-out': { status: 503, body: { code: 'x' } } });
    renderLive(<p>Account page</p>);
    await screen.findByText('Account page');
    const logOut = within(screen.getByRole('banner')).getByRole('button', { name: 'Log out' });
    fireEvent.click(logOut);
    await waitFor(() => expect(called('POST', 'identity/customer/sign-out')).toHaveLength(1));
    expect(readInvite()?.token).toBe('abcdEFGH1234_-');
    signedIn({ 'POST identity/customer/sign-out': { status: 200 } });
    fireEvent.click(logOut);
    expect(await screen.findByRole('heading', { level: 1, name: 'Log in' })).toBeTruthy();
    expect(readInvite()).toBeNull();
  });

  it('stays signed in when the API could not end the session', async () => {
    signedIn({ 'POST identity/customer/sign-out': { status: 503, body: { code: 'x' } } });
    renderLive(<p>Account page</p>);
    await screen.findByText('Account page');
    fireEvent.click(within(screen.getByRole('banner')).getByRole('button', { name: 'Log out' }));
    await waitFor(() => expect(called('POST', 'identity/customer/sign-out')).toHaveLength(1));
    expect(screen.getByText('Account page')).toBeTruthy();
    expect(screen.queryByRole('heading', { level: 1, name: 'Log in' })).toBeNull();
  });
});

describe('stale CSRF token', () => {
  it('reads the current token from the session and tries once more', async () => {
    let tokens = 0;
    let puts = 0;
    signedIn({
      'GET identity/customer/session': () => session({ csrfToken: `csrf-${++tokens}` }),
      'PUT identity/customer/profile/display-name': () =>
        ++puts === 1
          ? { status: 403, body: { statusCode: 403, code: 'request.csrf' } }
          : { status: 200 },
    });
    renderLive(<AccountSettings palette="B" textSize="auto" />);
    const name = await screen.findByLabelText<HTMLInputElement>('Full name');
    fireEvent.change(name, { target: { value: 'Jo Q Citizen' } });
    fireEvent.click(within(main()).getByRole('button', { name: 'Save changes' }));
    expect(await within(main()).findByText('Saved')).toBeTruthy();
    const sent = called('PUT', 'identity/customer/profile/display-name');
    expect(sent).toHaveLength(2);
    expect(sent[1]?.headers['x-csrf-token']).toBe(`csrf-${tokens}`);
  });
});
