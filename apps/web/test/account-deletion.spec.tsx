// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../messages/en.json';
import { AccountArea } from '../src/account/account-area.tsx';
import { AccountDeleteScreen } from '../src/account/account-deletion.tsx';
import { forgetCsrfToken } from '../src/account/customer-api.ts';
import { AccountSettings } from '../src/account/settings.tsx';
import { StoreProvider } from '../src/shell/store-context.tsx';
import { loadAccount } from '../src/storefront/source.ts';

const replace = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  usePathname: () => '/account/delete',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: () => undefined, replace }),
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
/** When set, the availability answer waits for it (a test holds the read open). */
let gate: Promise<void> | null = null;
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
  const hold = gate !== null && path === 'customers/me/account-deletion' ? gate : undefined;
  return Promise.resolve(hold).then(() =>
    status === 204
      ? new Response(null, { status })
      : new Response(JSON.stringify(body ?? {}), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
  );
});

const AVAILABILITY = 'customers/me/account-deletion';
const REQUESTS = 'customers/me/deletion-requests';
const CURRENT = `${REQUESTS}/current`;

const on = (days = 14): Answer => ({
  status: 200,
  body: { canDeleteAccount: true, waitingPeriodDays: days },
});
const off: Answer = { status: 200, body: { canDeleteAccount: false, waitingPeriodDays: 30 } };
const open = (status: 'pending' | 'executing' = 'pending'): Answer => ({
  status: 200,
  body: {
    status,
    requestedAt: '2026-11-14T12:00:00Z',
    scheduledFor: '2026-11-28T12:00:00Z',
    waitingPeriodDays: 14,
  },
});
const none: Answer = {
  status: 404,
  body: { code: 'customers.account-deletion-request-not-found' },
};
const refused = (status: number, code: string, details: object = {}): Answer => ({
  status,
  body: { code, details },
});
const DATE = /28 November 2026|November 28, 2026/;

