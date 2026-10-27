// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { StepUpProvider } from '../step-up/step-up.tsx';
import { DisputeDetailView } from './dispute-detail.tsx';
import { DisputesList } from './disputes-list.tsx';
import { evidenceDue, reasonText } from './evidence.ts';
import { STRIPE_DASHBOARD_DISPUTES, type DisputeDetail, type DisputeRow } from './types.ts';

const call = vi.mocked(callApi);
const ZONE = 'Australia/Brisbane';
const NOW = Date.parse('2026-10-27T00:00:00.000Z');
const ORDER = '0190a000-0000-7000-8000-0000000000a1';
const SELLER_ORDER = '0190a000-0000-7000-8000-0000000000b1';
const SELLER = '0190a000-0000-7000-8000-0000000000c1';
const ME = '0190a000-0000-7000-8000-0000000000f1';
const aud = (amountMinor: string) => ({ amountMinor, currency: 'AUD' });
const wrap = (node: React.ReactNode) => (
  <NextIntlClientProvider locale="en-AU" messages={messages}>
    <StepUpProvider>{node}</StepUpProvider>
  </NextIntlClientProvider>
);
const counts = { 'needs-response': 2, 'decision-needed': 1, 'under-review': 0, won: 3, closed: 4 };
const row = (over: Partial<DisputeRow> = {}): DisputeRow => ({
  disputeId: '0190a000-0000-7000-8000-000000000d01',
  orderId: ORDER,
  sellers: [{ sellerId: SELLER, storeName: 'Cedar Lane Halal Meats' }],
  reason: 'product_not_received',
  moneyState: 'withdrawn',
  status: 'needs_response',
  bucket: 'needs-response',
  evidenceDueBy: '2026-10-29T10:00:00.000Z',
  amount: aud('12500'),
  openedAt: '2026-10-20T01:00:00.000Z',
  ...over,
});
const page = (disputes: DisputeRow[], nextCursor: string | null = null) => ({
  ok: true as const,
  status: 200,
  body: { counts, disputes, nextCursor },
});
const detail = (over: Partial<DisputeDetail> = {}): DisputeDetail => ({
  disputeId: '0190a000-0000-7000-8000-000000000d01',
  orderId: ORDER,
  providerDisputeId: 'dp_1ABC',
  amount: aud('12500'),
  status: 'lost',
  inquiry: false,
  closed: true,
  outcome: 'lost',
  reason: 'product_not_received',
  evidenceDueBy: null,
  moneyState: 'withdrawn',
  bucket: 'decision-needed',
  needsReview: false,
  openedAt: '2026-10-20T01:00:00.000Z',
  sellerOrders: [
    {
      sellerOrderId: SELLER_ORDER,
      sellerId: SELLER,
      storeName: 'Cedar Lane Halal Meats',
      sellerShare: aud('10000'),
      recoverableCap: aud('9000'),
      holdActive: true,
      decision: 'allowed',
      decided: null,
    },
  ],
  timeline: [
    { kind: 'opened', at: '2026-10-20T01:00:00.000Z', sellerOrderId: null },
    { kind: 'funds-withdrawn', at: '2026-10-20T01:05:00.000Z', sellerOrderId: null },
  ],
  ...over,
});
const mountDetail = (view: DisputeDetail, canDecide = true) =>
  render(
    wrap(
      <DisputeDetailView
        initial={view}
        zone={ZONE}
        canDecide={canDecide}
        accountId={ME}
        csrfToken="csrf-1"
      />,
    ),
  );

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

