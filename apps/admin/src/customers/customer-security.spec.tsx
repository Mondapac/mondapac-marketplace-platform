// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/customers/x',
  useSearchParams: () => new URLSearchParams(),
}));

import { Toaster } from '@mondapac/ui';
import { callApi, type ApiResult } from '../api/client.ts';
import { StepUpProvider } from '../step-up/step-up.tsx';
import { CustomerPage } from './customer-page.tsx';
import { CustomerSecurity, type DeletionRequestView } from './customer-security.tsx';
import { tabsFor, type CustomerOverview } from './page-types.ts';

// Customers management phase 2b, part B: the Account & security tab (sessions, sign-ins,
// addresses, privacy, deletion request), the reveal rule, and the header's password reset and
// sign out everywhere. Two Markets: AU (Brisbane) and NZ (Auckland).

const call = vi.mocked(callApi);
const wrap = (node: ReactNode) => (
  <NextIntlClientProvider locale="en-AU" messages={messages}>
    <StepUpProvider>
      {node}
      <Toaster labels={{ region: messages.toast.region, close: messages.toast.close }} />
    </StepUpProvider>
  </NextIntlClientProvider>
);
const ok = <T,>(body: T, status = 200): ApiResult<T> => ({ ok: true, status, body });
const refused = (status: number, code: string, details?: object): ApiResult<never> => ({
  ok: false,
  failure: { status, code, ...(details === undefined ? {} : { details }) },
});

const ID = '0190a000-0000-7000-8000-0000000000a1';
const S1 = '0190a000-0000-7000-8000-0000000000c1';
const S2 = '0190a000-0000-7000-8000-0000000000c2';
const A1 = '0190a000-0000-7000-8000-0000000000d1';
const A2 = '0190a000-0000-7000-8000-0000000000d2';
const BASE = `customers/admin/customers/${ID}`;

const ALL_KEYS = [
  'customers.customers.view',
  'customers.customers.export',
  'identity.customer-sign-in.view',
  'identity.customer-sign-in.reveal',
  'identity.customer-session.end',
  'identity.customer-password-reset.send',
  'customers.customer-address.reveal',
  'legal.customer-consent.view',
  'engagement.customer-behaviour.view',
];

const signIns = {
  items: [
    {
      signInId: S1,
      occurredAt: '2026-11-10T02:30:00.000Z',
      outcome: 'signed-in',
      result: 'success',
      device: 'chrome.windows',
      city: null,
    },
    {
      signInId: S2,
      occurredAt: '2026-11-09T02:30:00.000Z',
      outcome: 'password.incorrect',
      result: 'failure',
      device: null,
      city: null,
    },
  ],
  page: 1,
  pageSize: 25,
  paging: 'pages',
  total: 2,
  hasNext: false,
  since: '2026-08-20T00:00:00.000Z',
};
const full = {
  addressId: A1,
  countryCode: 'AU',
  recipientFirstName: 'Sara',
  recipientLastName: 'Ahmadi',
  phone: '+61 400 000 000',
  line1: '12 Wattle Street',
  line2: null,
  suburb: 'Indooroopilly',
  region: 'QLD',
  postcode: '4068',
  deliveryNotes: 'Leave at the gate',
};

type Handler = (method: string, path: string, body?: unknown) => ApiResult<unknown> | undefined;

