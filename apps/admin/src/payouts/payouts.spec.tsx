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
import { type PayoutDetail, type PayoutRow } from './types.ts';

const call = vi.mocked(callApi);
const ZONE = 'Australia/Brisbane';
const NOW = Date.parse('2026-10-29T00:00:00.000Z');
const PAYOUT = '0190a000-0000-7000-8000-0000000000a1';
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
/** Types the payout's reference, the level 3 confirmation of the approve dialog. */
const confirmRef = (dialog: HTMLElement, text = '000000A1') =>
  fireEvent.change(within(dialog).getByLabelText('Type 000000A1 to confirm'), {
    target: { value: text },
  });
const handlers = () => ({ onClose: vi.fn(), onApproved: vi.fn(), onStale: vi.fn() });

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

describe('approve dialog', () => {
  let spies = handlers();
  const open = async (initial: PayoutDetail = detail()) => {
    spies = handlers();
    call.mockResolvedValueOnce(ok(initial));
    render(wrap(<ApproveDialog payoutId={PAYOUT} csrfToken="csrf-1" zone={ZONE} {...spies} />));
    const dialog = await screen.findByRole('dialog', { name: /^Approve payout/ });
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
    // Focus starts on Cancel, not on the confirmation field above it.
    expect(document.activeElement?.textContent).toBe('Cancel');
    // No code field in the dialog: the step-up dialog asks for it.
    expect(within(dialog).queryByLabelText(/code/i)).toBeNull();
    // Level 3: the red button waits for the payout's reference to be typed.
    const approve = within(dialog).getByRole('button', { name: 'Approve $310.00' });
    expect(approve.hasAttribute('disabled')).toBe(true);
    expect(within(dialog).getByText(/two-step code/)).toBeTruthy();
    confirmRef(dialog, '000000A2');
    expect(approve.hasAttribute('disabled')).toBe(true);
    // Exact, as in every level 3 confirmation (ConfirmAction): other letter case does not count.
    confirmRef(dialog, '000000a1');
    expect(approve.hasAttribute('disabled')).toBe(true);
    confirmRef(dialog, '000000A1');
    expect(approve.hasAttribute('disabled')).toBe(false);
  });

  it('sends nothing until the reference is typed', async () => {
    const dialog = await open();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve $310.00' }));
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('echoes the exact transfer amount and hands the approval back', async () => {
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
    confirmRef(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve $310.00' }));
    await waitFor(() =>
      expect(call).toHaveBeenLastCalledWith(
        'POST',
        `commission-payouts/admin/payouts/${PAYOUT}/approve`,
        { amountMinor: '31000' },
        'csrf-1',
      ),
    );
    await waitFor(() =>
      expect(spies.onApproved).toHaveBeenCalledWith(expect.objectContaining({ payoutId: PAYOUT })),
    );
  });

  it('formats and echoes a payout of another currency with no minor units (JPY)', async () => {
    const jpy = (amountMinor: string) => ({ amountMinor, currency: 'JPY' });
    const dialog = await open(
      detail({
        transfer: jpy('31000'),
        gross: jpy('33000'),
        netted: jpy('2000'),
        limits: {
          perTransfer: jpy('500000'),
          todayTotal: jpy('1500000'),
          dailyAlertLevel: jpy('2000000'),
          overDailyAlertLevel: false,
          transferAboveLimit: false,
        },
      }),
    );
    // 31000 minor units of JPY are 31,000 yen, not 310.00.
    const button = within(dialog).getByRole('button', { name: /^Approve .*31,000$/ });
    expect(button.textContent).not.toContain('310.00');
    call.mockResolvedValueOnce(
      ok({
        payoutId: PAYOUT,
        state: 'approved',
        transfer: jpy('31000'),
        approvedBy: ME,
        approvedAt: '2026-10-29T00:01:00.000Z',
      }),
    );
    confirmRef(dialog);
    fireEvent.click(button);
    await waitFor(() =>
      expect(call).toHaveBeenLastCalledWith(
        'POST',
        `commission-payouts/admin/payouts/${PAYOUT}/approve`,
        { amountMinor: '31000' },
        'csrf-1',
      ),
    );
  });

  it('asks for the code in the shared step-up dialog and stays as it was when it is cancelled', async () => {
    const dialog = await open();
    call.mockResolvedValueOnce(
      refuse(403, 'second-factor.required', { actionKey: 'commission-payouts.payout.approve' }),
    );
    confirmRef(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve $310.00' }));
    expect(await screen.findByText(/approve a payout/)).toBeTruthy();
    const stepUp = screen.getAllByRole('dialog').find((d) => d !== dialog)!;
    fireEvent.click(within(stepUp).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByText(/approve a payout/)).toBeNull());
    expect(dialog.hasAttribute('open')).toBe(true);
    expect(within(dialog).queryByRole('alert')).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Approve $310.00' })).toBeTruthy();
  });

  it('says the amount changed, removes the approve button and asks for the list again', async () => {
    const dialog = await open();
    call.mockResolvedValueOnce(refuse(409, 'commission-payouts.payout.amount-changed'));
    confirmRef(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve $310.00' }));
    expect(
      await within(dialog).findByText('The amount changed. Close and review again.'),
    ).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: /^Approve/ })).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Close' })).toBeTruthy();
    expect(spies.onStale).toHaveBeenCalledTimes(1);
  });

  it('explains a payout that is no longer waiting', async () => {
    const dialog = await open();
    call.mockResolvedValueOnce(refuse(409, 'commission-payouts.payout.not-awaiting-approval'));
    confirmRef(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve $310.00' }));
    expect(await within(dialog).findByText(/no longer waiting for approval/)).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: /^Approve/ })).toBeNull();
  });

  it('names a refusal that comes from acting as a seller', async () => {
    const dialog = await open();
    call.mockResolvedValueOnce(refuse(403, 'access.denied'));
    confirmRef(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve $310.00' }));
    expect(await within(dialog).findByText(/may be acting as a seller/)).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Approve $310.00' })).toBeTruthy();
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

  it('has no approve button without the permission', () => {
    mount(detail(), false);
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
    const dialog = await screen.findByRole('dialog', { name: /^Approve payout/ });
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
    confirmRef(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve $310.00' }));
    expect(
      await screen.findByText(/Payout approved\. The transfer is sent shortly\./),
    ).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Approve \$/ })).toBeNull());
  });
});