describe('evidence deadline', () => {
  it('is the absolute date, flagged within three days and once overdue', () => {
    expect(evidenceDue('2026-11-04T01:00:00.000Z', NOW, 'en-AU', ZONE)).toEqual({
      kind: 'later',
      date: '4 Nov',
    });
    expect(evidenceDue('2026-10-29T10:00:00.000Z', NOW, 'en-AU', ZONE)).toEqual({
      kind: 'soon',
      days: 3,
      date: '29 Oct',
    });
    expect(evidenceDue('2026-10-26T10:00:00.000Z', NOW, 'en-AU', ZONE)).toEqual({
      kind: 'overdue',
      date: '26 Oct',
    });
    expect(evidenceDue('nope', NOW, 'en-AU', ZONE)).toBeNull();
  });

  it('reads the date in the admin zone, not UTC', () => {
    // 23:00 UTC on the 3rd is already the 4th in Brisbane (UTC+10).
    expect(evidenceDue('2026-11-03T23:00:00.000Z', NOW, 'en-AU', ZONE)?.date).toBe('4 Nov');
    expect(evidenceDue('2026-11-03T23:00:00.000Z', NOW, 'en-AU', 'UTC')?.date).toBe('3 Nov');
  });

  it('writes a Stripe reason as readable text', () => {
    expect(reasonText('product_not_received')).toBe('Product not received');
  });
});