/** Answers every section with data; `over` replaces some answers first. */
function route(over: Handler = () => undefined, country = 'AU') {
  call.mockImplementation((method, path, body) => {
    const custom = over(method, path, body);
    if (custom !== undefined) return Promise.resolve(custom as ApiResult<never>);
    let answer: ApiResult<unknown> = refused(404, 'unknown');
    if (path === `${BASE}/sessions`)
      answer = ok({
        items: [
          {
            device: 'chrome.windows',
            signedInAt: '2026-11-10T02:30:00.000Z',
            lastActiveAt: '2026-11-17T02:30:00.000Z',
          },
          {
            device: null,
            signedInAt: '2026-11-01T02:30:00.000Z',
            lastActiveAt: '2026-11-02T02:30:00.000Z',
          },
        ],
        more: false,
      });
    else if (path === `${BASE}/addresses`)
      answer = ok({
        items: [
          {
            addressId: A1,
            suburb: country === 'NZ' ? 'Ponsonby' : 'Indooroopilly',
            countryCode: country,
            isDefault: true,
            createdAt: '2026-10-01T02:30:00.000Z',
          },
          {
            addressId: A2,
            suburb: 'Newmarket',
            countryCode: 'NZ',
            isDefault: false,
            createdAt: '2026-10-02T02:30:00.000Z',
          },
        ],
      });
    else if (path === `${BASE}/addresses/${A1}/reveal`)
      answer = ok({ ...full, countryCode: country });
    else if (path === `${BASE}/sign-ins`) answer = ok(signIns);
    else if (path === `${BASE}/sign-ins/${S1}/reveal`)
      answer = ok({
        signInId: S1,
        address: '203.0.113.9',
        occurredAt: signIns.items[0]!.occurredAt,
      });
    else if (path === `${BASE}/consent`)
      answer = ok({
        channels: [
          {
            channel: 'email',
            granted: true,
            source: 'account',
            changedAt: '2026-11-01T02:30:00.000Z',
          },
        ],
      });
    else if (path === `${BASE}/behaviour`)
      answer = ok({
        personalization: { enabled: true, changedAt: null },
        summary: { productViews: 1, categoryViews: 1, cartAdditions: 0, topCategories: [] },
      });
    else if (path === `${BASE}/consent-history`)
      answer = ok({
        items: [
          {
            channel: 'email',
            granted: true,
            source: 'sign-up',
            occurredAt: '2026-10-01T02:30:00.000Z',
          },
        ],
        page: 1,
        pageSize: 25,
        paging: 'pages',
        total: 1,
        hasNext: false,
      });
    else if (path === `${BASE}/sessions/end`) answer = ok({ revokedSessions: 2 });
    else if (path === `${BASE}/password-reset`) answer = ok({ sent: true });
    return Promise.resolve(answer as ApiResult<never>);
  });
}

const props = {
  accountId: ID,
  adminAccountId: 'admin-1',
  marketId: 'AU',
  csrfToken: 'csrf',
  zone: 'Australia/Brisbane',
  paging: 'pages' as const,
  deletion: null as DeletionRequestView | null,
  deletionPending: false,
  sessionsVersion: 0,
  onSignOut: () => undefined,
};
const security = (over: Partial<typeof props> & { keys?: readonly string[] } = {}) => {
  const { keys = ALL_KEYS, ...rest } = over;
  return wrap(<CustomerSecurity {...props} {...rest} keys={new Set(keys)} />);
};

