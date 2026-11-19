// @vitest-environment jsdom
import { Toaster, toast } from '@mondapac/ui';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi, type ApiResult } from '../api/client.ts';
import { StepUpProvider } from '../step-up/step-up.tsx';
import { CustomerPage } from './customer-page.tsx';
import type { CustomerRow } from './list-types.ts';
import type { CustomerOverview } from './page-types.ts';

// Edit email and Cancel email change on the customer page (customers management phase 2b). Two
// Markets: AU (AUD, Brisbane) and NZ (NZD, Auckland), so the pending date follows the admin's zone.

const call = vi.mocked(callApi);
const wrap = (node: ReactNode) => (
  <NextIntlClientProvider locale="en-AU" messages={messages}>
    <StepUpProvider>
      {node}
      <Toaster labels={{ region: messages.toast.region, close: messages.toast.close }} />
    </StepUpProvider>
  </NextIntlClientProvider>
);
const ok = <T,>(body: T): ApiResult<T> => ({ ok: true, status: 200, body });
const refused = (status: number, code: string, details?: object): ApiResult<never> => ({
  ok: false,
  failure: { status, code, ...(details === undefined ? {} : { details }) },
});

const ID = '0190a000-0000-7000-8000-0000000000a1';
const VIEW = 'customers.customers.view';
const KEY = 'customers.customer-email.change';
const EMAIL_PATH = `customers/admin/customers/${ID}/email`;
const CANCEL_PATH = `customers/admin/customers/${ID}/email-change`;
const OPEN_ITEM = 'Edit email…';
const PENDING_ITEM = 'Change pending email…';

const markets = [
  {
    marketId: 'AU',
    currency: 'AUD',
    zone: 'Australia/Brisbane',
    date: '10 Nov 2026, 1:30 pm',
    zoneName: 'AEST',
  },
  {
    marketId: 'NZ',
    currency: 'NZD',
    zone: 'Pacific/Auckland',
    date: '10 Nov 2026, 4:30 pm',
    zoneName: 'NZDT',
  },
] as const;

const row = (currency: string): CustomerRow => ({
  accountId: ID,
  email: 'sara@example.com',
  displayName: 'Sara Ahmadi',
  status: 'active',
  emailVerified: true,
  signedUpAt: '2026-10-01T02:30:00.000Z',
  lastOrderAt: null,
  orderCount: 0,
  spentMinor: '0',
  currency,
  refundCount: 0,
  groups: [],
});
const overview = (over: Partial<CustomerOverview> = {}, currency = 'AUD'): CustomerOverview => ({
  ...row(currency),
  firstOrderAt: null,
  refundedMinor: '0',
  deletionRequest: null,
  pendingEmailChange: null,
  ...over,
});
const PENDING = { email: 'new@example.com', requestedAt: '2026-11-10T03:30:00.000Z' };

const props = (market: (typeof markets)[number]) => ({
  accountId: ID,
  adminAccountId: 'admin-1',
  marketId: market.marketId,
  initialTab: 'overview' as const,
  csrfToken: 'csrf',
  zone: market.zone,
  paging: 'pages' as const,
  waitingPeriodDays: null,
});

