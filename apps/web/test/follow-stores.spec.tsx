// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../messages/en.json';
import { AccountArea } from '../src/account/account-area.tsx';
import { forgetCsrfToken } from '../src/account/customer-api.ts';
import { ANNOUNCE_MS, FollowControl, readFollowIntent } from '../src/account/follow-button.tsx';
import { MyStores, UNDO_MS } from '../src/account/my-stores.tsx';
import { AccountSettings } from '../src/account/settings.tsx';
import { reportedPath, reportedTitle } from '../src/analytics/page-path.ts';
import { clearInvite, keepInvite, readInvite } from '../src/invite/invite-cookie.ts';
import {
  InviteBanner,
  InviteInvalidNote,
  InviteJoiner,
  InviteSignUpLine,
} from '../src/invite/invite-ui.tsx';
import { StoreProvider, useStore } from '../src/shell/store-context.tsx';
import { loadAccount } from '../src/storefront/source.ts';

const search = vi.hoisted(() => ({ value: '' }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/s/green-grocer',
  useSearchParams: () => new URLSearchParams(search.value),
  useRouter: () => ({ push: () => undefined, replace: () => undefined }),
}));

const SELLER = '11111111-1111-4111-8111-111111111111';
const SELLER_B = '22222222-2222-4222-8222-222222222222';
const FOLLOW = `customers/me/followed-stores/${SELLER}`;