function media(desktop: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: query.includes('64rem') || query.includes('1024px') ? desktop : desktop,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  vi.resetAllMocks();
  media(true);
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const sessionsShown = () => screen.findByRole('list', { name: 'Active sessions' });

const headings = () =>
  screen
    .getAllByRole('heading', { level: 2 })
    .map((heading) => heading.textContent)
    .filter((text) => text !== null);

describe('the Account & security tab', () => {
  it('shows the five sections in order, each under its heading, with the index at the right', async () => {
    route();
    render(security());
    await sessionsShown();
    expect(headings()).toEqual([
      'Active sessions',
      'Sign-ins, last 90 days',
      'Addresses',
      'Privacy',
      'Deletion request',
    ]);
    const index = screen.getByRole('navigation', { name: 'On this page' });
    expect(
      within(index)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual([
      'Active sessions',
      'Sign-ins, last 90 days',
      'Addresses',
      'Privacy',
      'Deletion request',
    ]);
    expect(screen.queryByLabelText('Jump to')).toBeNull();
    expect(await screen.findByText('Indooroopilly, Australia')).toBeTruthy();
    expect(screen.getByText('Newmarket, New Zealand')).toBeTruthy();
    expect(screen.getByText('Marketing consent')).toBeTruthy();
    expect(screen.getByText('Personalisation')).toBeTruthy();
    expect(await screen.findByText('Sign-in at', { exact: false })).toBeTruthy();
  });

  it('is a "Jump to" select on phones that scrolls without moving focus and resets itself', async () => {
    media(false);
    route();
    render(security());
    await sessionsShown();
    expect(screen.queryByRole('navigation', { name: 'On this page' })).toBeNull();
    const scroll = vi.fn();
    const target = document.getElementById('security-addresses-title')!;
    target.scrollIntoView = scroll;
    const select = screen.getByLabelText<HTMLSelectElement>('Jump to');
    select.focus();
    fireEvent.change(select, { target: { value: 'addresses' } });
    expect(scroll).toHaveBeenCalled();
    expect(document.activeElement).toBe(select);
    expect(select.value).toBe('');
  });

  it('puts the index first in the DOM and marks the clicked section as current', async () => {
    route();
    const { container } = render(security());
    await sessionsShown();
    const index = screen.getByRole('navigation', { name: 'On this page' });
    expect(container.querySelector('nav')).toBe(index);
    const link = within(index).getByRole('link', { name: 'Addresses' });
    expect(link.getAttribute('aria-current')).toBeNull();
    fireEvent.click(link);
    expect(link.getAttribute('aria-current')).toBe('location');
    expect(
      within(index).getByRole('link', { name: 'Privacy' }).getAttribute('aria-current'),
    ).toBeNull();
  });

  it('shows a loading skeleton in each section before its answer', () => {
    call.mockImplementation(() => new Promise(() => undefined));
    render(security());
    for (const name of ['Active sessions', 'Addresses', 'Marketing consent', 'Personalisation']) {
      expect(screen.getByText(`Loading ${name}…`)).toBeTruthy();
    }
  });

  it('shows the wait when a section read is throttled', async () => {
    route((_method, path) =>
      path === `${BASE}/addresses`
        ? refused(429, 'request.throttled', { retryAfterSeconds: 180 })
        : undefined,
    );
    render(security());
    expect(await screen.findByText('Too many requests. Try again in 3 minutes.')).toBeTruthy();
  });

  it('says why Sign out everywhere is disabled when there are no sessions', async () => {
    route((_method, path) =>
      path === `${BASE}/sessions` ? ok({ items: [], more: false }) : undefined,
    );
    render(security());
    const button = await screen.findByRole('button', { name: 'Sign out everywhere…' });
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('No active sessions to sign out.')).toBeTruthy();
  });

  it('says more sessions exist when the list is cut', async () => {
    route((_method, path) =>
      path === `${BASE}/sessions`
        ? ok({
            items: [
              {
                device: 'chrome.windows',
                signedInAt: '2026-11-10T02:30:00.000Z',
                lastActiveAt: '2026-11-17T02:30:00.000Z',
              },
            ],
            more: true,
          })
        : undefined,
    );
    render(security());
    expect(await screen.findByText('Showing the 50 most recently used sessions.')).toBeTruthy();
  });

  it('shows a consent channel with no change date', async () => {
    route((_method, path) =>
      path === `${BASE}/consent`
        ? ok({ channels: [{ channel: 'email', granted: false, source: null, changedAt: null }] })
        : undefined,
    );
    render(security());
    const list = await screen.findByRole('list', { name: 'Marketing consent' });
    expect(within(list).getByText('Never changed')).toBeTruthy();
    expect(within(list).getByText('Not granted')).toBeTruthy();
  });

  it('shows the tab with the page key alone, and not without any section key', () => {
    expect(tabsFor(new Set(['customers.customers.view']))).toContain('security');
    expect(tabsFor(new Set())).not.toContain('security');
    expect(tabsFor(new Set(['legal.customer-consent.view']))).toContain('security');
  });

  it('leaves out the sections whose key the admin lacks, without calling them', async () => {
    route();
    render(security({ keys: ['customers.customers.view'] }));
    await screen.findByText('Indooroopilly, Australia');
    expect(headings()).toEqual(['Addresses', 'Deletion request']);
    const paths = call.mock.calls.map((args) => args[1]);
    expect(paths).toEqual([`${BASE}/addresses`]);
    expect(screen.queryByRole('button', { name: /Show full address/ })).toBeNull();
  });

  it.each([
    ['Active sessions', `${BASE}/sessions`, { items: [], more: false }, 'No active sessions.'],
    ['Addresses', `${BASE}/addresses`, { items: [] }, 'This customer has no saved addresses.'],
    ['Marketing consent', `${BASE}/consent`, { channels: [] }, 'No consent channels.'],
  ])('%s: an empty answer says why', async (_name, path, body, text) => {
    route((_method, target) => (target === path ? ok(body) : undefined));
    render(security());
    expect(await screen.findByText(text)).toBeTruthy();
  });

  it('sign-ins and consent history: an empty answer says why', async () => {
    const empty = { items: [], page: 1, pageSize: 25, paging: 'pages', total: 0, hasNext: false };
    route((_method, target) =>
      target === `${BASE}/sign-ins` || target === `${BASE}/consent-history` ? ok(empty) : undefined,
    );
    render(security());
    expect(await screen.findByText('No sign-ins in the last 90 days.')).toBeTruthy();
    expect(await screen.findByText('No consent changes yet.')).toBeTruthy();
  });

  it.each([
    ['sessions', 'Active sessions could not be loaded.', 'Chrome on Windows'],
    ['addresses', 'Addresses could not be loaded.', 'Indooroopilly, Australia'],
    ['consent', 'Marketing consent could not be loaded.', 'Granted'],
  ])(
    '%s: a failure shows inside the section with Retry and the rest still loads',
    async (part, message, after) => {
      let failing = true;
      route((_method, target) =>
        failing && target === `${BASE}/${part}` ? refused(503, 'access.unavailable') : undefined,
      );
      render(security());
      expect(await screen.findByText(message)).toBeTruthy();
      // The other sections are not blocked.
      expect(await screen.findByText('Personalisation')).toBeTruthy();
      failing = false;
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      expect(await screen.findByText(after)).toBeTruthy();
      expect(screen.queryByText(message)).toBeNull();
    },
  );

  it('shows a failed sign-ins list with Retry inside its section', async () => {
    let failing = true;
    route((_method, target) =>
      failing && target === `${BASE}/sign-ins` ? refused(503, 'access.unavailable') : undefined,
    );
    render(security());
    expect(await screen.findByText('The sign-ins could not be loaded.')).toBeTruthy();
    failing = false;
    fireEvent.click(screen.getAllByRole('button', { name: 'Try again' })[0]!);
    expect(await screen.findByText(/Sign-in at/)).toBeTruthy();
  });

  it.each([
    ['sessions', 'Active sessions', `${BASE}/sessions`],
    ['sign-ins', 'Sign-ins, last 90 days', `${BASE}/sign-ins`],
    ['addresses', 'Addresses', `${BASE}/addresses`],
    ['consent', 'Marketing consent', `${BASE}/consent`],
    ['personalization', 'Personalisation', `${BASE}/behaviour`],
    ['consent history', 'Consent history', `${BASE}/consent-history`],
  ])('%s: a 403 hides the section, not an error', async (_name, title, path) => {
    route((_method, target) => (target === path ? refused(403, 'access.denied') : undefined));
    render(security());
    await screen.findByRole('heading', { name: 'Deletion request' });
    await waitFor(() => expect(screen.queryByRole('heading', { name: title })).toBeNull());
    expect(screen.queryByText(/could not be loaded/)).toBeNull();
    if (
      title === 'Active sessions' ||
      title === 'Sign-ins, last 90 days' ||
      title === 'Addresses'
    ) {
      const index = screen.getByRole('navigation', { name: 'On this page' });
      expect(within(index).queryByRole('link', { name: title })).toBeNull();
    }
  });

  it('hides Privacy when every part of it is refused', async () => {
    route((_method, target) =>
      target.startsWith(`${BASE}/consent`) || target === `${BASE}/behaviour`
        ? refused(403, 'access.denied')
        : undefined,
    );
    render(security());
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Privacy' })).toBeNull());
    expect(screen.getByRole('heading', { name: 'Addresses' })).toBeTruthy();
  });

  it('shows the open deletion request, and says when none is open', async () => {
    route();
    const { unmount } = render(security());
    expect(await screen.findByText('No deletion request is open for this customer.')).toBeTruthy();
    unmount();
    render(
      security({
        deletion: {
          requestId: 'r1',
          status: 'pending' as const,
          requestedAt: '2026-11-10T02:30:00.000Z',
          scheduledFor: '2026-12-10T02:30:00.000Z',
        },
      }),
    );
    expect(
      await screen.findByText(
        /Deletion requested on 10 Nov 2026\. The account is erased on 10 Dec 2026/,
      ),
    ).toBeTruthy();
  });

  it('reads times in the Market’s zone, for a second Market', async () => {
    route(undefined, 'NZ');
    render(security({ marketId: 'NZ', zone: 'Pacific/Auckland' }));
    expect(await screen.findByText('Ponsonby, New Zealand')).toBeTruthy();
    // 02:30 UTC on 10 Nov is 15:30 in Auckland (NZDT).
    expect(await screen.findByText(/Signed in 10 Nov 2026, 3:30 pm NZDT/i)).toBeTruthy();
  });
});

describe('the reveal rule', () => {
  it('shows the full address after a recorded confirm, then hides it after five minutes', async () => {
    route();
    render(security());
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Show full address for Indooroopilly, Australia…',
      }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Show the full address?' });
    expect(within(dialog).getByText('Showing the full address is recorded.')).toBeTruthy();
    // Nothing is read before the confirm.
    expect(call.mock.calls.some((args) => String(args[1]).includes('reveal'))).toBe(false);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Show address' }));
    expect(await screen.findByText('12 Wattle Street')).toBeTruthy();
    expect(call).toHaveBeenCalledWith('POST', `${BASE}/addresses/${A1}/reveal`, {}, 'csrf');
    expect(screen.getByText('Revealed, recorded')).toBeTruthy();
    expect(screen.getByText('Leave at the gate')).toBeTruthy();
    // Never in the address bar.
    expect(window.location.href).not.toContain('Wattle');
    expect(window.location.search).toBe('');
    expect(window.location.hash).toBe('');
    // Nor in storage.
    expect(JSON.stringify({ ...window.localStorage })).not.toContain('Wattle');

    act(() => {
      vi.advanceTimersByTime(4 * 60 * 1000);
    });
    expect(screen.queryByText('12 Wattle Street')).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(60 * 1000 + 1);
    });
    expect(screen.queryByText('12 Wattle Street')).toBeNull();
    expect(screen.queryByText('Revealed, recorded')).toBeNull();
    const live = screen.getByText('The full address was hidden again after 5 minutes.');
    expect(live.getAttribute('aria-live')).toBe('polite');
  });

  it('hides the address again when the tab is left', async () => {
    route();
    const first = render(security());
    fireEvent.click(
      await screen.findByRole('button', { name: /Show full address for Indooroopilly/ }),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Show address' }));
    await screen.findByText('12 Wattle Street');
    first.unmount();
    render(security());
    await screen.findByText('Indooroopilly, Australia');
    expect(screen.queryByText('12 Wattle Street')).toBeNull();
  });

  it('can be hidden by hand, and shows the country of a second Market', async () => {
    route(undefined, 'NZ');
    render(security({ marketId: 'NZ', zone: 'Pacific/Auckland' }));
    fireEvent.click(await screen.findByRole('button', { name: /Show full address for Ponsonby/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Show address' }));
    expect(await screen.findByText('Indooroopilly QLD 4068, New Zealand')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Hide address for Ponsonby/ }));
    expect(screen.queryByText('12 Wattle Street')).toBeNull();
  });

  it('keeps the dialog open with the wait when the reveal is throttled', async () => {
    route((method, path) =>
      path === `${BASE}/addresses/${A1}/reveal`
        ? refused(429, 'request.throttled', { retryAfterSeconds: 120 })
        : undefined,
    );
    render(security());
    fireEvent.click(
      await screen.findByRole('button', { name: /Show full address for Indooroopilly/ }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Show the full address?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Show address' }));
    expect(
      await within(dialog).findByText('Too many requests. Try again in 2 minutes.'),
    ).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Show the full address?' })).toBeTruthy();
    expect(screen.queryByText('12 Wattle Street')).toBeNull();
  });

  it('hides a revealed address when the page is hidden or left', async () => {
    route();
    render(security());
    const reveal = async () => {
      fireEvent.click(
        await screen.findByRole('button', { name: /Show full address for Indooroopilly/ }),
      );
      fireEvent.click(await screen.findByRole('button', { name: 'Show address' }));
      await screen.findByText('12 Wattle Street');
    };
    await reveal();
    act(() => {
      window.dispatchEvent(new Event('pagehide'));
    });
    expect(screen.queryByText('12 Wattle Street')).toBeNull();
    await reveal();
    const state = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    state.mockRestore();
    expect(screen.queryByText('12 Wattle Street')).toBeNull();
  });

  it('keeps the sign-in IP dialog open with the wait when throttled', async () => {
    route((_method, path) =>
      path === `${BASE}/sign-ins/${S1}/reveal`
        ? refused(429, 'request.throttled', { retryAfterSeconds: 600 })
        : undefined,
    );
    render(security());
    const [menu] = await screen.findAllByRole('button', { name: /^Actions for Sign-in at/ });
    fireEvent.click(menu!);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Show IP…' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Show IP address' }));
    expect(await screen.findByText('Too many requests. Try again in 10 minutes.')).toBeTruthy();
    expect(screen.queryByText('203.0.113.9')).toBeNull();
  });

  it('reveals one sign-in’s IP from the row Actions menu, in place and recorded', async () => {
    route();
    render(security());
    expect(screen.queryByText('203.0.113.9')).toBeNull();
    // The IP is never a column.
    await screen.findAllByText('Signed in');
    expect(screen.queryByRole('columnheader', { name: /IP/ })).toBeNull();
    const [menu] = await screen.findAllByRole('button', { name: /^Actions for Sign-in at/ });
    fireEvent.click(menu!);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Show IP…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Show the full IP address?' });
    expect(within(dialog).getByText('Showing the full IP address is recorded.')).toBeTruthy();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Show IP address' }));
    expect(await screen.findByText('203.0.113.9')).toBeTruthy();
    expect(call).toHaveBeenCalledWith('POST', `${BASE}/sign-ins/${S1}/reveal`, {}, 'csrf');
    expect(screen.getByText('Revealed, recorded')).toBeTruthy();
    expect(window.location.href).not.toContain('203.0.113.9');
    // The list is not read again with the address: later list calls never carry it.
    expect(
      JSON.stringify(call.mock.calls.filter((args) => args[1] === `${BASE}/sign-ins`)),
    ).not.toContain('203.0.113.9');

    act(() => {
      vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    });
    expect(screen.queryByText('203.0.113.9')).toBeNull();
    expect(screen.getByText('The IP address was hidden again after 5 minutes.')).toBeTruthy();
  });

  it('offers "Hide IP address" once an IP is shown, and no reveal without the key', async () => {
    route();
    const first = render(security());
    const [menu] = await screen.findAllByRole('button', { name: /^Actions for Sign-in at/ });
    fireEvent.click(menu!);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Show IP…' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Show IP address' }));
    await screen.findByText('203.0.113.9');
    fireEvent.click(screen.getAllByRole('button', { name: /^Actions for Sign-in at/ })[0]!);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Hide IP address' }));
    expect(screen.queryByText('203.0.113.9')).toBeNull();
    first.unmount();

    route();
    render(security({ keys: ['customers.customers.view', 'identity.customer-sign-in.view'] }));
    await screen.findAllByText('Signed in');
    const [other] = screen.queryAllByRole('button', { name: /^Actions for Sign-in at/ });
    expect(other).toBeUndefined();
  });
});

