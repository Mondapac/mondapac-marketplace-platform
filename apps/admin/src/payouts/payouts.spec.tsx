// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { StepUpProvider } from '../step-up/step-up.tsx';
import { ApproveDialog } from './approve-dialog.tsx';
import { PayoutDetailView } from './payout-detail.tsx';
import { PayoutsList } from './payouts-list.tsx';
import { bankWaitUntil, type PayoutDetail, type PayoutRow } from './types.ts';

const call = vi.mocked(callApi);
const ZONE = 'Australia/Brisbane';
const NOW = Date.parse('2026-10-29T00:00:00.000Z');
const PAYOUT = '0190a000-0000-7000-8000-0000000000a1';
const OTHER = '0190a000-0000-7000-8000-0000000000a2';
const SELLER = '0190a000-0000-7000-8000-0000000000c1';
const ME = '0190a000-0000-7000-8000-0000000000f1';
const aud = (amountMinor: string) => ({ amountMinor, currency: 'AUD' });
const wrap = (node: React.ReactNode) => (
  <NextIntlClientProvider locale="en-AU" messages={messages}>
    <StepUpProvider>{node}</StepUpProvider>
  </NextIntlClientProvider>
);
const row = (over: Partial<PayoutRow> = {}): PayoutRow => ({
  payoutId: PAYOUT,
  sellerId: SELLER,
  storeName: 'Cedar Lane Halal Meats',
  state: 'awaiting-approval',
  gross: aud('33000'),
  netted: aud('2000'),
  transfer: aud('31000'),
  approvalMode: 'MANUAL',
  approvalReason: 'first-payout',
  slotAt: '2026-10-29T00:00:00.000Z',
  outcomeCode: null,
  createdAt: '2026-10-28T23:00:00.000Z',
  stateChangedAt: '2026-10-28T23:00:00.000Z',
  ...over,
});
const detail = (over: Partial<PayoutDetail> = {}): PayoutDetail => ({
  ...row(),
  approval: null,
  items: [
    { sellerOrderId: '0190a000-0000-7000-8000-0000000000b1', amount: aud('20000') },
    { sellerOrderId: '0190a000-0000-7000-8000-0000000000b2', amount: aud('13000') },
  ],
  accountReadiness: 'ready',
  lastBankChangeAt: '2026-09-01T02:00:00.000Z',
  limits: {
    perTransfer: aud('500000'),
    todayTotal: aud('1500000'),
    dailyAlertLevel: aud('2000000'),
    overDailyAlertLevel: false,
    transferAboveLimit: false,
  },
  ...over,
});
const ok = <T,>(body: T) => ({ ok: true as const, status: 200, body });
const refuse = (status: number, code: string, details?: object) => ({
  ok: false as const,
  failure: { status, code, ...(details === undefined ? {} : { details }) },
});
const page = (payouts: PayoutRow[], nextCursor: string | null = null) =>
  ok({ payouts, nextCursor });
const list = (
  tab: 'awaiting-approval' | 'sending' | 'paid' = 'awaiting-approval',
  canApprove = true,
) => render(wrap(<PayoutsList tab={tab} canApprove={canApprove} zone={ZONE} csrfToken="csrf-1" />));

