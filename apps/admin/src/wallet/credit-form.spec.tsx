// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { STEP_UP_CANCELLED } from '../step-up/step-up.tsx';
import { CreditForm } from './credit-form.tsx';
import type { AdminCredit, CustomerWallet } from './types.ts';

const call = vi.mocked(callApi);
const ID = '0190a000-0000-7000-8000-0000000000c1';
const ok = (body: unknown, status = 200) => ({ ok: true as const, status, body });
const refused = (status: number, code: string, details?: object) => ({
  ok: false as const,
  failure: { status, code, ...(details ? { details } : {}) },
});

// Two Market fixtures: AU with dollars (2 decimals) and a synthetic one with yen (0 decimals).
const AUD: CustomerWallet = {
  customerAccountId: ID,
  currency: 'AUD',
  marketStatus: 'active',
  accountStatus: 'active',
  available: '12050',
  held: '0',
  balanceCap: '1000000',
  roomUnderCap: '987950',
  issueCap: '50000',
  dailyCap: '200000',
  usedToday: '0',
};
const JPY: CustomerWallet = {
  ...AUD,
  currency: 'JPY',
  available: '1500',
  roomUnderCap: '98500',
  balanceCap: '100000',
  issueCap: '50000',
  dailyCap: '200000',
};
const FIXTURES = [
  { name: 'AU / AUD', wallet: AUD, typed: '25', minor: '2500', big: '5000.00', example: '25.00' },
  {
    name: 'synthetic / JPY',
    wallet: JPY,
    typed: '2500',
    minor: '2500',
    big: '50001',
    example: '25',
  },
] as const;

const credit = (over: Partial<AdminCredit> = {}): AdminCredit => ({
  id: '0190a000-0000-7000-8000-0000000000e1',
  customerAccountId: ID,
  amount: '2500',
  currency: 'AUD',
  reasonCode: 'goodwill',
  note: null,
  status: 'granted',
  approvalReason: null,
  requestedBy: 'a1',
  requestedAt: '2026-10-27T01:00:00.000Z',
  expiresAt: null,
  decidedBy: null,
  decidedAt: null,
  decisionReason: null,
  journalId: null,
  ...over,
});

function mount(over: { canIssue?: boolean; settings?: boolean; requests?: boolean } = {}) {
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <CreditForm
        customerId={ID}
        canIssue={over.canIssue ?? true}
        canViewSettings={over.settings ?? true}
        canViewRequests={over.requests ?? true}
        csrfToken="csrf"
      />
    </NextIntlClientProvider>,
  );
}
const loaded = async (wallet: CustomerWallet) => {
  call.mockResolvedValueOnce(ok(wallet));
  // Later reads (the summary refresh after a write) see the same wallet unless a test says more.
  call.mockResolvedValue(ok(wallet));
  mount();
  await screen.findByRole('button', { name: 'Issue credit' });
};
const amountField = () => screen.getByLabelText<HTMLInputElement>(/^Amount \(/);
const fill = (amount: string, reason = 'goodwill', note = '') => {
  fireEvent.change(amountField(), { target: { value: amount } });
  if (reason !== '')
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: reason } });
  if (note !== '')
    fireEvent.change(screen.getByLabelText('Note (admins only)'), { target: { value: note } });
};
const submit = () => fireEvent.click(screen.getByRole('button', { name: 'Issue credit' }));
const lastPost = () => {
  const posts = call.mock.calls.filter((entry) => entry[0] === 'POST');
  return posts[posts.length - 1] as unknown as [string, string, Record<string, unknown>, string];
};

beforeEach(() => {
  vi.resetAllMocks();
});
afterEach(cleanup);

