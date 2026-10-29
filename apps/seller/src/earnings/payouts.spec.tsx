// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import type { OwnDispute } from '../disputes/types.ts';
import { Earnings } from './earnings.tsx';
import type {
  NextPayout,
  OwnHeld,
  OwnPayout,
  OwnPayouts,
  PayoutMoney,
  PayoutsInitial,
} from './payout-types.ts';
import type { Ledger } from './types.ts';

const call = vi.mocked(callApi);
const SELLER_ORDER = '0190a000-0000-7000-8000-0000000000b1';
const aud = (amountMinor: string): PayoutMoney => ({ amountMinor, currency: 'AUD' });
const ledger = (balance = '3050', currency = 'AUD'): Ledger => ({
  sellerId: 's',
  currency,
  totals: {
    sales: '3000',
    shipping: '500',
    commission: '450',
    refundedSales: '0',
    refundedShipping: '0',
    refundedCommission: '0',
    disputeDebits: '0',
    disputeReinstated: '0',
    balance,
  },
  entries: [],
  nextCursor: null,
});
const next = (over: Partial<NextPayout> = {}): NextPayout => ({
  slotAt: '2026-11-02T23:00:00.000Z',
  zone: 'Australia/Melbourne',
  estimatedAmount: aud('84260'),
  blockReason: null,
  ...over,
});
const held = (over: Partial<OwnHeld> = {}): OwnHeld => ({
  sellerOrderId: SELLER_ORDER,
  amount: aud('21400'),
  reason: 'holding-period',
  availableFrom: '2026-10-29T23:00:00.000Z',
  ...over,
});
const payout = (over: Partial<OwnPayout> = {}): OwnPayout => ({
  payoutId: '0190a000-0000-7000-8000-0000000000a1',
  status: 'paid',
  gross: aud('120410'),
  netted: aud('0'),
  transfer: aud('120410'),
  slotAt: '2026-10-26T23:00:00.000Z',
  createdAt: '2026-10-26T22:00:00.000Z',
  updatedAt: '2026-10-27T01:00:00.000Z',
  reason: null,
  ...over,
});
const initial = (over: Partial<PayoutsInitial> = {}): PayoutsInitial => ({
  next: next(),
  holds: [held()],
  history: { payouts: [payout()], nextCursor: null },
  canOpenAccount: true,
  ...over,
});
const mount = (
  payouts: PayoutsInitial | null = initial(),
  balance = '3050',
  disputes: OwnDispute[] = [],
) =>
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages} timeZone="Australia/Melbourne">
      <Earnings initial={ledger(balance)} disputes={disputes} payouts={payouts ?? undefined} />
    </NextIntlClientProvider>,
  );
const ok = <T,>(body: T) => ({ ok: true as const, status: 200, body });
const refuse = (status: number, code = 'access.unavailable') => ({
  ok: false as const,
  failure: { status, code },
});

beforeEach(() => call.mockReset());
afterEach(cleanup);