beforeEach(() => {
  call.mockReset();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute('open');
  };
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('bankWaitUntil', () => {
  it('is the end of a waiting period that has not passed, else null', () => {
    expect(bankWaitUntil({ coolingOffUntil: '2026-10-30T00:00:00.000Z' }, NOW)).toBe(
      '2026-10-30T00:00:00.000Z',
    );
    expect(bankWaitUntil({ coolingOffUntil: '2026-10-28T00:00:00.000Z' }, NOW)).toBeNull();
    expect(bankWaitUntil({ coolingOffUntil: null }, NOW)).toBeNull();
    expect(bankWaitUntil({}, NOW)).toBeNull();
    expect(bankWaitUntil({ coolingOffUntil: 'soon' }, NOW)).toBeNull();
  });
});

describe('payouts list', () => {
  it('reads the state of its tab and shows the row with the transfer amount', async () => {
    call.mockResolvedValueOnce(page([row()]));
    list();
    expect(screen.getByRole('status')).toBeTruthy();
    const link = await screen.findByRole('link', { name: /Payout 000000A1/i });
    expect(link.getAttribute('href')).toBe(`/payouts/${PAYOUT}`);
    expect(call).toHaveBeenCalledWith(
      'GET',
      'commission-payouts/admin/payouts?status=awaiting-approval&limit=25',
    );
    expect(screen.getByText('$310.00')).toBeTruthy();
    expect(screen.getByText('First payout')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Cedar Lane Halal Meats' }).getAttribute('href')).toBe(
      `/sellers/${SELLER}`,
    );
    // One page-level table, with its caption for a screen reader.
    expect(screen.getByRole('table', { name: 'Payouts' })).toBeTruthy();
  });

  it('merges the three API states of the Sending tab, newest change first', async () => {
    call.mockImplementation((_method, path) => {
      if (path.includes('status=approved'))
        return Promise.resolve(
          page([row({ state: 'approved', stateChangedAt: '2026-10-28T01:00:00.000Z' })]),
        );
      if (path.includes('status=instructing'))
        return Promise.resolve(
          page([
            row({
              payoutId: OTHER,
              state: 'instructing',
              stateChangedAt: '2026-10-28T05:00:00.000Z',
            }),
          ]),
        );
      return Promise.resolve(page([]));
    });
    list('sending');
    await screen.findByRole('table');
    expect(call).toHaveBeenCalledTimes(3);
    const refs = screen.getAllByRole('link', { name: /^Payout / }).map((a) => a.textContent);
    expect(refs).toEqual(['Payout 000000A2', 'Payout 000000A1']);
  });

  it('shows the empty state of the tab', async () => {
    call.mockResolvedValueOnce(page([]));
    list();
    expect(await screen.findByText('No payouts are waiting for approval')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('shows a retry when the first page fails, and reads again', async () => {
    call.mockResolvedValueOnce(refuse(503, 'access.unavailable'));
    list();
    expect(await screen.findByText('The payouts could not be loaded. Try again.')).toBeTruthy();
    call.mockResolvedValueOnce(page([row()]));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('table')).toBeTruthy();
  });

  it('sends a signed-out admin to the session-ended route', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { assign });
    call.mockResolvedValueOnce(refuse(401, 'session.invalid'));
    list();
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/session-ended'));
    vi.unstubAllGlobals();
  });

  it('loads more with the cursor and drops a row it already has', async () => {
    call.mockResolvedValueOnce(page([row()], 'cursor-1'));
    list();
    await screen.findByRole('table');
    call.mockResolvedValueOnce(page([row(), row({ payoutId: OTHER, storeName: null })]));
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(screen.getAllByRole('link', { name: /^Payout / })).toHaveLength(2));
    expect(call).toHaveBeenLastCalledWith(
      'GET',
      'commission-payouts/admin/payouts?status=awaiting-approval&limit=25&cursor=cursor-1',
    );
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
  });

  it('shows a reason badge and no button for a payout in the bank waiting period', async () => {
    call.mockResolvedValueOnce(
      page([row({ coolingOffUntil: '2026-10-30T02:00:00.000Z' }), row({ payoutId: OTHER })]),
    );
    list();
    await screen.findByRole('table');
    expect(screen.getByText(/Bank change, waiting until/)).toBeTruthy();
    // Only the second row has a button; no disabled button stands in for the reason.
    expect(screen.getAllByRole('button', { name: /Review and approve/ })).toHaveLength(1);
    expect(document.querySelectorAll('button:disabled')).toHaveLength(0);
  });

  it('has no approve button without the permission, nor on a tab that is not Awaiting', async () => {
    call.mockResolvedValueOnce(page([row()]));
    list('awaiting-approval', false);
    await screen.findByRole('table');
    expect(screen.queryByRole('button', { name: /Review and approve/ })).toBeNull();
    cleanup();
    call.mockResolvedValueOnce(page([row({ state: 'paid' })]));
    list('paid');
    await screen.findByRole('table');
    expect(screen.queryByRole('button', { name: /Review and approve/ })).toBeNull();
    expect(screen.getByText('Paid')).toBeTruthy();
  });

  it('labels the table cells for the card layout below 1024 px', async () => {
    call.mockResolvedValueOnce(page([row()]));
    list();
    await screen.findByRole('table');
    const labels = [...document.querySelectorAll('td[data-label]')].map((td) =>
      td.getAttribute('data-label'),
    );
    expect(labels).toEqual(['Seller', 'Transfer', 'Approval', 'Planned for', '']);
  });
});