/** Routes the page reads; `write` answers the PUT, `cancel` the DELETE, in order. */
function route(body: unknown, write: ApiResult<unknown>[] = [], cancel: ApiResult<unknown>[] = []) {
  call.mockImplementation((method, path) => {
    if (path === `customers/admin/customers/${ID}` && method === 'GET') {
      return Promise.resolve(ok(body) as ApiResult<never>);
    }
    if (path === 'identity/admin/step-up/verify') {
      return Promise.resolve(ok({ code: 'step-up-verified' }) as ApiResult<never>);
    }
    if (path === EMAIL_PATH && method === 'PUT') {
      return Promise.resolve((write.shift() ?? ok({})) as ApiResult<never>);
    }
    if (path === CANCEL_PATH && method === 'DELETE') {
      return Promise.resolve((cancel.shift() ?? ok({ cancelled: true })) as ApiResult<never>);
    }
    if (path.includes('/activity')) {
      return Promise.resolve(
        ok({
          items: [],
          page: 1,
          pageSize: 25,
          paging: 'pages',
          total: 0,
          hasNext: false,
        }) as ApiResult<never>,
      );
    }
    if (path === 'customers/admin/groups')
      return Promise.resolve(ok({ items: [] }) as ApiResult<never>);
    return Promise.resolve(ok({ items: [], nextCursor: null }) as ApiResult<never>);
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});
afterEach(() => {
  toast.dismiss();
  cleanup();
});

const writes = () => call.mock.calls.filter((args) => args[0] === 'PUT' && args[1] === EMAIL_PATH);

async function openDialog(item = OPEN_ITEM) {
  fireEvent.click(await screen.findByRole('button', { name: 'More actions' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: item }));
  return screen.findByRole('dialog', { name: 'Edit email' });
}
const typeNew = (dialog: HTMLElement, value: string) =>
  fireEvent.change(within(dialog).getByLabelText('New email'), { target: { value } });
const send = (dialog: HTMLElement) =>
  fireEvent.click(within(dialog).getByRole('button', { name: 'Send confirmation' }));
const pasteCode = () =>
  act(() => {
    fireEvent.paste(screen.getAllByRole('textbox', { name: /Digit \d of 6/ })[0]!, {
      clipboardData: { getData: () => '123456' },
    });
  });

describe.each(markets)('Edit email, Market $marketId', (market) => {
  const currency = market.currency;

  it('is not offered without the key', async () => {
    route(overview({}, currency));
    render(wrap(<CustomerPage {...props(market)} permissionKeys={[VIEW]} />));
    await screen.findByRole('heading', { level: 1, name: 'Sara Ahmadi' });
    expect(screen.queryByRole('button', { name: 'More actions' })).toBeNull();
    expect(screen.queryByText('Pending new email')).toBeNull();
  });

  it('shows the note and the current address, asks for the two-step code, then shows the pending change', async () => {
    route(overview({}, currency), [
      refused(403, 'second-factor.required', { actionKey: KEY }),
      ok({ changed: true, requestedAt: PENDING.requestedAt }),
    ]);
    render(wrap(<CustomerPage {...props(market)} permissionKeys={[VIEW, KEY]} />));
    const dialog = await openDialog();
    expect(within(dialog).getByLabelText<HTMLInputElement>('Current email').value).toBe(
      'sara@example.com',
    );
    expect(
      within(dialog).getByText(/The current address keeps working until the customer confirms/),
    ).toBeTruthy();
    expect(within(dialog).queryByLabelText('Reason')).toBeNull();
    typeNew(dialog, ' new@example.com ');
    send(dialog);
    await screen.findByRole('dialog', { name: 'Confirm it is you' });
    pasteCode();
    expect(await screen.findByText('Confirmation sent to new@example.com.')).toBeTruthy();
    expect(call).toHaveBeenCalledWith(
      'POST',
      'identity/admin/step-up/verify',
      { actionKey: KEY, code: '123456' },
      'csrf',
    );
    expect(writes().map((args) => args[2])).toEqual([
      { email: 'new@example.com' },
      { email: 'new@example.com' },
    ]);
    expect(await screen.findByText('Pending new email')).toBeTruthy();
    const banner = screen.getByText(/Waiting for new@example.com to confirm/);
    expect(banner.textContent).toContain(`Requested ${market.date}`);
    expect(banner.textContent).toContain(market.zoneName);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit email' })).toBeNull());
  });

  it('keeps the dialog open and says nothing when the code dialog is cancelled', async () => {
    route(overview({}, currency), [refused(403, 'second-factor.required', { actionKey: KEY })]);
    render(wrap(<CustomerPage {...props(market)} permissionKeys={[VIEW, KEY]} />));
    const dialog = await openDialog();
    typeNew(dialog, 'new@example.com');
    send(dialog);
    const code = await screen.findByRole('dialog', { name: 'Confirm it is you' });
    fireEvent.click(within(code).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('Pending new email')).toBeNull();
  });

  it.each([
    ['validation.failed', 400, 'Enter a valid email address.'],
    ['customers.email-taken', 409, 'This email is already used by another account.'],
    [
      'customers.customer-not-eligible',
      409,
      /A disabled or unverified account cannot change its email/,
    ],
    ['customers.account-deletion-pending', 409, /deletion request pending/],
    ['customers.customer-not-found', 404, 'This customer no longer exists.'],
    ['access.denied', 403, /don.t have access to change emails/],
    ['access.unavailable', 503, 'The confirmation could not be sent. Try again.'],
  ] as const)('shows %s and keeps the dialog open', async (code, status, text) => {
    route(overview({}, currency), [refused(status, code)]);
    render(wrap(<CustomerPage {...props(market)} permissionKeys={[VIEW, KEY]} />));
    const dialog = await openDialog();
    typeNew(dialog, 'new@example.com');
    send(dialog);
    expect(await within(dialog).findByText(text)).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Edit email' })).toBeTruthy();
    expect(screen.queryByText('Pending new email')).toBeNull();
  });

  it('says how long to wait when throttled (429), rounding up to whole minutes', async () => {
    route(overview({}, currency), [refused(429, 'request.throttled', { retryAfterSeconds: 601 })]);
    render(wrap(<CustomerPage {...props(market)} permissionKeys={[VIEW, KEY]} />));
    const dialog = await openDialog();
    typeNew(dialog, 'new@example.com');
    send(dialog);
    expect(await within(dialog).findByText('Try again in 11 minutes.')).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Edit email' })).toBeTruthy();
  });

  it('refuses an empty, malformed or unchanged address without calling the API', async () => {
    route(overview({}, currency));
    render(wrap(<CustomerPage {...props(market)} permissionKeys={[VIEW, KEY]} />));
    const dialog = await openDialog();
    send(dialog);
    expect(await within(dialog).findByText('Enter the new email.')).toBeTruthy();
    typeNew(dialog, 'nope');
    send(dialog);
    expect(await within(dialog).findByText('Enter a valid email address.')).toBeTruthy();
    typeNew(dialog, 'SARA@example.com');
    send(dialog);
    expect(await within(dialog).findByText('This is already the current email.')).toBeTruthy();
    expect(writes()).toHaveLength(0);
  });

  it('treats changed: false as the current address', async () => {
    route(overview({}, currency), [ok({ changed: false, requestedAt: null })]);
    render(wrap(<CustomerPage {...props(market)} permissionKeys={[VIEW, KEY]} />));
    const dialog = await openDialog();
    typeNew(dialog, 'other@example.com');
    send(dialog);
    expect(await within(dialog).findByText('This is already the current email.')).toBeTruthy();
    expect(screen.queryByText('Pending new email')).toBeNull();
  });

  it('shows the pending change in the header and banner, in the admin zone', async () => {
    route(overview({ pendingEmailChange: PENDING }, currency));
    render(wrap(<CustomerPage {...props(market)} permissionKeys={[VIEW, KEY]} />));
    expect(await screen.findByText('Pending new email')).toBeTruthy();
    const banner = screen.getByText(/Waiting for new@example.com to confirm/);
    expect(banner.textContent).toContain('The current address stays until then.');
    expect(banner.textContent).toContain(market.date);
    expect(screen.getByRole('button', { name: 'Cancel email change…' })).toBeTruthy();
  });

  it('reads Change pending email… and says sending again replaces the request', async () => {
    route(overview({ pendingEmailChange: PENDING }, currency), [
      ok({ changed: true, requestedAt: '2026-11-11T00:00:00.000Z' }),
    ]);
    render(wrap(<CustomerPage {...props(market)} permissionKeys={[VIEW, KEY]} />));
    const dialog = await openDialog(PENDING_ITEM);
    expect(within(dialog).getByLabelText<HTMLInputElement>('Pending new email').value).toBe(
      'new@example.com',
    );
    expect(within(dialog).getByText('Sending again replaces the pending request.')).toBeTruthy();
    typeNew(dialog, 'third@example.com');
    send(dialog);
    await waitFor(() =>
      expect(screen.getByText(/Waiting for third@example.com to confirm/)).toBeTruthy(),
    );
  });

  it('cancels the pending change after a level 2 confirmation and the two-step code', async () => {
    route(
      overview({ pendingEmailChange: PENDING }, currency),
      [],
      [refused(403, 'second-factor.required', { actionKey: KEY }), ok({ cancelled: true })],
    );
    render(wrap(<CustomerPage {...props(market)} permissionKeys={[VIEW, KEY]} />));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel email change…' }));
    const confirm = await screen.findByRole('dialog', { name: 'Cancel the email change?' });
    expect(within(confirm).getByText(/new@example.com will not be used/)).toBeTruthy();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel email change' }));
    await screen.findByRole('dialog', { name: 'Confirm it is you' });
    pasteCode();
    expect(await screen.findByText('Email change cancelled.')).toBeTruthy();
    expect(screen.queryByText('Pending new email')).toBeNull();
    expect(call).toHaveBeenCalledWith('DELETE', CANCEL_PATH, undefined, 'csrf');
  });

  it('keeps the confirmation open on a failed cancel, and clears an already-gone change', async () => {
    route(
      overview({ pendingEmailChange: PENDING }, currency),
      [],
      [refused(503, 'customers.unavailable'), refused(404, 'customers.email-change-not-found')],
    );
    render(wrap(<CustomerPage {...props(market)} permissionKeys={[VIEW, KEY]} />));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel email change…' }));
    const confirm = await screen.findByRole('dialog', { name: 'Cancel the email change?' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel email change' }));
    expect(
      await within(confirm).findByText('The email change could not be cancelled. Try again.'),
    ).toBeTruthy();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel email change' }));
    expect(
      await screen.findByText('There is no pending email change any more.', undefined, {
        timeout: 3000,
      }),
    ).toBeTruthy();
    expect(screen.queryByText('Pending new email')).toBeNull();
  });

  it('keeps the confirmation open with the wait when the cancel is throttled', async () => {
    route(
      overview({ pendingEmailChange: PENDING }, currency),
      [],
      [refused(429, 'request.throttled', { retryAfterSeconds: 150 })],
    );
    render(wrap(<CustomerPage {...props(market)} permissionKeys={[VIEW, KEY]} />));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel email change…' }));
    const confirm = await screen.findByRole('dialog', { name: 'Cancel the email change?' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel email change' }));
    expect(
      await within(confirm).findByText('Too many attempts. Try again in 3 minutes.'),
    ).toBeTruthy();
  });

  it('offers no cancel button in the banner without the key', async () => {
    route(overview({ pendingEmailChange: PENDING }, currency));
    render(wrap(<CustomerPage {...props(market)} permissionKeys={[VIEW]} />));
    expect(await screen.findByText(/Waiting for new@example.com to confirm/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Cancel email change…' })).toBeNull();
  });

  it('shows nothing of it for an erased customer', async () => {
    route({ accountId: ID, status: 'deleted', deletedAt: '2026-11-10T23:30:00Z' });
    render(wrap(<CustomerPage {...props(market)} permissionKeys={[VIEW, KEY]} />));
    expect(await screen.findByText('Account deleted')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'More actions' })).toBeNull();
    expect(screen.queryByText('Pending new email')).toBeNull();
  });
});