beforeEach(() => {
  calls = [];
  gate = null;
  replace.mockClear();
  forgetCsrfToken();
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  window.matchMedia = (() => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  answers = {
    'GET identity/customer/session': {
      status: 200,
      body: {
        accountId: 'a1',
        email: 'jo.citizen@example.com',
        displayName: 'Jo Citizen',
        appearance: null,
        csrfToken: 'csrf-1',
      },
    },
    'GET customers/me/addresses': { status: 200, body: { addresses: [], limit: 10 } },
    [`GET ${AVAILABILITY}`]: off,
    [`GET ${CURRENT}`]: none,
  };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const sample = await loadAccount();

function show(children: ReactNode, live = true) {
  const source = { ...sample, live };
  return render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <StoreProvider live={live} initialCustomer={live ? null : sample.customer}>
        <main>
          <AccountArea source={source}>{children}</AccountArea>
        </main>
      </StoreProvider>
    </NextIntlClientProvider>,
  );
}
const settings = () => show(<AccountSettings palette="B" textSize="auto" />);
const privacy = async () => {
  const card = (await screen.findByRole('heading', { name: 'Privacy and data' })).closest(
    'section',
  )!;
  return within(card);
};
const hint = 'To close your account, contact support.';
const called = (method: string, path: string) =>
  calls.filter((c) => c.method === method && c.path === path);

describe('Settings, Privacy card', () => {
  it('sample mode makes no deletion request and shows the support line', async () => {
    show(<AccountSettings palette="B" textSize="auto" />, false);
    const card = await privacy();
    expect(card.getByText(hint)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows a loading line while the answers are read, then the row', async () => {
    answers[`GET ${AVAILABILITY}`] = on();
    let release: () => void = () => undefined;
    gate = new Promise<void>((resolve) => (release = resolve));
    settings();
    const card = await privacy();
    expect(card.getByText('Loading')).toBeTruthy();
    expect(card.queryByText(hint)).toBeNull();
    release();
    await card.findByText(/will be removed after 14 days/);
    expect(card.queryByText('Loading')).toBeNull();
  });

  it('Off (default): one muted line with the support email; no button, no link', async () => {
    settings();
    const card = await privacy();
    expect(await card.findByText(hint)).toBeTruthy();
    expect(card.getByRole('link', { name: 'support@mondapac.com.au' }).getAttribute('href')).toBe(
      'mailto:support@mondapac.com.au',
    );
    expect(card.queryByRole('link', { name: 'Delete account' })).toBeNull();
    expect(card.queryByRole('button', { name: /delete/i })).toBeNull();
  });

  it('a failed availability read fails closed: the support line, no retry noise', async () => {
    answers[`GET ${AVAILABILITY}`] = { status: 503, body: { code: 'customers.unavailable' } };
    settings();
    const card = await privacy();
    expect(await card.findByText(hint)).toBeTruthy();
    expect(card.queryByRole('alert')).toBeNull();
    expect(card.queryByRole('link', { name: 'Delete account' })).toBeNull();
  });

  it('On: a row with the waiting period of the API and a link to the delete page', async () => {
    answers[`GET ${AVAILABILITY}`] = on(21);
    settings();
    const card = await privacy();
    expect(
      await card.findByText(
        'Your account and personal details will be removed after 21 days. Order records stay for legal reasons but are no longer linked to you.',
      ),
    ).toBeTruthy();
    expect(card.getByRole('link', { name: 'Delete account' }).getAttribute('href')).toBe(
      '/account/delete',
    );
    expect(card.queryByText(hint)).toBeNull();
  });

  it('an open request shows its date and Cancel deletion instead of the row', async () => {
    answers[`GET ${AVAILABILITY}`] = on();
    answers[`GET ${CURRENT}`] = open();
    settings();
    const card = await privacy();
    expect(await card.findByText(DATE)).toBeTruthy();
    expect(card.getByText('You can cancel until then.')).toBeTruthy();
    expect(card.getByRole('button', { name: 'Cancel deletion' })).toBeTruthy();
    expect(card.queryByRole('link', { name: 'Delete account' })).toBeNull();
  });

  it('an open request shows even when the setting went Off', async () => {
    answers[`GET ${CURRENT}`] = open();
    settings();
    const card = await privacy();
    expect(await card.findByRole('button', { name: 'Cancel deletion' })).toBeTruthy();
  });

  it('a request being carried out cannot be cancelled', async () => {
    answers[`GET ${CURRENT}`] = open('executing');
    settings();
    const card = await privacy();
    expect(
      await card.findByText("Your account is being deleted now. It can't be cancelled."),
    ).toBeTruthy();
    expect(card.queryByRole('button', { name: 'Cancel deletion' })).toBeNull();
  });

  it('Cancel deletion sends the cancel with the CSRF token and says the account stays', async () => {
    answers[`GET ${AVAILABILITY}`] = on();
    answers[`GET ${CURRENT}`] = open();
    answers[`DELETE ${CURRENT}`] = { status: 204 };
    settings();
    const card = await privacy();
    fireEvent.click(await card.findByRole('button', { name: 'Cancel deletion' }));
    const note = await card.findByText('Deletion cancelled. Your account stays open.');
    expect(note.closest('[role="status"]')).toBeTruthy();
    expect(called('DELETE', CURRENT)[0]?.headers['x-csrf-token']).toBe('csrf-1');
    expect(card.queryByRole('button', { name: 'Cancel deletion' })).toBeNull();
    expect(card.getByRole('link', { name: 'Delete account' })).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(note.closest('p')));
  });

  it('a cancel that came too late says it is being deleted and drops the button', async () => {
    answers[`GET ${CURRENT}`] = open();
    answers[`DELETE ${CURRENT}`] = refused(409, 'customers.account-deletion-in-progress');
    settings();
    const card = await privacy();
    fireEvent.click(await card.findByRole('button', { name: 'Cancel deletion' }));
    expect(
      await card.findByText("Your account is being deleted now. It can't be cancelled."),
    ).toBeTruthy();
    expect(card.queryByRole('button', { name: 'Cancel deletion' })).toBeNull();
  });

  it('a cancel conflict asks to try again and keeps the button', async () => {
    answers[`GET ${CURRENT}`] = open();
    answers[`DELETE ${CURRENT}`] = refused(409, 'customers.conflict');
    settings();
    const card = await privacy();
    fireEvent.click(await card.findByRole('button', { name: 'Cancel deletion' }));
    expect((await card.findByRole('alert')).textContent).toContain('Please try again.');
    expect(card.getByRole('button', { name: 'Cancel deletion' })).toBeTruthy();
  });

  it('a failed cancel says so', async () => {
    answers[`GET ${CURRENT}`] = open();
    answers[`DELETE ${CURRENT}`] = { status: 500, body: { code: 'internal' } };
    settings();
    const card = await privacy();
    fireEvent.click(await card.findByRole('button', { name: 'Cancel deletion' }));
    expect((await card.findByRole('alert')).textContent).toContain(
      'We could not cancel the deletion.',
    );
  });
});

describe('/account/delete', () => {
  const screenOn = () => {
    answers[`GET ${AVAILABILITY}`] = on();
    return show(<AccountDeleteScreen />);
  };
  const tick = async () => {
    const box = await screen.findByLabelText("I understand this can't be undone.");
    fireEvent.click(box);
    return box;
  };
  const press = () => fireEvent.click(screen.getByRole('button', { name: 'Delete my account' }));

  it('shows skeleton lines while it reads, then one h1 and the lists', async () => {
    let release: () => void = () => undefined;
    gate = new Promise<void>((resolve) => (release = resolve));
    screenOn();
    expect(await screen.findByText('Loading')).toBeTruthy();
    release();
    expect(await screen.findByRole('heading', { level: 2, name: 'What is removed' })).toBeTruthy();
    expect(screen.getAllByRole('heading', { level: 1 }).map((h) => h.textContent)).toEqual([
      'Delete account',
    ]);
    expect(screen.getByText('Your saved items')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'What stays' })).toBeTruthy();
    expect(screen.getByText(/as long as the law requires/)).toBeTruthy();
    expect(screen.getByText(/Former customer/)).toBeTruthy();
    expect(screen.getByText('Other devices are signed out when you confirm.')).toBeTruthy();
    expect(screen.getByText(/deleted in 14 days/)).toBeTruthy();
  });

  it('promises no email, lock, sign-in cancel or code', async () => {
    screenOn();
    await screen.findByRole('heading', { level: 2, name: 'What is removed' });
    const text = main().textContent ?? '';
    expect(text).not.toMatch(
      /email you|we.ll email|confirmation email|one-time|code|locked|sign in before|dispute/i,
    );
  });

  it('the danger button is disabled until the box is ticked and described by the checkbox', async () => {
    screenOn();
    const box = await tick();
    fireEvent.click(box);
    const button = screen.getByRole<HTMLButtonElement>('button', { name: 'Delete my account' });
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-describedby')).toBe(box.id);
    fireEvent.click(box);
    expect(button.disabled).toBe(false);
    expect(document.activeElement).not.toBe(button);
  });

  it('sends the confirmation with the CSRF token, then shows the pending state and moves focus', async () => {
    answers[`POST ${REQUESTS}`] = { ...open(), status: 201 };
    screenOn();
    await tick();
    press();
    const notice = await screen.findByText(DATE);
    expect(called('POST', REQUESTS)[0]?.body).toEqual({ confirm: true });
    expect(called('POST', REQUESTS)[0]?.headers['x-csrf-token']).toBe('csrf-1');
    const box = notice.closest('[role="status"]') as HTMLElement;
    await waitFor(() => expect(document.activeElement).toBe(box));
    expect(screen.getByRole('button', { name: 'Cancel deletion' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Delete my account' })).toBeNull();
  });

  it('blocked: a critical alert with the counts takes focus, links to orders, and the button stays off', async () => {
    answers[`POST ${REQUESTS}`] = refused(409, 'customers.account-deletion-blocked', {
      blockers: [
        { code: 'open-orders', count: 2 },
        { code: 'pending-refunds', count: 1 },
        { code: 'wallet-balance' },
      ],
    });
    screenOn();
    await tick();
    press();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(
      "You can't delete your account while you have an open order, refund or wallet balance.",
    );
    expect(within(alert).getByText(/2 open orders/)).toBeTruthy();
    expect(within(alert).getByText(/1 refund waiting/)).toBeTruthy();
    expect(
      within(alert).getByText(/wallet balance isn't zero. Use it first, or contact support/),
    ).toBeTruthy();
    expect(
      within(alert)
        .getAllByRole('link', { name: 'View orders' })
        .map((a) => a.getAttribute('href')),
    ).toEqual(['/account/orders', '/account/orders']);
    await waitFor(() => expect(document.activeElement).toBe(alert));
    expect(alert.getAttribute('tabindex')).toBe('-1');
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Delete my account' }).disabled,
    ).toBe(true);
    expect(called('POST', REQUESTS)).toHaveLength(1);
  });

  it('unavailable (403 account-deletion-disabled): inline text and a link back to Settings', async () => {
    answers[`POST ${REQUESTS}`] = refused(403, 'customers.account-deletion-disabled');
    screenOn();
    await tick();
    press();
    expect(await screen.findByText("This option isn't available right now.")).toBeTruthy();
    const links = screen.getAllByRole('link', { name: 'Back to Settings' });
    expect(links.at(-1)?.getAttribute('href')).toBe('/account/settings');
    expect(screen.queryByRole('button', { name: 'Delete my account' })).toBeNull();
  });

  it('a request that is already open shows its pending state', async () => {
    answers[`POST ${REQUESTS}`] = refused(409, 'customers.account-deletion-already-requested');
    screenOn();
    await tick();
    answers[`GET ${CURRENT}`] = open();
    press();
    expect(await screen.findByText(DATE)).toBeTruthy();
  });

  it('any other failure shows an alert and keeps the form', async () => {
    answers[`POST ${REQUESTS}`] = { status: 503, body: { code: 'customers.unavailable' } };
    screenOn();
    await tick();
    press();
    expect((await screen.findByRole('alert')).textContent).toContain(
      'We could not send your request.',
    );
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Delete my account' }).disabled,
    ).toBe(false);
  });

  it('Off with nothing open: redirects to Settings and shows no form', async () => {
    show(<AccountDeleteScreen />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/account/settings'));
    expect(screen.queryByRole('button', { name: 'Delete my account' })).toBeNull();
  });

  it('an availability read error also redirects (fail closed)', async () => {
    answers[`GET ${AVAILABILITY}`] = { status: 503, body: { code: 'customers.unavailable' } };
    show(<AccountDeleteScreen />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/account/settings'));
  });

  it('Off with an open request: no redirect, the pending state and Cancel are there', async () => {
    answers[`GET ${CURRENT}`] = open();
    show(<AccountDeleteScreen />);
    expect(await screen.findByText(DATE)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel deletion' })).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
  });

  it('cancelling here says the account stays and offers the way back, with no redirect', async () => {
    answers[`GET ${CURRENT}`] = open();
    answers[`DELETE ${CURRENT}`] = { status: 204 };
    show(<AccountDeleteScreen />);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel deletion' }));
    expect(await screen.findByText('Deletion cancelled. Your account stays open.')).toBeTruthy();
    expect(screen.getAllByRole('link', { name: 'Back to Settings' }).length).toBeGreaterThan(0);
    expect(replace).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(document.activeElement?.textContent).toBe(
        'Deletion cancelled. Your account stays open.',
      ),
    );
  });

  it('sample mode makes no request and redirects to Settings', async () => {
    show(<AccountDeleteScreen />, false);
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/account/settings'));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('409 answers', () => {
  it('only the deletion request reads a 409 as a refusal; other routes still fail', async () => {
    const api = await import('../src/account/customer-api.ts');
    answers['POST customers/me/addresses'] = refused(409, 'customers.conflict');
    answers[`POST ${REQUESTS}`] = refused(409, 'customers.account-deletion-blocked');
    answers['GET identity/customer/session'] = {
      status: 200,
      body: { email: 'a@b.c', csrfToken: 'c' },
    };
    const address = {
      firstName: 'A',
      lastName: 'B',
      phone: '1',
      street: 's',
      line2: null,
      suburb: 'k',
      region: 'QLD',
      postcode: '4000',
      deliveryNotes: null,
    };
    expect((await api.createAddress(address)).kind).toBe('failed');
    expect(await api.requestDeletion()).toMatchObject({
      kind: 'invalid',
      code: 'customers.account-deletion-blocked',
    });
  });
});

const main = () => screen.getByRole('main');