describe('CreditForm summary', () => {
  it('shows the wallet and the caps of the calling admin in the Market currency', async () => {
    await loaded(AUD);
    expect(call).toHaveBeenCalledWith('GET', `wallet/admin/customers/${ID}`);
    expect(screen.getByText('000000C1')).toBeTruthy();
    expect(screen.getByText('Wallet active')).toBeTruthy();
    expect(screen.getByText('$120.50')).toBeTruthy();
    expect(screen.getByText('$0.00 of $2,000.00')).toBeTruthy();
    expect(screen.getByText('Over $500.00 needs a second admin')).toBeTruthy();
    expect(screen.getByLabelText('Amount (AUD)')).toBeTruthy();
  });

  it('formats a yen wallet without cents', async () => {
    await loaded(JPY);
    expect(screen.getByLabelText('Amount (JPY)')).toBeTruthy();
    expect(screen.getByText(/Up to .*98,500 can still be added/)).toBeTruthy();
    expect(screen.queryByText(/\.00/)).toBeNull();
  });

  it('says there is no wallet yet for a customer who never had credit', async () => {
    await loaded({ ...AUD, accountStatus: 'none', available: '0', roomUnderCap: '1000000' });
    expect(screen.getByText('No wallet yet')).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Issue credit' }).disabled).toBe(
      false,
    );
  });

  it('shows a loading state and a load error with retry', async () => {
    call.mockResolvedValueOnce(refused(503, 'wallet.unavailable'));
    mount();
    expect(screen.getByText('Loading')).toBeTruthy();
    expect(await screen.findByRole('alert')).toBeTruthy();
    call.mockResolvedValueOnce(ok(AUD));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: 'Issue credit' })).toBeTruthy();
  });

  it('says the wallet is switched off when the summary route answers wallet.disabled', async () => {
    call.mockResolvedValueOnce(refused(404, 'wallet.disabled'));
    mount();
    expect(await screen.findByText('The wallet is switched off for this Market.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Issue credit' })).toBeNull();
  });

  it.each([
    ['paused', 'The wallet is paused, so credit cannot be issued.'],
    ['frozen', 'The wallet is frozen, so credit cannot be issued.'],
    ['off', 'The wallet is switched off for this Market.'],
  ] as const)('blocks the form when the Market wallet is %s', async (state, text) => {
    call.mockResolvedValueOnce(ok({ ...AUD, marketStatus: state }));
    mount();
    expect(await screen.findByText(new RegExp(text))).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Issue credit' }).disabled).toBe(
      true,
    );
    expect(screen.getByRole('link', { name: 'Open the wallet switch' }).getAttribute('href')).toBe(
      '/settings/wallet',
    );
  });

  it('leaves the switch link out without wallet.settings.view', async () => {
    call.mockResolvedValueOnce(ok({ ...AUD, marketStatus: 'paused' }));
    mount({ settings: false });
    await screen.findByText(/The wallet is paused/);
    expect(screen.queryByRole('link', { name: 'Open the wallet switch' })).toBeNull();
  });

  it.each(['frozen', 'closed'] as const)('blocks a %s customer wallet', async (accountStatus) => {
    call.mockResolvedValueOnce(ok({ ...AUD, accountStatus }));
    mount();
    expect(await screen.findByText("This customer's wallet cannot receive credit.")).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Issue credit' }).disabled).toBe(
      true,
    );
  });

  it('shows the summary without a form to an admin who cannot issue', async () => {
    call.mockResolvedValueOnce(ok(AUD));
    mount({ canIssue: false });
    await screen.findByText('Wallet active');
    expect(screen.queryByLabelText('Reason')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Issue credit' })).toBeNull();
  });
});

describe.each(FIXTURES)('CreditForm amounts: $name', ({ wallet, typed, minor, big, example }) => {
  it('sends the amount in minor units of the currency', async () => {
    await loaded(wallet);
    call.mockResolvedValueOnce(ok(credit({ amount: minor, currency: wallet.currency }), 201));
    fill(typed, 'goodwill', '  A note\nsecond line  ');
    submit();
    await screen.findByText('Credit issued');
    expect(lastPost()[1]).toBe('wallet/admin/credits');
    expect(lastPost()[2]).toMatchObject({
      customerAccountId: ID,
      amount: minor,
      currency: wallet.currency,
      reasonCode: 'goodwill',
      note: 'A note\nsecond line',
    });
    expect(lastPost()[3]).toBe('csrf');
  });

  it('asks for an amount like the currency writes it', async () => {
    await loaded(wallet);
    fill('');
    submit();
    expect(screen.getByText('Enter an amount.')).toBeTruthy();
    fill('abc');
    submit();
    expect(screen.getByText(`Enter an amount like ${example}.`)).toBeTruthy();
    fill('0');
    submit();
    expect(screen.getByText('The amount must be more than zero.')).toBeTruthy();
    expect(call.mock.calls.filter((entry) => entry[0] === 'POST')).toHaveLength(0);
  });

  it('refuses more than the wallet can hold, before sending', async () => {
    await loaded(wallet);
    fill(wallet.currency === 'JPY' ? '98501' : '9879.51');
    submit();
    expect(
      screen.getByText(/This is more than the wallet can hold\. At most .* can be added\./),
    ).toBeTruthy();
    expect(call.mock.calls.filter((entry) => entry[0] === 'POST')).toHaveLength(0);
  });

  it('hints at once or approval, advisory only', async () => {
    await loaded(wallet);
    fill(typed);
    expect(screen.getByText('Granted immediately.')).toBeTruthy();
    fill(big);
    expect(screen.getByText('Needs a second admin to approve.')).toBeTruthy();
  });
});

