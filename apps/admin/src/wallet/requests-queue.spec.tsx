// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { STEP_UP_CANCELLED } from '../step-up/step-up.tsx';
import { RequestsQueue } from './requests-queue.tsx';
import type { AdminCredit, QueueTab } from './types.ts';

const call = vi.mocked(callApi);
const ME = '0190a000-0000-7000-8000-0000000000a1';
const OTHER = '0190a000-0000-7000-8000-0000000000b2';
const ok = (body: unknown) => ({ ok: true as const, status: 200, body });
const refused = (status: number, code: string) => ({
  ok: false as const,
  failure: { status, code },
});

const entry = (id: string, over: Partial<AdminCredit> = {}): AdminCredit => ({
  id: `0190a000-0000-7000-8000-0000000000${id}`,
  customerAccountId: `0190a000-0000-7000-8000-00000000c0${id}`,
  amount: '90000',
  currency: 'AUD',
  reasonCode: 'goodwill',
  note: null,
  status: 'pending',
  approvalReason: 'issue-cap',
  requestedBy: OTHER,
  requestedAt: '2026-10-27T01:00:00.000Z',
  expiresAt: '2026-10-29T01:00:00.000Z',
  decidedBy: null,
  decidedAt: null,
  decisionReason: null,
  journalId: null,
  ...over,
});
const list = (entries: AdminCredit[], nextCursor: string | null = null) =>
  ok({ entries, nextCursor });

function mount(tab: QueueTab = 'pending', canApprove = true) {
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <RequestsQueue tab={tab} canApprove={canApprove} accountId={ME} csrfToken="csrf" />
    </NextIntlClientProvider>,
  );
}
const row = (text: string) => screen.getByText(text).closest('tr') as HTMLElement;

beforeEach(() => {
  vi.resetAllMocks();
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute('open');
  };
});
afterEach(cleanup);