describe('disputes list', () => {
  it('shows filter chips with counts and the footnote, and loads the first bucket', async () => {
    call.mockResolvedValueOnce(page([row()]));
    render(wrap(<DisputesList zone={ZONE} />));
    const table = await screen.findByRole('table');
    const chip = screen.getByRole('button', { name: /Needs response/ });
    expect(chip.getAttribute('aria-pressed')).toBe('true');
    expect(chip.textContent).toContain('2');
    expect(screen.getByRole('button', { name: /Won/ }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('button', { name: /Closed/ }).textContent).toContain('4');
    expect(
      screen.getByText(
        "An inquiry does not move money. Only that order's seller share is held while a dispute is open.",
      ),
    ).toBeTruthy();
    expect(screen.getByText('Dates are shown in Australia/Brisbane.')).toBeTruthy();
    expect(within(table).getByRole('link', { name: /Order 000000A1/ })).toBeTruthy();
    expect(within(table).getByText('Cedar Lane Halal Meats')).toBeTruthy();
    expect(within(table).getByText('Product not received')).toBeTruthy();
    expect(within(table).getByText('$125.00')).toBeTruthy();
    expect(call).toHaveBeenCalledWith(
      'GET',
      'commission-payouts/admin/disputes?filter=needs-response&limit=25',
    );
  });

  it('badges the money with its text and shows none when nothing moved', async () => {
    call.mockResolvedValueOnce(
      page([
        row(),
        row({ disputeId: '0190a000-0000-7000-8000-000000000d02', moneyState: 'inquiry' }),
        row({ disputeId: '0190a000-0000-7000-8000-000000000d03', moneyState: 'reinstated' }),
        row({ disputeId: '0190a000-0000-7000-8000-000000000d04', moneyState: 'none' }),
      ]),
    );
    render(wrap(<DisputesList zone={ZONE} />));
    const table = await screen.findByRole('table');
    expect(within(table).getByText('Taken by bank').className).toContain('critical');
    expect(within(table).getByText('Inquiry only').className).toContain('neutral');
    expect(within(table).getByText('Returned to us').className).toContain('success');
    expect(within(table).getAllByText(/Taken by bank|Inquiry only|Returned to us/)).toHaveLength(3);
  });

  it('shows the deadline as a date, flagged as soon or overdue', async () => {
    call.mockResolvedValueOnce(
      page([
        row({ evidenceDueBy: '2026-10-29T10:00:00.000Z' }),
        row({
          disputeId: '0190a000-0000-7000-8000-000000000d02',
          evidenceDueBy: '2026-10-26T01:00:00.000Z',
        }),
        row({
          disputeId: '0190a000-0000-7000-8000-000000000d03',
          evidenceDueBy: '2026-11-04T01:00:00.000Z',
        }),
      ]),
    );
    render(wrap(<DisputesList zone={ZONE} />));
    const table = await screen.findByRole('table');
    expect(within(table).getByText('In 3 days · 29 Oct').className).toContain('attention');
    expect(within(table).getByText('Overdue · 26 Oct').className).toContain('critical');
    expect(within(table).getByText('4 Nov')).toBeTruthy();
  });

  it('asks for the chosen bucket and replaces the rows', async () => {
    call.mockResolvedValueOnce(page([row()]));
    render(wrap(<DisputesList zone={ZONE} />));
    await screen.findByRole('table');
    call.mockResolvedValueOnce(page([]));
    fireEvent.click(screen.getByRole('button', { name: /Won/ }));
    expect(await screen.findByText('No disputes won yet')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
    expect(call).toHaveBeenLastCalledWith(
      'GET',
      'commission-payouts/admin/disputes?filter=won&limit=25',
    );
    expect(screen.getByRole('button', { name: /Won/ }).getAttribute('aria-pressed')).toBe('true');
  });

  it('says so per filter when a bucket is empty', async () => {
    call.mockResolvedValueOnce(page([]));
    render(wrap(<DisputesList zone={ZONE} />));
    expect(await screen.findByText('No disputes need a response')).toBeTruthy();
  });

  it('shows a load error with retry, and pages with Show more', async () => {
    call.mockResolvedValueOnce({ ok: false, failure: { status: 500, code: 'unknown' } });
    render(wrap(<DisputesList zone={ZONE} />));
    expect(await screen.findByText('The disputes could not be loaded. Try again.')).toBeTruthy();
    call.mockResolvedValueOnce(page([row()], 'c2'));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByRole('table');
    call.mockResolvedValueOnce(
      page([row({ disputeId: '0190a000-0000-7000-8000-000000000d09', orderId: SELLER_ORDER })]),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(3));
    expect(call).toHaveBeenLastCalledWith(
      'GET',
      'commission-payouts/admin/disputes?filter=needs-response&limit=25&cursor=c2',
    );
  });
});

describe('dispute detail', () => {
  it('shows the summary, the Stripe link, the seller part and the timeline', () => {
    mountDetail(detail());
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'Disputes' }).getAttribute('href')).toBe('/disputes');
    expect(screen.getByText('$125.00')).toBeTruthy();
    expect(screen.getByText('Taken by bank')).toBeTruthy();
    const link = screen.getByRole('link', { name: /Open in Stripe Dashboard/ });
    expect(link.getAttribute('href')).toBe(`${STRIPE_DASHBOARD_DISPUTES}dp_1ABC`);
    expect(link.getAttribute('href')).toBe('https://dashboard.stripe.com/test/disputes/dp_1ABC');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link.textContent).toContain('(opens in a new tab)');
    expect(screen.getByText('$100.00')).toBeTruthy();
    expect(screen.getByText('$90.00')).toBeTruthy();
    expect(screen.getByText('Dispute opened')).toBeTruthy();
    expect(screen.getByText('The bank took the money')).toBeTruthy();
    expect(screen.getByText('Dates are shown in Australia/Brisbane.')).toBeTruthy();
  });

  it('offers Decide only with the permission and an allowed decision', () => {
    mountDetail(detail(), false);
    expect(screen.queryByRole('button', { name: 'Decide' })).toBeNull();
    cleanup();
    mountDetail(
      detail({ sellerOrders: [{ ...detail().sellerOrders[0]!, decision: 'not-allowed' }] }),
    );
    expect(screen.queryByRole('button', { name: 'Decide' })).toBeNull();
    cleanup();
    mountDetail(detail());
    expect(screen.getByRole('button', { name: 'Decide' })).toBeTruthy();
  });

  it('shows who, when, option, reason and amount instead of Decide once decided', () => {
    const base = detail().sellerOrders[0]!;
    mountDetail(
      detail({
        sellerOrders: [
          {
            ...base,
            decision: 'not-allowed',
            decided: {
              bearer: 'seller',
              amount: aud('4000'),
              reasonCode: 'no-delivery-proof',
              decidedBy: ME,
              decidedAt: '2026-10-22T02:00:00.000Z',
              reversal: null,
            },
          },
        ],
      }),
    );
    expect(screen.queryByRole('button', { name: 'Decide' })).toBeNull();
    expect(screen.getByText('You')).toBeTruthy();
    expect(screen.getByText('Recovered from the seller')).toBeTruthy();
    expect(screen.getByText('No proof of delivery')).toBeTruthy();
    expect(screen.getByText('$40.00')).toBeTruthy();
    expect(screen.getByText(/22 Oct/)).toBeTruthy();
  });

  it('flags a case that needs review and offers to return the recovered amount', () => {
    const base = detail().sellerOrders[0]!;
    mountDetail(
      detail({
        needsReview: true,
        moneyState: 'reinstated',
        sellerOrders: [
          {
            ...base,
            decision: 'reversal-allowed',
            decided: {
              bearer: 'seller',
              amount: aud('4000'),
              reasonCode: 'other',
              decidedBy: ME,
              decidedAt: '2026-10-22T02:00:00.000Z',
              reversal: null,
            },
          },
        ],
      }),
    );
    expect(screen.getByText('Needs review')).toBeTruthy();
    expect(
      screen.getByText("The bank returned the money after the loss. Check each seller's decision."),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Return recovered amount' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/\$40.00 recovered from the seller/)).toBeTruthy();
    expect(within(dialog).queryByLabelText(/Amount/)).toBeNull();
    fireEvent.change(within(dialog).getByLabelText('Reason'), {
      target: { value: 'card-fraud-not-seller' },
    });
    call.mockResolvedValueOnce({ ok: true, status: 201, body: {} });
    call.mockResolvedValueOnce({ ok: true, status: 200, body: detail() });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save decision' }));
    return waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'POST',
        `commission-payouts/admin/disputes/${detail().disputeId}/seller-orders/${SELLER_ORDER}/decision`,
        { bearer: 'platform', reasonCode: 'card-fraud-not-seller' },
        'csrf-1',
      ),
    );
  });
});