describe('CreditForm hint: daily cap', () => {
  it('counts what was already issued today', async () => {
    await loaded({ ...AUD, usedToday: '190000' });
    fill('150');
    expect(screen.getByText('Needs a second admin to approve.')).toBeTruthy();
    fill('50');
    expect(screen.getByText('Granted immediately.')).toBeTruthy();
  });
});

describe('CreditForm form rules', () => {
  it('requires a reason and refuses forbidden note characters', async () => {
    await loaded(AUD);
    fill('25', '');
    submit();
    expect(screen.getByText('Choose a reason.')).toBeTruthy();
    fill('25', 'goodwill', 'bad\u0007note');
    submit();
    expect(screen.getByText('The note has characters that are not allowed.')).toBeTruthy();
    expect(screen.getByText(/\d+\/500/)).toBeTruthy();
    expect(call.mock.calls.filter((entry) => entry[0] === 'POST')).toHaveLength(0);
  });

  it('summarises problems in an alert that takes focus', async () => {
    await loaded(AUD);
    submit();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Check the highlighted fields');
    await waitFor(() => expect(alert.parentElement).toBe(document.activeElement));
  });

  it('maps field errors from the API to their fields', async () => {
    await loaded(AUD);
    fill('25');
    call.mockResolvedValueOnce(
      refused(400, 'validation.failed', { fields: [{ path: 'note', code: 'format' }] }),
    );
    submit();
    expect(await screen.findByText('The note has characters that are not allowed.')).toBeTruthy();
  });
});

describe('CreditForm outcomes', () => {
  it('shows a granted credit, resets the form and refreshes the summary', async () => {
    await loaded(AUD);
    fill('25', 'goodwill', 'hello');
    call.mockResolvedValueOnce(ok(credit(), 201));
    call.mockResolvedValueOnce(ok({ ...AUD, usedToday: '2500' }));
    submit();
    const banner = await screen.findByText('Credit issued');
    expect(banner.closest('[role="status"]')?.textContent).toContain(
      "$25.00 was added to the customer's wallet now.",
    );
    expect(screen.getByText('Reference id')).toBeTruthy();
    expect(screen.getByText('000000E1')).toBeTruthy();
    expect(amountField().value).toBe('');
    expect(screen.getByLabelText<HTMLSelectElement>('Reason').value).toBe('');
    await waitFor(() => expect(screen.getByText('$25.00 of $2,000.00')).toBeTruthy());
  });

  it('shows a pending credit differently, with the cap, expiry and the approvals link', async () => {
    await loaded(AUD);
    fill('900');
    call.mockResolvedValueOnce(
      ok(
        credit({
          amount: '90000',
          status: 'pending',
          approvalReason: 'issue-cap',
          expiresAt: '2026-10-29T01:00:00.000Z',
        }),
        201,
      ),
    );
    call.mockResolvedValueOnce(ok(AUD));
    submit();
    expect(await screen.findByText('Sent for approval')).toBeTruthy();
    expect(screen.queryByText('Credit issued')).toBeNull();
    const banner = screen.getByText('Sent for approval').closest('[role="status"]');
    expect(banner?.textContent).toContain('$900.00 is above your limit');
    expect(banner?.textContent).toContain('Reason: more than $500.00 in one credit.');
    expect(banner?.textContent).toContain('It expires 29 Oct 2026, 1:00 am UTC if nobody decides.');
    expect(screen.getByRole('link', { name: 'Open approvals' }).getAttribute('href')).toBe(
      '/wallet/credit-requests',
    );
  });

  it('names the daily cap as the reason, and hides the link without view', async () => {
    call.mockResolvedValueOnce(ok(AUD));
    mount({ requests: false });
    await screen.findByRole('button', { name: 'Issue credit' });
    fill('100');
    call.mockResolvedValueOnce(ok(credit({ status: 'pending', approvalReason: 'daily-cap' }), 201));
    call.mockResolvedValueOnce(ok(AUD));
    submit();
    expect(await screen.findByText(/this would take you over \$2,000\.00 today/)).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Open approvals' })).toBeNull();
  });

  it('shows a yen credit in yen', async () => {
    await loaded(JPY);
    fill('2500');
    call.mockResolvedValueOnce(ok(credit({ currency: 'JPY', amount: '2500' }), 201));
    call.mockResolvedValueOnce(ok(JPY));
    submit();
    const banner = (await screen.findByText('Credit issued')).closest('[role="status"]');
    expect(banner?.textContent).toMatch(/2,500 was added/);
    expect(banner?.textContent).not.toMatch(/25\.00/);
  });
});