describe('RequestsQueue list', () => {
  it('loads the pending tab with a page size and shows each request', async () => {
    call.mockResolvedValueOnce(list([entry('01')]));
    mount();
    expect(screen.getByText('Loading')).toBeTruthy();
    expect(await screen.findByText('$900.00')).toBeTruthy();
    expect(call).toHaveBeenCalledWith(
      'GET',
      'wallet/admin/credit-requests?status=pending&limit=20',
    );
    expect(
      screen.getByText('Credit requests waiting for a decision', { selector: 'caption' }),
    ).toBeTruthy();
    const line = row('$900.00');
    expect(within(line).getByRole('link', { name: '0000C001' }).getAttribute('href')).toBe(
      '/wallet/credits?customer=0190a000-0000-7000-8000-00000000c001',
    );
    expect(within(line).getByText('Pending')).toBeTruthy();
    expect(within(line).getByText('Goodwill')).toBeTruthy();
    expect(within(line).getByText('0000B2'.padStart(8, '0'))).toBeTruthy();
  });

  it('formats a yen request in yen and a dollar one in dollars', async () => {
    call.mockResolvedValueOnce(
      list([entry('01', { currency: 'JPY', amount: '2500' }), entry('02', { amount: '2500' })]),
    );
    mount();
    expect(await screen.findByText('$25.00')).toBeTruthy();
    expect(screen.getByText(/2,500/)).toBeTruthy();
  });

  it.each([
    ['pending', 'No credit requests are waiting.'],
    ['decided', 'No decided requests yet.'],
    ['granted', 'No credit has been issued yet.'],
  ] as const)('shows the empty state of the %s tab', async (tab, text) => {
    call.mockResolvedValueOnce(list([]));
    mount(tab);
    expect(await screen.findByText(text)).toBeTruthy();
    expect(call).toHaveBeenCalledWith('GET', `wallet/admin/credit-requests?status=${tab}&limit=20`);
  });

  it('shows a load error with a retry', async () => {
    call.mockResolvedValueOnce(refused(503, 'access.unavailable'));
    call.mockResolvedValueOnce(list([entry('01')]));
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('$900.00')).toBeTruthy();
  });

  it('loads more with the cursor, appends the rows and announces them', async () => {
    call.mockResolvedValueOnce(list([entry('01')], 'cursor-2'));
    mount();
    await screen.findByText('$900.00');
    call.mockResolvedValueOnce(
      list([entry('02', { amount: '12300' }), entry('03', { amount: '45600' })]),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('$456.00')).toBeTruthy();
    expect(screen.getByText('$900.00')).toBeTruthy();
    expect(call).toHaveBeenLastCalledWith(
      'GET',
      'wallet/admin/credit-requests?status=pending&limit=20&cursor=cursor-2',
    );
    expect(screen.getByText('2 more requests loaded')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('shows decided rows without actions, and Details with the note as plain text', async () => {
    call.mockResolvedValueOnce(
      list([
        entry('01', {
          status: 'rejected',
          note: '<b>big</b>\nsecond line',
          decidedBy: ME,
          decidedAt: '2026-10-27T03:00:00.000Z',
          decisionReason: 'duplicate',
        }),
      ]),
    );
    mount('decided');
    await screen.findByText('Rejected');
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(screen.getByText(/<b>big<\/b>/).textContent).toBe('<b>big</b>\nsecond line');
    expect(screen.getByText('Duplicate')).toBeTruthy();
    expect(screen.getByText('Why it needed approval')).toBeTruthy();
    expect(screen.getByText('More than the limit for one credit')).toBeTruthy();
    expect(screen.getAllByText('You').length).toBeGreaterThan(0);
  });

  it('shows no decision buttons to an admin who cannot approve', async () => {
    call.mockResolvedValueOnce(list([entry('01')]));
    mount('pending', false);
    await screen.findByText('$900.00');
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull();
  });
});

describe('RequestsQueue own request', () => {
  it('disables both buttons with the reason in visible text', async () => {
    call.mockResolvedValueOnce(list([entry('01', { requestedBy: ME }), entry('02')]));
    mount();
    await screen.findAllByText('$900.00');
    const own = row('You');
    const approve = within(own).getByRole<HTMLButtonElement>('button', { name: 'Approve' });
    const reject = within(own).getByRole<HTMLButtonElement>('button', { name: 'Reject' });
    expect(approve.disabled).toBe(true);
    expect(reject.disabled).toBe(true);
    const hint = within(own).getByText(
      'You asked for this credit. A different admin has to decide it.',
    );
    expect(approve.getAttribute('aria-describedby')).toBe(hint.id);
    expect(reject.getAttribute('aria-describedby')).toBe(hint.id);
    const others = screen.getAllByRole<HTMLButtonElement>('button', { name: 'Approve' });
    expect(others.filter((button) => !button.disabled)).toHaveLength(1);
  });

  it('shows the API answer in a critical banner if it still arrives', async () => {
    call.mockResolvedValueOnce(list([entry('01')]));
    mount();
    await screen.findByText('$900.00');
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await screen.findByRole('dialog', { name: 'Approve this credit?' });
    call.mockResolvedValueOnce(refused(403, 'wallet.approver-is-requester'));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Approve' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(
      'You asked for this credit. A different admin has to decide it.',
    );
  });
});

describe('RequestsQueue approve', () => {
  it('confirms with amount and customer, sends no body, then removes the row and says so', async () => {
    call.mockResolvedValueOnce(list([entry('01'), entry('02', { amount: '2500' })]));
    mount();
    await screen.findByText('$900.00');
    fireEvent.click(within(row('$900.00')).getByRole('button', { name: 'Approve' }));
    const dialog = await screen.findByRole('dialog', { name: 'Approve this credit?' });
    expect(dialog.textContent).toContain(
      "$900.00 will be added to customer 0000C001's wallet now. You cannot undo this.",
    );
    call.mockResolvedValueOnce(ok(entry('01', { status: 'approved' })));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('Credit approved. $900.00 was added.')).toBeTruthy();
    expect(call).toHaveBeenLastCalledWith(
      'POST',
      'wallet/admin/credit-requests/0190a000-0000-7000-8000-000000000001/approve',
      undefined,
      'csrf',
    );
    expect(screen.queryByText('$900.00')).toBeNull();
    expect(screen.getByText('$25.00')).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('status').parentElement),
    );
  });

  it('keeps the row when the code dialog is cancelled', async () => {
    call.mockResolvedValueOnce(list([entry('01')]));
    mount();
    await screen.findByText('$900.00');
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    const dialog = await screen.findByRole('dialog', { name: 'Approve this credit?' });
    call.mockResolvedValueOnce({ ok: false, failure: { status: 0, code: STEP_UP_CANCELLED } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(2));
    expect(screen.getByText('$900.00')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it.each([
    ['wallet.credit-request-decided', 409, 'Someone already decided this request.', false],
    [
      'wallet.credit-request-expired',
      409,
      'This request expired and can no longer be approved.',
      false,
    ],
    ['wallet.credit-request-not-found', 404, 'This request no longer exists.', false],
    ['wallet.paused', 409, 'The wallet is not active, so this cannot be approved now.', true],
    ['wallet.frozen', 409, 'The wallet is not active, so this cannot be approved now.', true],
    ['wallet.disabled', 404, 'The wallet is not active, so this cannot be approved now.', true],
    ['wallet.cap-exceeded', 409, "The customer's wallet no longer has room for this amount.", true],
    ['wallet.account-not-active', 409, "This customer's wallet cannot receive credit.", true],
    ['access.denied', 403, 'You do not have permission to decide credit requests.', true],
    ['wallet.unavailable', 503, 'We could not complete this. Try again.', true],
  ])('answers %s', async (code, status, text, rowStays) => {
    call.mockResolvedValueOnce(list([entry('01')]));
    mount();
    await screen.findByText('$900.00');
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    const dialog = await screen.findByRole('dialog', { name: 'Approve this credit?' });
    call.mockResolvedValueOnce(refused(status, code));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve' }));
    expect((await screen.findByRole('alert')).textContent).toBe(text);
    // A request that is decided, expired or gone leaves the Pending tab; the others stay.
    expect(screen.queryByText('$900.00') !== null).toBe(rowStays);
  });
});

describe('RequestsQueue reject', () => {
  it('needs a reason, sends it, and says no credit was issued', async () => {
    call.mockResolvedValueOnce(list([entry('01')]));
    mount();
    await screen.findByText('$900.00');
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    const dialog = await screen.findByRole('dialog', { name: 'Reject this request?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reject request' }));
    expect(within(dialog).getByText('Choose a reason.')).toBeTruthy();
    expect(call).toHaveBeenCalledTimes(1);
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'policy' } });
    call.mockResolvedValueOnce(ok(entry('01', { status: 'rejected', decisionReason: 'policy' })));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reject request' }));
    expect(await screen.findByText('Request rejected. No credit was issued.')).toBeTruthy();
    expect(call).toHaveBeenLastCalledWith(
      'POST',
      'wallet/admin/credit-requests/0190a000-0000-7000-8000-000000000001/reject',
      { reasonCode: 'policy' },
      'csrf',
    );
    expect(screen.queryByText('$900.00')).toBeNull();
    expect(screen.getByText('No credit requests are waiting.')).toBeTruthy();
  });

  it('shows an expired request as Expired on a tab that lists every status', async () => {
    call.mockResolvedValueOnce(list([entry('01')]));
    mount();
    await screen.findByText('$900.00');
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    const dialog = await screen.findByRole('dialog', { name: 'Reject this request?' });
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'duplicate' } });
    call.mockResolvedValueOnce(refused(409, 'wallet.credit-request-expired'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reject request' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'This request expired and can no longer be approved.',
    );
  });
});
