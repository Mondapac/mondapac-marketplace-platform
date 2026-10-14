// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { visibleNavItems } from '@mondapac/ui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';
import { sellerNav } from '../nav.ts';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { payoutProblemOf } from './errors.ts';
import { PayoutAccountView } from './payout-account.tsx';
import type { PayoutAccount, StripeReturn } from './types.ts';

const call = vi.mocked(callApi);
const account = (over: Partial<PayoutAccount> = {}): PayoutAccount => ({
  status: 'not-connected',
  ready: false,
  requirementsDue: 0,
  requirementsPastDue: false,
  secondFactorActive: true,
  coolingOffUntil: null,
  payoutsPaused: false,
  changes: [],
  ...over,
});

const assign = vi.fn();

beforeEach(() => {
  call.mockReset();
  assign.mockReset();
  vi.stubGlobal('location', { ...window.location, assign });
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function mount(initial: PayoutAccount, back: StripeReturn = null, canManage = true) {
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <PayoutAccountView initial={initial} csrfToken="csrf-1" canManage={canManage} back={back} />
    </NextIntlClientProvider>,
  );
}

const open = (name: string) => {
  fireEvent.click(screen.getByRole('button', { name }));
  return screen.getByRole('dialog', { hidden: true });
};
const enter = (dialog: HTMLElement, code: string) => {
  fireEvent.change(within(dialog).getByLabelText('Code'), { target: { value: code } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
};

describe('payout account status', () => {
  it('says not connected and offers to connect', () => {
    mount(account());
    expect(screen.getAllByText('Not connected').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Connect payout account' })).toBeTruthy();
    expect(screen.getByText('No changes yet.')).toBeTruthy();
  });

  it.each([
    ['not-started', 'Not started', 'Continue on Stripe'],
    ['pending', 'Pending', 'Continue on Stripe'],
    ['restricted', 'Restricted', 'Continue on Stripe'],
    ['enabled', 'Enabled', 'Review details on Stripe'],
    ['rejected', 'Rejected', 'Review details on Stripe'],
  ])('shows %s with the matching action', (status, label, action) => {
    mount(account({ status }));
    expect(screen.getByText(label, { selector: 'span' })).toBeTruthy();
    expect(screen.getByRole('button', { name: action })).toBeTruthy();
  });

  it('shows readiness, requirements due and past due', () => {
    mount(account({ status: 'restricted', requirementsDue: 3, requirementsPastDue: true }));
    expect(screen.getByText('Not ready for payouts')).toBeTruthy();
    expect(screen.getByText('3 items')).toBeTruthy();
    expect(screen.getByText(/past due/i, { selector: '[role="alert"]' })).toBeTruthy();
  });

  it('shows a ready account', () => {
    mount(account({ status: 'enabled', ready: true }));
    expect(screen.getByText('Ready for payouts')).toBeTruthy();
    expect(screen.getByText('None')).toBeTruthy();
  });

  it('shows the waiting period and paused payouts while it runs', () => {
    vi.useFakeTimers({ now: new Date('2026-10-14T00:00:00.000Z'), toFake: ['Date'] });
    mount(
      account({
        status: 'enabled',
        coolingOffUntil: '2026-10-16T03:30:00.000Z',
        payoutsPaused: true,
      }),
    );
    expect(screen.getByText('Waiting period after a bank account change')).toBeTruthy();
    expect(screen.getByText(/16 Oct 2026/)).toBeTruthy();
    expect(screen.getByText(/Payouts are paused until then/)).toBeTruthy();
  });

  it('leaves the waiting-period notice out once the date has passed', () => {
    vi.useFakeTimers({ now: new Date('2026-10-20T00:00:00.000Z'), toFake: ['Date'] });
    mount(account({ status: 'enabled', coolingOffUntil: '2026-10-16T03:30:00.000Z' }));
    expect(screen.queryByText('Waiting period after a bank account change')).toBeNull();
  });

  it('lists the recent changes, newest first', () => {
    mount(
      account({
        status: 'enabled',
        changes: [
          { detectedAt: '2026-10-13T01:00:00.000Z', kind: 'updated' },
          { detectedAt: '2026-10-01T01:00:00.000Z', kind: 'initial' },
        ],
      }),
    );
    const items = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(items[0]).toContain('Bank account updated');
    expect(items[1]).toContain('First bank account added');
  });

  it('tells the seller they are back from Stripe, or that the link expired', () => {
    mount(account({ status: 'pending' }), 'return');
    expect(screen.getByText('Back from Stripe')).toBeTruthy();
    cleanup();
    mount(account({ status: 'pending' }), 'refresh');
    expect(screen.getByText('The Stripe link expired')).toBeTruthy();
  });

  it('refreshes the status on request', async () => {
    mount(account({ status: 'pending' }), 'return');
    call.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: account({ status: 'enabled', ready: true }),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Check status' }));
    expect(await screen.findByText('Ready for payouts')).toBeTruthy();
    expect(call).toHaveBeenCalledWith('GET', 'payments/seller/payout-account');
  });
});

describe('two-step sign-in off', () => {
  it('explains and links to Security instead of the button', () => {
    mount(account({ secondFactorActive: false }));
    expect(screen.queryByRole('button', { name: 'Connect payout account' })).toBeNull();
    const link = screen.getByRole('link', { name: 'Go to Security' });
    expect(link.getAttribute('href')).toBe('/account/security');
  });

  it('shows no action to someone without the manage key', () => {
    mount(account(), null, false);
    expect(screen.queryByRole('button', { name: 'Connect payout account' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Go to Security' })).toBeNull();
  });
});

describe('code dialog', () => {
  it('connects with the typed code and goes to Stripe without keeping the address', async () => {
    mount(account());
    const dialog = open('Connect payout account');
    call.mockResolvedValueOnce({
      ok: true,
      status: 201,
      body: {
        ...account({ status: 'not-started' }),
        url: 'https://connect.stripe.com/setup/e/abc',
      },
    });
    enter(dialog, '123 456');
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith('https://connect.stripe.com/setup/e/abc'),
    );
    expect(call).toHaveBeenCalledWith(
      'POST',
      'payments/seller/payout-account',
      { code: '123456' },
      'csrf-1',
    );
  });

  it('uses the link route once the account exists', async () => {
    mount(account({ status: 'pending' }));
    const dialog = open('Continue on Stripe');
    call.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: { ...account({ status: 'pending' }), url: 'https://connect.stripe.com/x' },
    });
    enter(dialog, 'ABCD-EFGH');
    await waitFor(() => expect(assign).toHaveBeenCalled());
    expect(call).toHaveBeenCalledWith(
      'POST',
      'payments/seller/payout-account/link',
      { code: 'ABCDEFGH' },
      'csrf-1',
    );
  });

  it('asks for a code before calling', () => {
    mount(account());
    const dialog = open('Connect payout account');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
    expect(within(dialog).getByText(/Enter your 6-digit code/)).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
  });

  it.each([
    [{ status: 400, code: 'second-factor.invalid' }, /That code didn't work/],
    [
      { status: 429, code: 'second-factor.locked', details: { retryAfterSeconds: 600 } },
      /Try again in 10 minutes/,
    ],
    [
      { status: 403, code: 'payments.payout-account.second-factor-required' },
      /Turn on two-step sign-in/,
    ],
    [{ status: 503, code: 'payments.unavailable' }, /Payments are not available/],
  ])('shows the refusal %o', async (failure, text) => {
    mount(account());
    const dialog = open('Connect payout account');
    call.mockResolvedValueOnce({ ok: false, failure });
    enter(dialog, '000000');
    expect(await within(dialog).findByText(text)).toBeTruthy();
    expect(assign).not.toHaveBeenCalled();
  });

  it('pauses the button while the code is locked', async () => {
    mount(account());
    const dialog = open('Connect payout account');
    call.mockResolvedValueOnce({
      ok: false,
      failure: { status: 429, code: 'second-factor.locked', details: { retryAfterSeconds: 120 } },
    });
    enter(dialog, '000000');
    await within(dialog).findByText(/Try again in 2 minutes/);
    expect(
      within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Continue' }).disabled,
    ).toBe(true);
  });

  it('closes with Cancel and forgets the code', () => {
    mount(account());
    const dialog = open('Connect payout account');
    fireEvent.change(within(dialog).getByLabelText('Code'), { target: { value: '12' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(dialog.hasAttribute('open')).toBe(false);
  });
});

describe('payoutProblemOf', () => {
  it('reads the code field, not the status', () => {
    expect(payoutProblemOf({ status: 401, code: 'second-factor.invalid' }).key).toBe('invalid');
    expect(payoutProblemOf({ status: 0, code: 'network' }).key).toBe('unavailable');
    expect(payoutProblemOf({ status: 500, code: 'x' }).key).toBe('unknown');
  });
});

describe('payout nav', () => {
  it('shows the entry only with the view key', () => {
    const ids = (keys: string[]) =>
      visibleNavItems(sellerNav, new Set(keys)).map((item) => item.id);
    expect(ids([])).not.toContain('s_payout');
    expect(ids(['payments.payout-account.view'])).toContain('s_payout');
  });
});