describe('approve dialog', () => {
  const open = async (initial: PayoutDetail = detail()) => {
    call.mockResolvedValueOnce(page([row()]));
    list();
    await screen.findByRole('table');
    call.mockResolvedValueOnce(ok(initial));
    fireEvent.click(screen.getByRole('button', { name: /Review and approve/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Approve payout' });
    await within(dialog).findByText('Transfer');
    return dialog;
  };

  it('reads the payout, shows what an approver needs and puts focus on Cancel', async () => {
    const dialog = await open();
    expect(call).toHaveBeenLastCalledWith('GET', `commission-payouts/admin/payouts/${PAYOUT}`);
    expect(within(dialog).getByText("This is the seller's first payout")).toBeTruthy();
    expect(within(dialog).getByText('Ready')).toBeTruthy();
    expect(within(dialog).getByText('Bank account last changed')).toBeTruthy();
    expect(within(dialog).getByText('$5,000.00')).toBeTruthy();
    expect(within(dialog).getByText('$15,000.00 of $20,000.00 alert level')).toBeTruthy();
    // The browser focuses the first focusable control of a modal dialog: that is Cancel (and the
    // button carries autoFocus too). Checked in Chromium by the screenshot run.
    const first = dialog.querySelector<HTMLElement>('a[href], button, input, select, textarea');
    expect(first?.textContent).toBe('Cancel');
    // No code field in the dialog: the step-up dialog asks for it.
    expect(within(dialog).queryByLabelText(/code/i)).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Approve $310.00' })).toBeTruthy();
  });

  it('echoes the exact transfer amount and removes the row when approved', async () => {
    const dialog = await open();
    call.mockResolvedValueOnce(
      ok({
        payoutId: PAYOUT,
        state: 'approved',
        transfer: aud('31000'),
        approvedBy: ME,
        approvedAt: '2026-10-29T00:01:00.000Z',
      }),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve $310.00' }));
    await waitFor(() =>
      expect(call).toHaveBeenLastCalledWith(
        'POST',
        `commission-payouts/admin/payouts/${PAYOUT}/approve`,
        { amountMinor: '31000' },
        'csrf-1',
      ),
    );
    expect(await screen.findByText(/Approved \$310\.00 for Cedar Lane Halal Meats/)).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
    expect(dialog.hasAttribute('open')).toBe(false);
  });

  it('asks for the code in the shared step-up dialog and stays as it was when it is cancelled', async () => {
    const dialog = await open();
    call.mockResolvedValueOnce(
      refuse(403, 'second-factor.required', { actionKey: 'commission-payouts.payout.approve' }),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve $310.00' }));
    expect(await screen.findByText(/approve a payout/)).toBeTruthy();
    const stepUp = screen.getAllByRole('dialog').find((d) => d !== dialog)!;
    fireEvent.click(within(stepUp).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByText(/approve a payout/)).toBeNull());
    expect(dialog.hasAttribute('open')).toBe(true);
    expect(within(dialog).queryByRole('alert')).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Approve $310.00' })).toBeTruthy();
  });

  it('says the amount changed, removes the approve button and reads the list again', async () => {
    const dialog = await open();
    call.mockResolvedValueOnce(refuse(409, 'commission-payouts.payout.amount-changed'));
    call.mockResolvedValue(page([row({ transfer: aud('29000') })]));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve $310.00' }));
    expect(
      await within(dialog).findByText('The amount changed. Close and review again.'),
    ).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: /^Approve/ })).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Close' })).toBeTruthy();
    await waitFor(() => expect(screen.getByText('$290.00')).toBeTruthy());
  });

  it('explains a payout that is no longer waiting', async () => {
    const dialog = await open();
    call.mockResolvedValueOnce(refuse(409, 'commission-payouts.payout.not-awaiting-approval'));
    call.mockResolvedValue(page([]));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve $310.00' }));
    expect(await within(dialog).findByText(/no longer waiting for approval/)).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: /^Approve/ })).toBeNull();
  });

  it('names a refusal that comes from acting as a seller', async () => {
    const dialog = await open();
    call.mockResolvedValueOnce(refuse(403, 'access.denied'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve $310.00' }));
    expect(await within(dialog).findByText(/may be acting as a seller/)).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Approve $310.00' })).toBeTruthy();
  });

  it('has no approve button in the bank waiting period and says why', async () => {
    const dialog = await open(detail({ coolingOffUntil: '2026-10-30T02:00:00.000Z' }));
    expect(within(dialog).getByText(/Bank change, waiting until/)).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: /^Approve/ })).toBeNull();
  });

  it('has no approve button when the account is not ready, or the transfer is above the limit', async () => {
    const dialog = await open(detail({ accountReadiness: 'not-ready' }));
    expect(within(dialog).getByText(/payout account is not ready/)).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: /^Approve/ })).toBeNull();
    cleanup();
    call.mockReset();
    const above = await open(detail({ limits: { ...detail().limits!, transferAboveLimit: true } }));
    expect(within(above).getByText(/above the limit of \$5,000\.00 per transfer/)).toBeTruthy();
    expect(within(above).queryByRole('button', { name: /^Approve/ })).toBeNull();
  });

  it('warns above the daily alert level but still allows the approval', async () => {
    const dialog = await open(
      detail({ limits: { ...detail().limits!, overDailyAlertLevel: true } }),
    );
    expect(within(dialog).getByText(/above the daily alert level/)).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Approve $310.00' })).toBeTruthy();
  });

  it('shows a retry when the payout cannot be read, and a note when it has no bank change on record', async () => {
    call.mockResolvedValueOnce(refuse(503, 'access.unavailable'));
    render(
      wrap(
        <ApproveDialog
          payoutId={PAYOUT}
          csrfToken="csrf-1"
          zone={ZONE}
          onClose={vi.fn()}
          onApproved={vi.fn()}
          onStale={vi.fn()}
        />,
      ),
    );
    expect(await screen.findByText('The payout could not be loaded. Try again.')).toBeTruthy();
    call.mockResolvedValueOnce(ok(detail({ lastBankChangeAt: null })));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Not on record yet')).toBeTruthy();
  });
});