describe('next payout card', () => {
  it('shows the estimate with its badge, the slot in the store zone and the link to the account', () => {
    mount();
    const card = screen.getByRole('heading', { name: 'Next payout' }).closest('section, div')!;
    expect(screen.getAllByText('$842.60')).toHaveLength(2);
    expect(screen.getByText('Estimated')).toBeTruthy();
    // 23:00 UTC on 2 Nov is 10:00 on 3 Nov in Melbourne.
    expect(screen.getByText(/Scheduled for 3 Nov, 10:00 am AEDT/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Manage payout account' }).getAttribute('href')).toBe(
      '/payout-account',
    );
    expect(card).toBeTruthy();
    expect(
      screen.getByText(
        'The amount can change before payout day if an order is refunded or disputed.',
      ),
    ).toBeTruthy();
  });

  it('holds ready, on hold and you owe inside the card, and no paid-this-month total', () => {
    mount(
      initial({ holds: [held(), held({ sellerOrderId: null, amount: aud('9650') })] }),
      '-4500',
    );
    const terms = [...document.querySelectorAll('dt')].map((dt) => dt.textContent);
    expect(terms).toEqual(expect.arrayContaining(['Ready for payout', 'On hold', 'You owe']));
    const value = (label: string) =>
      [...document.querySelectorAll('dt')].find((dt) => dt.textContent === label)
        ?.nextElementSibling?.textContent;
    expect(value('Ready for payout')).toBe('$842.60');
    expect(value('On hold')).toBe('$310.50 (2 orders)');
    expect(value('You owe')).toBe('$45.00, taken from your next payout');
    expect(screen.queryByText(/Paid out this month/)).toBeNull();
  });

  it('says nothing is owed as zero, and has no link without the account permission', () => {
    mount(initial({ canOpenAccount: false }));
    const owe = [...document.querySelectorAll('dt')].find((dt) => dt.textContent === 'You owe');
    expect(owe?.nextElementSibling?.textContent).toBe('$0.00');
    expect(screen.queryByRole('link', { name: 'Manage payout account' })).toBeNull();
  });

  it.each([
    ['below-minimum', 'Your balance is under the minimum payout, so it moves to next week.'],
    ['awaiting-approval', 'Your first payout is waiting for a check by MondaPac.'],
    ['account-not-ready', 'Your payout account is not ready, so nothing can be paid out yet.'],
    [
      'cooling-off',
      'You changed your bank account recently. Payouts start again once the waiting period ends.',
    ],
    ['payouts-paused', 'Payouts are paused for your store. Contact support if you need help.'],
    ['zone-missing', "Your store's time zone is not set, so payouts cannot be scheduled yet."],
    [
      'second-factor-required',
      'The store owner needs two-step sign-in on before payouts can be sent.',
    ],
  ])('shows the reason %s as one sentence in place of the amount', (reason, sentence) => {
    mount(initial({ next: next({ blockReason: reason, estimatedAmount: aud('84260') }) }));
    expect(screen.getByText(sentence)).toBeTruthy();
    expect(screen.queryByText('$842.60')).toBeNull();
    expect(screen.queryByText('Estimated')).toBeNull();
    // Nothing in the sentence is a hard-coded minimum.
    expect(sentence).not.toMatch(/\$|A\$|50/);
  });

  it('keeps pausing vague: no suspension, hold or admin detail', () => {
    mount(initial({ next: next({ blockReason: 'payouts-paused' }) }));
    expect(document.body.textContent).not.toMatch(/suspend|admin|risk/i);
  });

  it('says there is nothing to pay out when there is no estimate and no reason', () => {
    mount(initial({ next: next({ estimatedAmount: null }) }));
    expect(screen.getByText(/Nothing to pay out yet/)).toBeTruthy();
  });

  it('shows a retry when the card could not be read, and reads it again', async () => {
    mount(initial({ next: null }));
    expect(screen.getByText('Your next payout could not be loaded.')).toBeTruthy();
    call.mockResolvedValueOnce(ok(next()));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Estimated')).toBeTruthy();
    expect(call).toHaveBeenCalledWith('GET', 'commission-payouts/seller/payouts/next');
  });

  it('uses the currency of the ledger for the totals, not the dollar', () => {
    render(
      <NextIntlClientProvider locale="en-AU" messages={messages}>
        <Earnings
          initial={ledger('0', 'NZD')}
          payouts={initial({
            next: next({ estimatedAmount: { amountMinor: '1000', currency: 'NZD' } }),
            holds: [],
          })}
        />
      </NextIntlClientProvider>,
    );
    expect(screen.getAllByText(/NZ\$|NZD/).length).toBeGreaterThan(0);
  });
});

describe('money on hold', () => {
  it('shows a neutral badge, an absolute date and the share per order', () => {
    mount();
    const table = screen.getByRole('table', { name: 'Money on hold' });
    expect(within(table).getByText('Holding period')).toBeTruthy();
    expect(within(table).getByText(/Fri,? 30 Oct/)).toBeTruthy();
    expect(within(table).getByText('$214.00')).toBeTruthy();
    expect(within(table).getByRole('link', { name: 'Order 000000B1' }).getAttribute('href')).toBe(
      `/orders/${SELLER_ORDER}`,
    );
  });

  it('marks a disputed order as such, with the same words as the dispute card and no dead link', () => {
    mount(initial({ holds: [held({ reason: 'on-hold', availableFrom: null })] }), '3050', [
      {
        sellerOrderId: SELLER_ORDER,
        orderId: 'o',
        since: '2026-10-26T04:00:00.000Z',
        open: true,
        recoveredAmount: null,
      },
    ]);
    const table = screen.getByRole('table', { name: 'Money on hold' });
    expect(within(table).getByText('Payment disputed')).toBeTruthy();
    expect(within(table).getByText('Held until the dispute is closed.')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'What this means' })).toBeNull();
  });

  it('says "after delivery" for an order that is not delivered yet', () => {
    mount(initial({ holds: [held({ reason: 'awaiting-delivery', availableFrom: null })] }));
    expect(screen.getByText('Not delivered yet')).toBeTruthy();
    expect(screen.getByText('After delivery, plus the holding period')).toBeTruthy();
  });

  it('shows a refund in progress and a hold without an order', () => {
    mount(
      initial({
        holds: [
          held({ reason: 'refund-pending', availableFrom: null }),
          held({ reason: 'on-hold', sellerOrderId: null, availableFrom: null, amount: null }),
        ],
      }),
    );
    expect(screen.getByText('Refund in progress')).toBeTruthy();
    expect(screen.getByText('Your store')).toBeTruthy();
  });

  it('shows the generic "On hold" for a reason it does not know, never the raw code', () => {
    mount(initial({ holds: [held({ reason: 'brand-new-reason', availableFrom: null })] }));
    const table = screen.getByRole('table', { name: 'Money on hold' });
    expect(within(table).queryByText('brand-new-reason')).toBeNull();
    expect(within(table).getByText('On hold')).toBeTruthy();
  });

  it('has an empty state, and a retry that reads the holds again', async () => {
    mount(initial({ holds: [] }));
    expect(screen.getByText('No money on hold')).toBeTruthy();
    cleanup();
    mount(initial({ holds: null }));
    expect(screen.getByText('The money on hold could not be loaded.')).toBeTruthy();
    call.mockResolvedValueOnce(ok({ holds: [held()] }));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Holding period')).toBeTruthy();
    expect(call).toHaveBeenCalledWith('GET', 'commission-payouts/seller/payout-holds');
  });

  it('labels the cells of the card layout below 1024 px', () => {
    mount();
    const table = screen.getByRole('table', { name: 'Money on hold' });
    const labels = [...table.querySelectorAll('td[data-label]')].map((td) =>
      td.getAttribute('data-label'),
    );
    expect(labels).toEqual(['Details', 'Available from', 'Your share']);
  });
});