interface Call {
  readonly method: string;
  readonly path: string;
}
type Answer = { status: number; body?: unknown };
let answers: Record<string, Answer | (() => Answer)>;
let calls: Call[];
const fetchMock = vi.fn((url: string, init?: RequestInit) => {
  const method = init?.method ?? 'GET';
  const path = url.replace(/^\/api\//, '');
  calls.push({ method, path });
  const answer = answers[`${method} ${path}`] ?? { status: 404, body: { code: 'not-found' } };
  const { status, body } = typeof answer === 'function' ? answer() : answer;
  return Promise.resolve(
    new Response(JSON.stringify(body ?? {}), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );
});
const count = (method: string, path: string) =>
  calls.filter((c) => c.method === method && c.path === path).length;

const SESSION: Answer = {
  status: 200,
  body: { accountId: 'a1', email: 'jo@example.com', displayName: 'Jo', csrfToken: 'csrf-1' },
};
const signedOut: Answer = { status: 401, body: { code: 'access.unauthenticated' } };
const state = (following: boolean): Answer => ({
  status: 200,
  body: { sellerId: SELLER, following, followedAt: following ? '2026-11-10T01:00:00Z' : null },
});

beforeEach(() => {
  calls = [];
  search.value = '';
  forgetCsrfToken();
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  window.sessionStorage.clear();
  clearInvite();
  answers = {
    'GET identity/customer/session': SESSION,
    'GET customers/me/addresses': { status: 200, body: { addresses: [], limit: 10 } },
    [`GET ${FOLLOW}`]: state(false),
    [`PUT ${FOLLOW}`]: state(true),
    [`DELETE ${FOLLOW}`]: state(false),
    [`GET promotions/stores/${SELLER}/follow-gift`]: { status: 200, body: { gifts: [] } },
  };
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function Probe() {
  const { loginOpen } = useStore();
  return <output data-testid="login">{loginOpen ? 'open' : 'closed'}</output>;
}

function show(children: ReactNode, live = true) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <StoreProvider live={live}>
        <Probe />
        <main>{children}</main>
      </StoreProvider>
    </NextIntlClientProvider>,
  );
}

const store = (variant: 'page' | 'card' = 'page') => (
  <FollowControl sellerId={SELLER} storeName="Green Grocer" slug="green-grocer" variant={variant} />
);

describe('Follow button', () => {
  it('renders nothing in sample mode or without a seller id', () => {
    show(store(), false);
    expect(screen.queryByRole('button', { name: /Follow/ })).toBeNull();
    cleanup();
    show(<FollowControl sellerId={undefined} storeName="X" variant="page" />);
    expect(screen.queryByRole('button', { name: /Follow/ })).toBeNull();
  });

  it('logged out: opens the log-in dialog and keeps the follow for after sign-in', async () => {
    answers['GET identity/customer/session'] = signedOut;
    show(store());
    const button = await screen.findByRole('button', { name: /Follow/ });
    expect(button.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(button);
    expect(screen.getByTestId('login').textContent).toBe('open');
    expect(readFollowIntent()).toMatchObject({ sellerId: SELLER, path: '/s/green-grocer' });
    expect(count('PUT', FOLLOW)).toBe(0);
  });

  it('applies a follow kept before sign-in once the customer is signed in', async () => {
    window.sessionStorage.setItem(
      'follow-intent',
      JSON.stringify({ sellerId: SELLER, path: '/s/green-grocer', at: Date.now() }),
    );
    show(store());
    await waitFor(() => expect(count('PUT', FOLLOW)).toBe(1));
    const button = await screen.findByRole('button', { name: /Following/ });
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(readFollowIntent()).toBeNull();
  });

  it('follows at once, announces it and shows no dialog without offers', async () => {
    show(store());
    const button = await screen.findByRole('button', { name: /^Follow/ });
    await waitFor(() => expect(count('GET', FOLLOW)).toBe(1));
    fireEvent.click(button);
    const pressed = await screen.findByRole('button', { name: /Following/ });
    expect(pressed.getAttribute('aria-pressed')).toBe('true');
    await waitFor(() =>
      expect(document.querySelector('.fl-live')?.textContent).toBe('Following Green Grocer'),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('unfollows in one tap without a confirm', async () => {
    answers[`GET ${FOLLOW}`] = state(true);
    show(store());
    const button = await screen.findByRole('button', { name: /Following/ });
    fireEvent.click(button);
    await waitFor(() => expect(count('DELETE', FOLLOW)).toBe(1));
    expect(
      (await screen.findByRole('button', { name: /^Follow/ })).getAttribute('aria-pressed'),
    ).toBe('false');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('rolls back and says so when the follow fails', async () => {
    answers[`PUT ${FOLLOW}`] = { status: 500, body: {} };
    show(store());
    fireEvent.click(await screen.findByRole('button', { name: /^Follow/ }));
    expect((await screen.findByRole('alert')).textContent).toContain("Couldn't update. Try again.");
    expect(screen.getByRole('button', { name: /^Follow/ }).getAttribute('aria-pressed')).toBe(
      'false',
    );
  });

  it('words a missing store and the follow limit', async () => {
    answers[`PUT ${FOLLOW}`] = { status: 404, body: { code: 'engagement.store-not-found' } };
    show(store());
    fireEvent.click(await screen.findByRole('button', { name: /^Follow/ }));
    expect((await screen.findByRole('alert')).textContent).toContain("This store isn't available.");
    cleanup();
    answers[`PUT ${FOLLOW}`] = { status: 409, body: { code: 'engagement.follow-limit' } };
    show(store());
    fireEvent.click(await screen.findByRole('button', { name: /^Follow/ }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('maximum number of stores');
    expect(within(alert).getByRole('link', { name: 'My stores' }).getAttribute('href')).toBe(
      '/account/stores',
    );
  });

  it('words a 429 with the wait', async () => {
    answers[`PUT ${FOLLOW}`] = { status: 429, body: { details: { retryAfterSeconds: 150 } } };
    show(store());
    fireEvent.click(await screen.findByRole('button', { name: /^Follow/ }));
    expect((await screen.findByRole('alert')).textContent).toContain('Try again in 3 minutes.');
  });

  it('opens the log-in dialog when an unfollow finds the session gone', async () => {
    answers[`GET ${FOLLOW}`] = state(true);
    show(store());
    const button = await screen.findByRole('button', { name: /Following/ });
    answers[`DELETE ${FOLLOW}`] = signedOut;
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByTestId('login').textContent).toBe('open'));
    expect(screen.getByRole('button', { name: /Following/ }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it('shows the status line after a follow and takes it away after a few seconds', async () => {
    show(store());
    const button = await screen.findByRole('button', { name: /^Follow/ });
    await waitFor(() => expect(count('GET', FOLLOW)).toBe(1));
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fireEvent.click(button);
    await waitFor(() =>
      expect(document.querySelector('.fl-live')?.textContent).toBe('Following Green Grocer'),
    );
    await act(() => {
      vi.advanceTimersByTime(ANNOUNCE_MS + 50);
      return Promise.resolve();
    });
    expect(document.querySelector('.fl-live')?.textContent).toBe('');
  });

  it('drops a kept follow after 10 minutes and refuses a path that leaves the site', () => {
    const keep = (path: string, at: number) =>
      window.sessionStorage.setItem(
        'follow-intent',
        JSON.stringify({ sellerId: SELLER, path, at }),
      );
    keep('/s/green-grocer', Date.now());
    expect(readFollowIntent()?.path).toBe('/s/green-grocer');
    keep('/s/green-grocer', Date.now() - 11 * 60 * 1000);
    expect(readFollowIntent()).toBeNull();
    keep('//evil.example', Date.now());
    expect(readFollowIntent()).toBeNull();
    keep('/\\evil.example', Date.now());
    expect(readFollowIntent()).toBeNull();
  });

  it('shows the privacy text and its help line', async () => {
    show(store());
    expect(await screen.findByText(/The store sees your first name and a code only/)).toBeTruthy();
    const more = screen.getByRole('button', { name: 'Learn more' });
    expect(more.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(more);
    expect(more.getAttribute('aria-expanded')).toBe('true');
  });

  it.each([
    ['AU', 'AUD', 5000, /A\$50\.00/],
    ['JP', 'JPY', 5000, /¥5,000|￥5,000/],
  ])(
    'after a Follow shows the gift dialog in %s money, closes with Esc',
    async (_m, currency, min, money) => {
      answers[`GET promotions/stores/${SELLER}/follow-gift`] = {
        status: 200,
        body: {
          gifts: [
            {
              promotionId: 'p1',
              name: 'Welcome gift',
              reward: { kind: 'PERCENT', bps: 1000 },
              currency,
              minSpendMinor: String(min),
              endsAt: '2026-12-30T00:00:00Z',
            },
          ],
        },
      };
      show(store('card'));
      fireEvent.click(await screen.findByRole('button', { name: /^Follow/ }));
      const dialog = await screen.findByRole('dialog', {
        name: 'Thanks for following Green Grocer',
      });
      expect(dialog.textContent).toContain('Welcome gift: 10% off');
      expect(dialog.textContent).toMatch(money);
      expect(dialog.textContent).toContain('Your offer applies at checkout while you follow');
      expect(
        within(dialog).getByRole('link', { name: 'Shop Green Grocer' }).getAttribute('href'),
      ).toBe('/s/green-grocer');
      fireEvent.keyDown(document, { key: 'Escape' });
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(document.activeElement).toBe(screen.getByRole('button', { name: /Following/ }));
    },
  );

  it('writes a fixed gift in the Market currency (JPY has no decimals)', async () => {
    answers[`GET promotions/stores/${SELLER}/follow-gift`] = {
      status: 200,
      body: {
        gifts: [
          {
            name: 'Gift',
            reward: { kind: 'FIXED', amountMinor: '500' },
            currency: 'JPY',
            minSpendMinor: null,
            endsAt: null,
          },
        ],
      },
    };
    show(store());
    expect(await screen.findByText(/Follow to get Gift: (¥|￥)500 off/)).toBeTruthy();
  });

  it('shows the gift line on the store page for a visitor, and a failed gift read is silent', async () => {
    answers[`GET promotions/stores/${SELLER}/follow-gift`] = {
      status: 200,
      body: {
        gifts: [
          {
            name: 'Welcome gift',
            reward: { kind: 'FIXED', amountMinor: '500' },
            currency: 'NZD',
            minSpendMinor: null,
            endsAt: null,
          },
        ],
      },
    };
    show(store());
    expect(await screen.findByText(/Follow to get Welcome gift: .*5\.00 off/)).toBeTruthy();
    cleanup();
    answers[`GET promotions/stores/${SELLER}/follow-gift`] = { status: 503, body: {} };
    show(store());
    fireEvent.click(await screen.findByRole('button', { name: /^Follow/ }));
    expect(await screen.findByRole('button', { name: /Following/ })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

const ROW_A = { sellerId: SELLER, slug: 'green-grocer', followedAt: '2026-11-10T12:00:00Z' };
const ROW_B = { sellerId: SELLER_B, slug: null, followedAt: '2026-10-01T12:00:00Z' };
const LIST = 'customers/me/followed-stores';

function myStores() {
  const source = { ...sampleAccount, live: true };
  return show(
    <AccountArea source={source}>
      <MyStores />
    </AccountArea>,
  );
}
const sampleAccount = await loadAccount();

describe('My stores', () => {
  beforeEach(() => {
    answers[`GET ${LIST}`] = {
      status: 200,
      body: { items: [ROW_A, ROW_B], total: 2, nextCursor: null },
    };
    answers['GET sellers/stores/green-grocer'] = {
      status: 200,
      body: { slug: 'green-grocer', name: 'Green Grocer', logo: null },
    };
    answers[`DELETE customers/me/followed-stores/${SELLER_B}`] = state(false);
  });

  it('lists stores with name, date, link and a greyed store that is not public', async () => {
    myStores();
    expect(await screen.findByRole('link', { name: 'Green Grocer' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Green Grocer' }).getAttribute('href')).toBe(
      '/s/green-grocer',
    );
    expect(screen.getByText('Following since Nov 10, 2026')).toBeTruthy();
    expect(document.querySelector('.ms-off .ms-name')?.textContent).toBe(
      "This store isn't available.",
    );
    expect(screen.queryByRole('link', { name: "This store isn't available." })).toBeNull();
    expect(screen.getByText(/The store sees your first name and a code only/)).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /Following/ })).toHaveLength(2);
  });

  it('shows the empty line with Browse stores', async () => {
    answers[`GET ${LIST}`] = { status: 200, body: { items: [], total: 0, nextCursor: null } };
    myStores();
    expect(
      await screen.findByText("You don't follow any stores yet. Tap Follow on a store page."),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Browse stores' }).getAttribute('href')).toBe(
      '/sellers',
    );
  });

  it('shows the error with Retry and reads again', async () => {
    answers[`GET ${LIST}`] = { status: 500, body: {} };
    myStores();
    expect((await screen.findByRole('alert')).textContent).toContain("Couldn't load your stores.");
    answers[`GET ${LIST}`] = {
      status: 200,
      body: { items: [ROW_A], total: 1, nextCursor: null },
    };
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('link', { name: 'Green Grocer' })).toBeTruthy();
  });

  it('says how long to wait after a 429', async () => {
    answers[`GET ${LIST}`] = { status: 429, body: { details: { retryAfterSeconds: 120 } } };
    myStores();
    expect((await screen.findByRole('alert')).textContent).toContain('Try again in 2 minutes.');
  });

  it('loads the next page with the cursor', async () => {
    answers[`GET ${LIST}`] = {
      status: 200,
      body: { items: [ROW_A], total: 2, nextCursor: 'c1' },
    };
    answers[`GET ${LIST}?cursor=c1`] = {
      status: 200,
      body: { items: [ROW_B], total: 2, nextCursor: null },
    };
    myStores();
    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(document.querySelector('.ms-off .ms-name')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('unfollows in one tap, offers Undo for 5 seconds, then drops the row', async () => {
    myStores();
    await screen.findByRole('link', { name: 'Green Grocer' });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const buttons = screen.getAllByRole('button', { name: /Following/ });
    await act(() => {
      fireEvent.click(buttons[1]!);
      return Promise.resolve();
    });
    expect(count('DELETE', `customers/me/followed-stores/${SELLER_B}`)).toBe(1);
    expect(screen.getByText(/Unfollowed\./)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Undo/ })).toBeTruthy();
    await act(() => {
      vi.advanceTimersByTime(UNDO_MS + 50);
      return Promise.resolve();
    });
    expect(screen.queryByRole('button', { name: /Undo/ })).toBeNull();
    expect(document.querySelector('.ms-off')).toBeNull();
  });

  it('Undo follows the store again and keeps the row', async () => {
    answers[`PUT customers/me/followed-stores/${SELLER_B}`] = {
      status: 200,
      body: { sellerId: SELLER_B, following: true, followedAt: '2026-11-18T00:00:00Z' },
    };
    myStores();
    await screen.findByRole('link', { name: 'Green Grocer' });
    fireEvent.click(screen.getAllByRole('button', { name: /Following/ })[1]!);
    fireEvent.click(await screen.findByRole('button', { name: /Undo/ }));
    await waitFor(() => expect(count('PUT', `customers/me/followed-stores/${SELLER_B}`)).toBe(1));
    expect(await screen.findAllByRole('button', { name: /Following/ })).toHaveLength(2);
  });

  it('says why Undo was refused, then drops the row and moves focus to the heading', async () => {
    answers[`PUT customers/me/followed-stores/${SELLER_B}`] = {
      status: 409,
      body: { code: 'engagement.follow-limit' },
    };
    answers[`GET ${LIST}`] = { status: 200, body: { items: [ROW_B], total: 1, nextCursor: null } };
    myStores();
    await screen.findByRole('heading', { name: /Stores you follow/ });
    const button = await screen.findByRole('button', { name: /Following/ });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fireEvent.click(button);
    fireEvent.click(await screen.findByRole('button', { name: /Undo/ }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'You follow the maximum number of stores',
    );
    await act(() => {
      vi.advanceTimersByTime(UNDO_MS + 50);
      return Promise.resolve();
    });
    expect(document.querySelector('.ms-off')).toBeNull();
    expect(document.activeElement?.id).toBe('stores-head');
  });

  it('opens the log-in dialog when an unfollow finds the session gone', async () => {
    myStores();
    await screen.findByRole('link', { name: 'Green Grocer' });
    answers[`DELETE customers/me/followed-stores/${SELLER_B}`] = signedOut;
    fireEvent.click(screen.getAllByRole('button', { name: /Following/ })[1]!);
    await waitFor(() => expect(screen.getByTestId('login').textContent).toBe('open'));
  });
});

describe('Invite link', () => {
  it('keeps and reads the token cookie, and clears it', () => {
    keepInvite('abcDEF123456', 'Green Grocer');
    expect(readInvite()).toEqual({ token: 'abcDEF123456', storeName: 'Green Grocer' });
    clearInvite();
    expect(readInvite()).toBeNull();
    keepInvite('bad token!', 'X');
    expect(readInvite()).toBeNull();
  });

  it('shows the sign-up line only with a kept link; Not now clears it', async () => {
    const view = render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <InviteSignUpLine />
      </NextIntlClientProvider>,
    );
    expect(view.container.textContent).toBe('');
    keepInvite('abcDEF123456', 'Green Grocer');
    view.rerender(
      <NextIntlClientProvider locale="en" messages={messages} key="again">
        <InviteSignUpLine />
      </NextIntlClientProvider>,
    );
    expect(
      await screen.findByText(/You're joining through Green Grocer\. They'll see your first name/),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(readInvite()).toBeNull();
    expect(screen.queryByText(/You're joining through/)).toBeNull();
  });

  const JOIN = 'customers/me/store-invitation';
  const join = () => screen.findByRole('button', { name: 'Join Green Grocer' });

  it('makes no call for a kept link until the customer clicks Join', async () => {
    keepInvite('abcDEF123456', 'Green Grocer');
    answers[`POST ${JOIN}`] = { status: 200, body: { slug: 'green-grocer', following: true } };
    show(<InviteJoiner />);
    const button = await join();
    expect(screen.getByText(/The store sees your first name and a customer code/)).toBeTruthy();
    expect(count('POST', JOIN)).toBe(0);
    fireEvent.click(button);
    expect(await screen.findByText('You joined Green Grocer and follow it.')).toBeTruthy();
    expect(count('POST', JOIN)).toBe(1);
    expect(readInvite()).toBeNull();
  });

  it('a signed-in visitor of the invite page is asked, never joined', async () => {
    answers[`POST ${JOIN}`] = { status: 200, body: { slug: 'green-grocer', following: true } };
    show(<InviteBanner token="abcDEF123456" slug="green-grocer" storeName="Green Grocer" />);
    const button = await join();
    expect(count('POST', JOIN)).toBe(0);
    expect(readInvite()).toBeNull();
    expect(window.location.pathname).toBe('/s/green-grocer');
    fireEvent.click(button);
    await waitFor(() => expect(count('POST', JOIN)).toBe(1));
  });

  it('a signed-out visitor keeps the token and sees Create account and Sign in', async () => {
    answers['GET identity/customer/session'] = signedOut;
    show(<InviteBanner token="abcDEF123456" slug="green-grocer" storeName="Green Grocer" />);
    const create = await screen.findByRole('link', { name: 'Create account' });
    expect(create.getAttribute('href')).toBe('/account?create=1');
    await waitFor(() => expect(readInvite()?.token).toBe('abcDEF123456'));
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(screen.getByTestId('login').textContent).toBe('open');
    expect(count('POST', JOIN)).toBe(0);
  });

  it('No thanks forgets the link and calls nothing', async () => {
    keepInvite('abcDEF123456', 'Green Grocer');
    show(<InviteJoiner />);
    await join();
    fireEvent.click(screen.getByRole('button', { name: 'No thanks' }));
    expect(readInvite()).toBeNull();
    expect(count('POST', JOIN)).toBe(0);
  });

  it('words an ineligible link quietly and forgets it', async () => {
    keepInvite('abcDEF123456', 'Green Grocer');
    answers[`POST ${JOIN}`] = {
      status: 409,
      body: { code: 'customers.invitation-not-eligible' },
    };
    show(<InviteJoiner />);
    fireEvent.click(await join());
    expect(
      await screen.findByText("This link can't be used for an existing account."),
    ).toBeTruthy();
    expect(readInvite()).toBeNull();
  });

  it('retries once after 2 seconds on customers.unavailable, then notes it', async () => {
    keepInvite('abcDEF123456', 'Green Grocer');
    answers[`POST ${JOIN}`] = { status: 503, body: { code: 'customers.unavailable' } };
    show(<InviteJoiner />);
    const button = await join();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fireEvent.click(button);
    await waitFor(() => expect(count('POST', JOIN)).toBe(1));
    await act(() => {
      vi.advanceTimersByTime(2100);
      return Promise.resolve();
    });
    await waitFor(() => expect(count('POST', JOIN)).toBe(2));
    expect(await screen.findByText(/We couldn't add you to Green Grocer just now/)).toBeTruthy();
    expect(readInvite()).toBeNull();
  });

  it('shows the invalid-link note on the home page and dismisses it', () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <InviteInvalidNote />
      </NextIntlClientProvider>,
    );
    expect(screen.getByText('This invite link is no longer valid.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('This invite link is no longer valid.')).toBeNull();
  });

  it('Create account (?create=1) opens the log-in page on the sign-up form', async () => {
    answers['GET identity/customer/session'] = signedOut;
    search.value = 'create=1';
    show(
      <AccountArea source={{ ...sampleAccount, live: true }}>
        <p>account</p>
      </AccountArea>,
    );
    expect(await screen.findByRole('heading', { name: 'Create your account' })).toBeTruthy();
  });

  it('signing in with a kept link makes no join call by itself', async () => {
    keepInvite('abcDEF123456', 'Green Grocer');
    show(<InviteJoiner />);
    await join();
    await waitFor(() => expect(count('GET', 'identity/customer/session')).toBe(1));
    expect(count('POST', JOIN)).toBe(0);
  });

  it('does nothing without a session', async () => {
    answers['GET identity/customer/session'] = signedOut;
    keepInvite('abcDEF123456', 'Green Grocer');
    show(<InviteJoiner />);
    await waitFor(() => expect(count('GET', 'identity/customer/session')).toBe(1));
    expect(count('POST', 'customers/me/store-invitation')).toBe(0);
    expect(readInvite()).not.toBeNull();
  });

  it('never reports the token to analytics', () => {
    expect(reportedPath('/invite/abcDEF123456', '')).toBe('/invite');
    expect(reportedTitle('/invite/abcDEF123456', 'Green Grocer')).toBe('/invite');
  });
});

describe('Account privacy line', () => {
  const settings = () =>
    show(
      <AccountArea source={{ ...sampleAccount, live: true }}>
        <AccountSettings palette="B" textSize="auto" />
      </AccountArea>,
    );
  beforeEach(() => {
    answers['GET customers/me/account-deletion'] = {
      status: 200,
      body: { canDeleteAccount: false, waitingPeriodDays: 30 },
    };
    answers['GET customers/me/deletion-requests/current'] = { status: 404, body: {} };
    answers['GET customers/me/addresses'] = { status: 200, body: { addresses: [], limit: 10 } };
    answers['GET sellers/stores/green-grocer'] = {
      status: 200,
      body: { slug: 'green-grocer', name: 'Green Grocer' },
    };
  });

  it('names the store joined through, linked when it is public', async () => {
    answers['GET customers/me/store-invitation'] = {
      status: 200,
      body: { store: { sellerId: SELLER, slug: 'green-grocer', joinedAt: '2026-11-01T00:00:00Z' } },
    };
    settings();
    const line = await screen.findByText(/They see your first name and a code, never your email/);
    expect(line.textContent).toContain('You joined through Green Grocer.');
    expect(within(line).getByRole('link', { name: 'Green Grocer' }).getAttribute('href')).toBe(
      '/s/green-grocer',
    );
  });

  it('shows plain text for a store that is not public, and no line without a store', async () => {
    answers['GET customers/me/store-invitation'] = {
      status: 200,
      body: { store: { sellerId: SELLER, slug: null, joinedAt: '2026-11-01T00:00:00Z' } },
    };
    settings();
    const line = await screen.findByText(/never your email/);
    expect(line.querySelector('a')).toBeNull();
    cleanup();
    answers['GET customers/me/store-invitation'] = { status: 200, body: { store: null } };
    settings();
    await screen.findByRole('heading', { name: 'Privacy and data' });
    await waitFor(() => expect(count('GET', 'customers/me/store-invitation')).toBe(2));
    expect(screen.queryByText(/never your email/)).toBeNull();
  });
});
