// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../messages/en.json';
import { AccountArea } from '../src/account/account-area.tsx';
import { AccountAddresses } from '../src/account/addresses.tsx';
import { forgetCsrfToken } from '../src/account/customer-api.ts';
import { AccountSettings } from '../src/account/settings.tsx';
import { Header } from '../src/shell/header.tsx';
import { StoreProvider } from '../src/shell/store-context.tsx';
import { loadAccount } from '../src/storefront/source.ts';

vi.mock('next/navigation', () => ({
  usePathname: () => '/account',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: () => undefined, replace: () => undefined }),
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
    [403, 'email-verification-required', 'Confirm your email first'],
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
});