describe('the sign-ins and consent history lists', () => {
  const bodiesTo = (path: string) =>
    call.mock.calls.filter((args) => args[1] === path).map((args) => args[2]);

  it('reads the first page with the Market’s paging mode and offers no export for sign-ins', async () => {
    route();
    render(security());
    await screen.findAllByText('Signed in');
    expect(bodiesTo(`${BASE}/sign-ins`)[0]).toEqual({
      direction: 'desc',
      page: 1,
      pageSize: 25,
      paging: 'pages',
    });
    // The consent history has the one Export; sign-ins has none (owner decision).
    expect(await screen.findAllByRole('button', { name: 'Export…' })).toHaveLength(1);
    expect(call.mock.calls.some((args) => String(args[1]).includes('sign-ins/export'))).toBe(false);
  });

  it('sends the result and the admin’s day range as instants on the admin’s clock', async () => {
    route();
    render(security({ zone: 'Pacific/Auckland' }));
    await screen.findAllByText('Signed in');
    const panels = screen.getAllByRole('button', { name: /^Filter/ });
    fireEvent.click(panels[0]!);
    const form = (await screen.findByRole('heading', { name: 'Filter sign-ins' })).closest('form')!;
    fireEvent.click(within(form).getByLabelText('Failed'));
    fireEvent.change(within(form).getByLabelText('From'), { target: { value: '2026-11-01' } });
    fireEvent.change(within(form).getByLabelText('To'), { target: { value: '2026-11-03' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(bodiesTo(`${BASE}/sign-ins`)).toHaveLength(2));
    // Auckland is UTC+13 on 1 Nov 2026: the day starts at 11:00 UTC the day before.
    expect(bodiesTo(`${BASE}/sign-ins`)[1]).toMatchObject({
      filters: {
        result: ['failure'],
        from: '2026-10-31T11:00:00.000Z',
        to: '2026-11-03T11:00:00.000Z',
      },
    });
    expect(
      await screen.findByRole('button', { name: /Remove filter Result: Failed/i }),
    ).toBeTruthy();
  });

  it('shows a refused filter as a message, not a blank list', async () => {
    let refuse = false;
    route((_method, path) =>
      refuse && path === `${BASE}/sign-ins` ? refused(400, 'validation.failed') : undefined,
    );
    render(security());
    await screen.findAllByText('Signed in');
    refuse = true;
    fireEvent.click(screen.getByRole('button', { name: 'Failed' }));
    expect(
      await screen.findByText('This filter cannot be used. Clear it and try again.'),
    ).toBeTruthy();
  });
});

describe('the header actions', () => {
  const overview: CustomerOverview = {
    accountId: ID,
    email: 'sara@example.com',
    displayName: 'Sara Ahmadi',
    status: 'active',
    emailVerified: true,
    signedUpAt: '2026-10-01T02:30:00.000Z',
    lastOrderAt: null,
    orderCount: 0,
    spentMinor: '0',
    currency: 'NZD',
    refundCount: 0,
    firstOrderAt: null,
    refundedMinor: '0',
  };
  const pageProps = {
    accountId: ID,
    adminAccountId: 'admin-1',
    marketId: 'NZ',
    initialTab: 'security' as const,
    csrfToken: 'csrf',
    zone: 'Pacific/Auckland',
    paging: 'pages' as const,
    waitingPeriodDays: 30,
  };
  const page = (keys: readonly string[] = ALL_KEYS) => (
    <CustomerPage {...pageProps} permissionKeys={keys} />
  );
  const open = async (item: string) => {
    fireEvent.click(await screen.findByRole('button', { name: 'More actions' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: item }));
  };

  it('opens the Account & security tab and does not audit it with tab-opened', async () => {
    route((_method, path) => (path === BASE ? ok(overview) : undefined));
    render(wrap(page()));
    await screen.findByRole('heading', { name: 'Sara Ahmadi' });
    expect(await screen.findByRole('heading', { name: 'Active sessions' })).toBeTruthy();
    expect(call.mock.calls.some((args) => String(args[1]).endsWith('/tab-opened'))).toBe(false);
  });

  it('signs a customer out everywhere after a level 2 confirm, and reads the sessions again', async () => {
    route((_method, path) => (path === BASE ? ok(overview) : undefined));
    render(wrap(page()));
    await sessionsShown();
    await open('Sign out everywhere…');
    const dialog = await screen.findByRole('dialog', { name: 'Sign out everywhere?' });
    expect(within(dialog).getByText('Every session of this customer ends now.')).toBeTruthy();
    expect(call.mock.calls.some((args) => args[1] === `${BASE}/sessions/end`)).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Sign out everywhere' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith('POST', `${BASE}/sessions/end`, {}, 'csrf'),
    );
    expect(await screen.findByText('2 sessions ended.')).toBeTruthy();
    await waitFor(() =>
      expect(call.mock.calls.filter((args) => args[1] === `${BASE}/sessions`)).toHaveLength(2),
    );
  });

  it('keeps the sign out dialog open with the wait on a 429', async () => {
    route((_method, path) => {
      if (path === BASE) return ok(overview);
      if (path === `${BASE}/sessions/end`)
        return refused(429, 'request.throttled', { retryAfterSeconds: 240 });
      return undefined;
    });
    render(wrap(page()));
    await sessionsShown();
    await open('Sign out everywhere…');
    const dialog = await screen.findByRole('dialog', { name: 'Sign out everywhere?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Sign out everywhere' }));
    expect(
      await within(dialog).findByText('Too many requests. Try again in 4 minutes.'),
    ).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Sign out everywhere?' })).toBeTruthy();
  });

  it('also signs out from the Active sessions section', async () => {
    route((_method, path) => (path === BASE ? ok(overview) : undefined));
    render(wrap(page()));
    await sessionsShown();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out everywhere…' }));
    expect(await screen.findByRole('dialog', { name: 'Sign out everywhere?' })).toBeTruthy();
  });

  it('sends a password reset, keeping the dialog open with the wait on a 429', async () => {
    let throttled = true;
    route((_method, path) => {
      if (path === BASE) return ok(overview);
      if (path === `${BASE}/password-reset` && throttled)
        return refused(429, 'customers.password-reset-recently-requested', {
          retryAfterSeconds: 300,
        });
      return undefined;
    });
    render(wrap(page()));
    await sessionsShown();
    await open('Send password reset…');
    const dialog = await screen.findByRole('dialog', { name: 'Send a password reset?' });
    expect(
      within(dialog).getByText(
        'The customer gets an email with a reset link. Their password stays until they use it.',
      ),
    ).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send reset email' }));
    expect(
      await within(dialog).findByText('Too many requests. Try again in 5 minutes.'),
    ).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Send a password reset?' })).toBeTruthy();
    throttled = false;
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send reset email' }));
    expect(await screen.findByText('Password reset email sent.')).toBeTruthy();
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Send a password reset?' })).toBeNull(),
    );
  });

  it('says why a reset cannot go to a disabled account', async () => {
    route((_method, path) => {
      if (path === BASE) return ok(overview);
      if (path === `${BASE}/password-reset`) return refused(409, 'customers.customer-not-eligible');
      return undefined;
    });
    render(wrap(page()));
    await sessionsShown();
    await open('Send password reset…');
    fireEvent.click(await screen.findByRole('button', { name: 'Send reset email' }));
    expect(
      await screen.findByText(
        'This account is disabled or its email is not verified, so no mail can be sent.',
      ),
    ).toBeTruthy();
  });

  it('has neither menu item without its key', async () => {
    route((_method, path) => (path === BASE ? ok(overview) : undefined));
    render(wrap(page(['customers.customers.view', 'identity.customer-sign-in.view'])));
    await sessionsShown();
    expect(screen.queryByRole('button', { name: 'More actions' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sign out everywhere…' })).toBeNull();
  });
});