describe('decision dialog', () => {
  const open = () => {
    mountDetail(detail());
    fireEvent.click(screen.getByRole('button', { name: 'Decide' }));
    return screen.getByRole('dialog');
  };

  it('has no code field, a reason that cannot be left unchosen and a Save that waits for it', () => {
    const dialog = open();
    expect(within(dialog).queryByLabelText(/code/i)).toBeNull();
    const reason = within(dialog).getByLabelText<HTMLSelectElement>('Reason');
    const placeholder = within(reason).getByRole('option', { name: 'Choose a reason' });
    expect((placeholder as HTMLOptionElement).disabled).toBe(true);
    expect(
      within(reason)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual([
      'Choose a reason',
      'No proof of delivery',
      'Item not as described',
      "Card fraud, not the seller's fault",
      'Other',
    ]);
    const save = within(dialog).getByRole('button', { name: 'Save decision' });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(dialog).getByLabelText('MondaPac bears the loss'));
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(reason, { target: { value: 'other' } });
    expect((save as HTMLButtonElement).disabled).toBe(false);
  });

  it('defaults the amount to the full cap, with the hint, and posts the seller recovery', async () => {
    const dialog = open();
    fireEvent.click(within(dialog).getByLabelText('Recover from the seller'));
    const amount = within(dialog).getByLabelText<HTMLInputElement>(/Amount/);
    expect(amount.value).toBe('90.00');
    expect(within(dialog).getByText('Up to $90.00')).toBeTruthy();
    fireEvent.change(amount, { target: { value: '40.50' } });
    fireEvent.change(within(dialog).getByLabelText('Reason'), {
      target: { value: 'not-as-described' },
    });
    call.mockResolvedValueOnce({ ok: true, status: 201, body: {} });
    call.mockResolvedValueOnce({ ok: true, status: 200, body: detail({ bucket: 'closed' }) });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save decision' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'POST',
        `commission-payouts/admin/disputes/${detail().disputeId}/seller-orders/${SELLER_ORDER}/decision`,
        { bearer: 'seller', amountMinor: '4050', reasonCode: 'not-as-described' },
        'csrf-1',
      ),
    );
    expect(await screen.findByText('Decision saved.')).toBeTruthy();
    expect(screen.getByRole('dialog', { hidden: true }).hasAttribute('open')).toBe(false);
  });

  it('posts the platform option without an amount', async () => {
    const dialog = open();
    fireEvent.click(within(dialog).getByLabelText('MondaPac bears the loss'));
    expect(within(dialog).queryByLabelText(/Amount/)).toBeNull();
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'other' } });
    call.mockResolvedValueOnce({ ok: true, status: 201, body: {} });
    call.mockResolvedValueOnce({ ok: true, status: 200, body: detail() });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save decision' }));
    await waitFor(() =>
      expect(call.mock.calls[0]?.[2]).toEqual({ bearer: 'platform', reasonCode: 'other' }),
    );
  });

  it('keeps an amount above the cap out of the request and says so under the field', () => {
    const dialog = open();
    fireEvent.click(within(dialog).getByLabelText('Recover from the seller'));
    fireEvent.change(within(dialog).getByLabelText(/Amount/), { target: { value: '90.01' } });
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'other' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save decision' }));
    expect(within(dialog).getByText('The amount can be at most $90.00.')).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
  });

  it('shows the server amount error under the field', async () => {
    const dialog = open();
    fireEvent.click(within(dialog).getByLabelText('Recover from the seller'));
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'other' } });
    call.mockResolvedValueOnce({
      ok: false,
      failure: { status: 400, code: 'commission-payouts.dispute.amount-out-of-range' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save decision' }));
    const error = await within(dialog).findByText('The amount can be at most $90.00.');
    const field = within(dialog).getByLabelText(/Amount/);
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(field.getAttribute('aria-describedby')).toContain(error.id);
  });

  it('asks for the code in the step-up dialog and leaves this dialog open when it is cancelled', async () => {
    const dialog = open();
    fireEvent.click(within(dialog).getByLabelText('MondaPac bears the loss'));
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'other' } });
    call.mockResolvedValueOnce({
      ok: false,
      failure: {
        status: 403,
        code: 'second-factor.required',
        details: { actionKey: 'commission-payouts.dispute.attribute' },
      },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save decision' }));
    expect(await screen.findByText(/record a dispute decision/)).toBeTruthy();
    const stepUp = screen.getAllByRole('dialog').find((d) => d !== dialog)!;
    fireEvent.click(within(stepUp).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByText(/record a dispute decision/)).toBeNull());
    expect(dialog.hasAttribute('open')).toBe(true);
    expect(within(dialog).getByLabelText<HTMLSelectElement>('Reason').value).toBe('other');
    expect(within(dialog).queryByRole('alert')).toBeNull();
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('says the case changed when it was decided meanwhile, and reads it again', async () => {
    const dialog = open();
    fireEvent.click(within(dialog).getByLabelText('MondaPac bears the loss'));
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'other' } });
    call.mockResolvedValueOnce({
      ok: false,
      failure: { status: 409, code: 'commission-payouts.dispute.already-decided' },
    });
    call.mockResolvedValueOnce({ ok: true, status: 200, body: detail() });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save decision' }));
    expect(await within(dialog).findByRole('alert')).toBeTruthy();
    expect(within(dialog).getByText(/already decided/)).toBeTruthy();
    await waitFor(() =>
      expect(call).toHaveBeenLastCalledWith(
        'GET',
        `commission-payouts/admin/disputes/${detail().disputeId}`,
      ),
    );
  });
});