describe('payout history', () => {
  const status = (value: string, over: Partial<OwnPayout> = {}) => {
    mount(
      initial({ history: { payouts: [payout({ status: value, ...over })], nextCursor: null } }),
    );
  };

  it('shows Paid with the transfer amount and no Test label on the row', () => {
    mount();
    const table = screen.getByRole('table', { name: 'Payout history' });
    expect(within(table).getByText('Paid')).toBeTruthy();
    expect(within(table).getByText('$1,204.10')).toBeTruthy();
    expect(within(table).queryByText('Test')).toBeNull();
  });

  it.each([
    ['on-its-way', 'Sending'],
    ['awaiting-approval', 'Waiting for our check'],
    ['scheduled', 'Planned'],
    ['settled', 'Settled against what you owe'],
    ['failed', 'Failed'],
    ['not-sent', 'Not sent'],
  ])('shows %s as "%s"', (value, label) => {
    status(value);
    expect(
      within(screen.getByRole('table', { name: 'Payout history' })).getByText(label),
    ).toBeTruthy();
  });

  it('says "We will contact you" for a failed payout', () => {
    status('failed');
    expect(screen.getByText('We will contact you.')).toBeTruthy();
  });

  it('gives a short reason for a payout that was not sent, and for one settled against a debt', () => {
    status('not-sent', { reason: 'cooling-off' });
    expect(screen.getByText('Bank account changed recently')).toBeTruthy();
    cleanup();
    status('settled', { netted: aud('4500'), transfer: aud('0') });
    expect(screen.getByText('$45.00 kept against what you owed.')).toBeTruthy();
  });

  it('shows what was kept against a debt under the amount of a payout that was paid', () => {
    status('paid', { netted: aud('4500'), transfer: aud('115910') });
    expect(screen.getByText('$45.00 kept against what you owed')).toBeTruthy();
  });

  it('never shows a status it does not know as a guess', () => {
    status('mystery');
    expect(screen.getByText('Unknown')).toBeTruthy();
  });

  it('has an empty state and a retry', async () => {
    mount(initial({ history: { payouts: [], nextCursor: null } }));
    expect(screen.getByText('No payouts yet')).toBeTruthy();
    cleanup();
    mount(initial({ history: null }));
    call.mockResolvedValueOnce(ok<OwnPayouts>({ payouts: [payout()], nextCursor: null }));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Paid')).toBeTruthy();
    expect(call).toHaveBeenCalledWith('GET', 'commission-payouts/seller/payouts?limit=20');
  });

  it('loads more with the cursor, drops a repeated row and hides the button at the end', async () => {
    mount(initial({ history: { payouts: [payout()], nextCursor: 'cur-1' } }));
    call.mockResolvedValueOnce(
      ok<OwnPayouts>({
        payouts: [
          payout(),
          payout({ payoutId: '0190a000-0000-7000-8000-0000000000a2', status: 'failed' }),
        ],
        nextCursor: null,
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(screen.getByText('Failed')).toBeTruthy());
    expect(call).toHaveBeenCalledWith(
      'GET',
      'commission-payouts/seller/payouts?limit=20&cursor=cur-1',
    );
    expect(screen.getAllByText('Paid')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('says when more could not be loaded and keeps the button', async () => {
    mount(initial({ history: { payouts: [payout()], nextCursor: 'cur-1' } }));
    call.mockResolvedValueOnce(refuse(503));
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('More payouts could not be loaded. Try again.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Load more' })).toBeTruthy();
  });

  it('sends a signed-out seller to the session-ended route', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { assign });
    mount(initial({ history: { payouts: [payout()], nextCursor: 'cur-1' } }));
    call.mockResolvedValueOnce(refuse(401, 'session.invalid'));
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/session-ended'));
    vi.unstubAllGlobals();
  });
});

describe('payout history zone', () => {
  it('shows the slot in the store zone even when the next payout could not be read', () => {
    mount(initial({ next: null }));
    // 23:00 UTC on 26 Oct is 10:00 on 27 Oct in Melbourne (AEDT), not 11 pm UTC.
    const table = screen.getByRole('table', { name: 'Payout history' });
    expect(within(table).getByText(/27 Oct.*10:00.*AEDT/)).toBeTruthy();
  });
});

describe('the earnings page with the payout parts', () => {
  it('keeps the ledger totals, the disputed orders card and the ledger, and adds each part once', () => {
    mount(initial(), '3050', [
      {
        sellerOrderId: SELLER_ORDER,
        orderId: 'o',
        since: '2026-10-26T04:00:00.000Z',
        open: true,
        recoveredAmount: null,
      },
    ]);
    expect(screen.getByRole('heading', { name: 'Disputed orders' })).toBeTruthy();
    expect(screen.getAllByRole('heading', { name: 'Next payout' })).toHaveLength(1);
    expect(screen.getAllByRole('heading', { name: 'Money on hold' })).toHaveLength(1);
    expect(screen.getAllByRole('heading', { name: 'Payout history' })).toHaveLength(1);
    expect(screen.getByText('Balance')).toBeTruthy();
    expect(screen.getByText('No earnings yet')).toBeTruthy();
    expect(screen.queryByText(/New entry kinds/)).toBeNull();
  });

  it('shows the page as before when the payout parts are not given', () => {
    mount(null);
    expect(screen.queryByRole('heading', { name: 'Next payout' })).toBeNull();
    expect(screen.getByText('Balance')).toBeTruthy();
  });

  it('has no h1 of its own: the page gives the one heading', () => {
    mount();
    expect(screen.queryAllByRole('heading', { level: 1 })).toHaveLength(0);
  });
});