describe('CreditForm refusals', () => {
  it.each([
    ['wallet.disabled', 404, 'The wallet is switched off for this Market.'],
    ['wallet.paused', 409, 'The wallet is paused, so credit cannot be issued.'],
    ['wallet.frozen', 409, 'The wallet is frozen, so credit cannot be issued.'],
    ['wallet.cap-exceeded', 409, 'This is more than the wallet can hold. Lower the amount.'],
    ['wallet.account-not-active', 409, "This customer's wallet cannot receive credit."],
    ['wallet.customer-not-found', 404, 'We could not find that customer.'],
    ['idempotency.key-reused', 409, 'Reload the page to start again.'],
    ['access.denied', 403, 'You cannot issue credit.'],
    ['wallet.unavailable', 503, 'the same request will not be issued twice'],
    ['unknown.thing', 500, 'Something went wrong.'],
  ])('says what %s means', async (code, status, text) => {
    await loaded(AUD);
    fill('25');
    call.mockResolvedValueOnce(refused(status, code));
    call.mockResolvedValue(ok(AUD));
    submit();
    const alert = await screen.findByText(new RegExp(text));
    expect(alert).toBeTruthy();
  });

  it('says nothing when the code dialog is cancelled', async () => {
    await loaded(AUD);
    fill('25');
    call.mockResolvedValueOnce({ ok: false, failure: { status: 0, code: STEP_UP_CANCELLED } });
    submit();
    await waitFor(() => expect(call).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(amountField().value).toBe('25');
  });
});

describe('CreditForm idempotency', () => {
  it('reuses the key on a retry after a lost answer and makes a new one after success', async () => {
    await loaded(AUD);
    fill('25');
    call.mockResolvedValueOnce(refused(0, 'network'));
    submit();
    await screen.findByText(/the same request will not be issued twice/);
    call.mockResolvedValueOnce(ok(credit(), 201));
    call.mockResolvedValueOnce(ok(AUD));
    submit();
    await screen.findByText('Credit issued');
    const posts = call.mock.calls.filter((entry) => entry[0] === 'POST');
    const first = (posts[0]?.[2] as { idempotencyKey: string }).idempotencyKey;
    const second = (posts[1]?.[2] as { idempotencyKey: string }).idempotencyKey;
    expect(first).toMatch(/^adm-[0-9a-f-]{36}$/);
    expect(second).toBe(first);
    fill('25');
    call.mockResolvedValueOnce(ok(credit(), 201));
    call.mockResolvedValueOnce(ok(AUD));
    submit();
    await waitFor(() =>
      expect(call.mock.calls.filter((entry) => entry[0] === 'POST')).toHaveLength(3),
    );
    const third = (lastPost()[2] as { idempotencyKey: string }).idempotencyKey;
    expect(third).not.toBe(first);
  });

  it('uses a new key for a changed request and after a final refusal', async () => {
    await loaded(AUD);
    fill('25');
    call.mockResolvedValueOnce(refused(0, 'network'));
    submit();
    await screen.findByText(/the same request will not be issued twice/);
    fill('30');
    call.mockResolvedValueOnce(refused(409, 'wallet.cap-exceeded'));
    call.mockResolvedValue(ok(AUD));
    submit();
    await screen.findByText(/Lower the amount/);
    const posts = call.mock.calls.filter((entry) => entry[0] === 'POST');
    const keys = posts.map((entry) => (entry[2] as { idempotencyKey: string }).idempotencyKey);
    expect(keys[1]).not.toBe(keys[0]);
    call.mockResolvedValueOnce(refused(409, 'wallet.cap-exceeded'));
    submit();
    await waitFor(() =>
      expect(call.mock.calls.filter((entry) => entry[0] === 'POST')).toHaveLength(3),
    );
    const again = (lastPost()[2] as { idempotencyKey: string }).idempotencyKey;
    expect(again).not.toBe(keys[1]);
  });

  it('sends one request for a double click', async () => {
    await loaded(AUD);
    fill('25');
    let release: (value: ReturnType<typeof ok>) => void = () => {};
    call.mockReturnValueOnce(new Promise((resolve) => (release = resolve)));
    call.mockResolvedValue(ok(AUD));
    submit();
    submit();
    release(ok(credit(), 201));
    await screen.findByText('Credit issued');
    expect(call.mock.calls.filter((entry) => entry[0] === 'POST')).toHaveLength(1);
  });
});

describe('CreditForm: keeping the key when the answer is unclear', () => {
  it.each([
    [500, 'unknown'],
    [502, 'unknown'],
    [504, 'unknown'],
    [500, 'something.else'],
  ])('reuses the key after a %s (%s) and resubmits', async (status, code) => {
    await loaded(AUD);
    fill('25');
    call.mockResolvedValueOnce(refused(status, code));
    submit();
    await screen.findByText(/Something went wrong/);
    call.mockResolvedValueOnce(ok(credit(), 201));
    submit();
    await screen.findByText('Credit issued');
    const posts = call.mock.calls.filter((entry) => entry[0] === 'POST');
    const keys = posts.map((entry) => (entry[2] as { idempotencyKey: string }).idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
  });

  it('drops the key only on a definite refusal', async () => {
    await loaded(AUD);
    fill('25');
    call.mockResolvedValueOnce(refused(409, 'wallet.paused'));
    submit();
    await screen.findByText(/The wallet is paused/);
    call.mockResolvedValueOnce(refused(403, 'access.denied'));
    submit();
    await waitFor(() =>
      expect(call.mock.calls.filter((entry) => entry[0] === 'POST')).toHaveLength(2),
    );
    const keys = call.mock.calls
      .filter((entry) => entry[0] === 'POST')
      .map((entry) => (entry[2] as { idempotencyKey: string }).idempotencyKey);
    expect(keys[1]).not.toBe(keys[0]);
  });
});

describe('CreditForm: unusual data from the server', () => {
  it('says the customer was not found, with a way back to the lookup', async () => {
    call.mockResolvedValueOnce(refused(404, 'wallet.customer-not-found'));
    mount();
    expect(await screen.findByText('We could not find that customer.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Find a customer' }).getAttribute('href')).toBe(
      '/customers',
    );
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('links to the wallet switch from the switched-off message', async () => {
    call.mockResolvedValueOnce(refused(404, 'wallet.disabled'));
    mount();
    expect(
      (await screen.findByRole('link', { name: 'Open the wallet switch' })).getAttribute('href'),
    ).toBe('/settings/wallet');
  });

  it('does not offer the form for a currency it does not know', async () => {
    call.mockResolvedValueOnce(ok({ ...AUD, currency: 'ZZZ' }));
    mount();
    expect(await screen.findByText(/currency is not supported/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Issue credit' })).toBeNull();
  });

  it('treats a wallet state it does not know as a load error', async () => {
    call.mockResolvedValueOnce(ok({ ...AUD, marketStatus: 'short' }));
    mount();
    expect(await screen.findByRole('alert')).toBeTruthy();
  });

  it('shows an odd reason code as plain text, not as a message path', async () => {
    await loaded(AUD);
    fill('25');
    call.mockResolvedValueOnce(ok(credit({ reasonCode: 'x.y' }), 201));
    submit();
    await screen.findByText('Credit issued');
    expect(screen.getByText('x.y')).toBeTruthy();
  });
});