describe('payout detail', () => {
  const mount = (view: PayoutDetail, canApprove = true) =>
    render(
      wrap(
        <PayoutDetailView
          initial={view}
          zone={ZONE}
          canApprove={canApprove}
          accountId={ME}
          csrfToken="csrf-1"
        />,
      ),
    );

  it('has one heading, the summary, the account, the approval and the items', () => {
    mount(detail());
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('Payout 000000A1');
    expect(screen.getByRole('link', { name: 'Cedar Lane Halal Meats' })).toBeTruthy();
    expect(screen.getByText('Kept against what the seller owes')).toBeTruthy();
    expect(screen.getByText('Nobody has approved this payout yet.')).toBeTruthy();
    expect(screen.getByRole('table', { name: 'Seller orders in this payout' })).toBeTruthy();
    expect(screen.getByText('$200.00')).toBeTruthy();
    expect(screen.getByText('$130.00')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Approve $310.00' })).toBeTruthy();
  });

  it('shows who approved and how much, and no approve button once approved', () => {
    mount(
      detail({
        state: 'approved',
        approval: {
          approvedBy: ME,
          approvedAt: '2026-10-29T00:01:00.000Z',
          approvedTransfer: aud('31000'),
        },
      }),
    );
    expect(screen.getByText('You')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Approve/ })).toBeNull();
  });

  it('has no approve button without the permission, and none in the bank waiting period', () => {
    mount(detail(), false);
    expect(screen.queryByRole('button', { name: /^Approve/ })).toBeNull();
    cleanup();
    mount(detail({ coolingOffUntil: '2026-10-30T02:00:00.000Z' }));
    expect(screen.getByText(/Bank change, waiting until/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Approve/ })).toBeNull();
  });

  it('says what happened to a payout that was not sent, and keeps a code it does not know', () => {
    mount(detail({ state: 'not-sent', outcomeCode: 'payout-unwound' }));
    expect(screen.getByText('Stopped before sending. Nothing was sent.')).toBeTruthy();
    cleanup();
    mount(detail({ state: 'not-sent', outcomeCode: 'payments.transfer.limit' }));
    expect(screen.getByText('Refused by payments (payments.transfer.limit).')).toBeTruthy();
    cleanup();
    mount(detail({ state: 'voided', outcomeCode: 'voided.hold' }));
    expect(screen.getByText('Cancelled because a hold was placed.')).toBeTruthy();
  });

  it('reads the payout again after an approval and says so', async () => {
    mount(detail());
    call.mockResolvedValueOnce(ok(detail()));
    fireEvent.click(screen.getByRole('button', { name: 'Approve $310.00' }));
    const dialog = await screen.findByRole('dialog', { name: 'Approve payout' });
    await within(dialog).findByText('Transfer');
    call.mockResolvedValueOnce(
      ok({
        payoutId: PAYOUT,
        state: 'approved',
        transfer: aud('31000'),
        approvedBy: ME,
        approvedAt: '2026-10-29T00:01:00.000Z',
      }),
    );
    call.mockResolvedValueOnce(
      ok(
        detail({
          state: 'approved',
          approval: {
            approvedBy: ME,
            approvedAt: '2026-10-29T00:01:00.000Z',
            approvedTransfer: aud('31000'),
          },
        }),
      ),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve $310.00' }));
    expect(
      await screen.findByText(/Payout approved\. The transfer is sent shortly\./),
    ).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Approve \$/ })).toBeNull());
  });
});
