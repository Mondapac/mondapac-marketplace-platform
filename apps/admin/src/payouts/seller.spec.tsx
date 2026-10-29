// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { StepUpProvider } from '../step-up/step-up.tsx';
import { PayoutHoldsCard } from './holds-card.tsx';
import { canReleaseHold, type PayoutHold, type PayoutTerms } from './seller-types.ts';
import { PayoutTermsCard } from './terms-card.tsx';

const call = vi.mocked(callApi);
const SELLER = '0190a000-0000-7000-8000-0000000000c1';
const ORDER = '0190a000-0000-7000-8000-0000000000b1';
const wrap = (node: React.ReactNode) => (
  <NextIntlClientProvider locale="en-AU" messages={messages}>
    <StepUpProvider>{node}</StepUpProvider>
  </NextIntlClientProvider>
);
const ok = <T,>(body: T) => ({ ok: true as const, status: 200, body });
const refuse = (status: number, code: string, details?: object) => ({
  ok: false as const,
  failure: { status, code, ...(details === undefined ? {} : { details }) },
});
const terms = (over: Partial<PayoutTerms> = {}): PayoutTerms => ({
  sellerId: SELLER,
  source: 'market',
  effective: {
    weekdays: ['TUE'],
    localTime: '10:00',
    holdDaysCarrier: 7,
    holdDaysSellerClick: 14,
    minimumMinor: '5000',
    approvalMode: 'AUTO',
    firstPayoutManual: true,
  },
  override: null,
  version: null,
  ...over,
});
const own = (): PayoutTerms =>
  terms({
    source: 'seller',
    override: {
      weekdays: null,
      localTime: null,
      holdDaysCarrier: null,
      holdDaysSellerClick: 21,
      minimumMinor: null,
      approvalMode: 'MANUAL',
    },
    effective: { ...terms().effective, holdDaysSellerClick: 21, approvalMode: 'MANUAL' },
    version: 3,
  });
const hold = (over: Partial<PayoutHold> = {}): PayoutHold => ({
  holdId: '0190a000-0000-7000-8000-0000000000d1',
  sellerId: SELLER,
  sellerOrderId: ORDER,
  reason: 'admin-review',
  origin: 'admin',
  placedAt: '2026-10-21T01:00:00.000Z',
  active: true,
  releasedAt: null,
  releaseReason: null,
  ...over,
});

beforeEach(() => {
  call.mockReset();
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute('open');
  };
});
afterEach(cleanup);

describe('payout terms card', () => {
  const mount = (initial: PayoutTerms, canEdit = true, currency: string | null = 'AUD') =>
    render(
      wrap(
        <PayoutTermsCard
          initial={initial}
          currency={currency}
          canEdit={canEdit}
          csrfToken="csrf-1"
        />,
      ),
    );

  it('shows the terms in force with the money from the Market currency and no badge on Market values', () => {
    mount(terms());
    expect(screen.getByText("Tuesday 10:00, seller's time")).toBeTruthy();
    expect(screen.getByText('7 days')).toBeTruthy();
    expect(screen.getByText('$50.00')).toBeTruthy();
    expect(screen.queryByText('Set for this seller')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Back to Market default' })).toBeNull();
  });

  it('badges only the values the seller has of their own, and offers the way back', () => {
    mount(own());
    expect(screen.getAllByText('Set for this seller')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Back to Market default' })).toBeTruthy();
  });

  it('has no buttons without the edit key', () => {
    mount(own(), false);
    expect(screen.queryByRole('button', { name: /Edit for this seller/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Back to Market default' })).toBeNull();
  });

  it('sends only the ticked values with the reason and the version, through the guarded call', async () => {
    mount(own());
    fireEvent.click(screen.getByRole('button', { name: 'Edit for this seller' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit payout terms' });
    // The seller's two own values start ticked; the rest follow the Market.
    expect(
      within(dialog).getByLabelText<HTMLInputElement>(
        'Set Hold after the seller marks delivered for this seller',
      ).checked,
    ).toBe(true);
    expect(
      within(dialog).getByLabelText<HTMLInputElement>('Hold after courier delivery').disabled,
    ).toBe(true);
    fireEvent.change(within(dialog).getByLabelText('Hold after the seller marks delivered'), {
      target: { value: '30' },
    });
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'policy' } });
    call.mockResolvedValueOnce(ok({ ...own(), version: 4 }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save terms' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'PUT',
        `commission-payouts/admin/sellers/${SELLER}/payout-terms`,
        {
          holdDaysSellerClick: 30,
          approvalMode: 'MANUAL',
          reasonCode: 'policy',
          expectedVersion: 3,
        },
        'csrf-1',
      ),
    );
    expect(await screen.findByText('Payout terms saved.')).toBeTruthy();
  });

  it('keeps an out-of-range value, a missing reason and an empty selection out of the request', () => {
    mount(terms());
    fireEvent.click(screen.getByRole('button', { name: 'Edit for this seller' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit payout terms' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save terms' }));
    expect(
      within(dialog).getByText('Tick at least one value to set for this seller.'),
    ).toBeTruthy();
    expect(within(dialog).getByText('Choose a reason.')).toBeTruthy();
    fireEvent.click(
      within(dialog).getByLabelText('Set Hold after courier delivery for this seller'),
    );
    fireEvent.change(within(dialog).getByLabelText('Hold after courier delivery'), {
      target: { value: '3' },
    });
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'policy' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save terms' }));
    expect(within(dialog).getByText('Enter whole days from 7 to 60.')).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
  });

  it('cannot edit the minimum when the currency is not known', () => {
    mount(terms(), true, null);
    expect(screen.getByText('5000 (minor units)')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Edit for this seller' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit payout terms' });
    expect(
      within(dialog).getByLabelText<HTMLInputElement>('Set Minimum payout for this seller')
        .disabled,
    ).toBe(true);
  });

  it('reads the terms again and says so when they changed meanwhile', async () => {
    mount(own());
    fireEvent.click(screen.getByRole('button', { name: 'Edit for this seller' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit payout terms' });
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'policy' } });
    call.mockResolvedValueOnce(refuse(409, 'commission-payouts.version-conflict'));
    call.mockResolvedValueOnce(ok({ ...own(), version: 5 }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save terms' }));
    expect(await screen.findByText(/These terms changed while you were editing/)).toBeTruthy();
    await waitFor(() =>
      expect(call).toHaveBeenLastCalledWith(
        'GET',
        `commission-payouts/admin/sellers/${SELLER}/payout-terms`,
      ),
    );
  });

  it('removes the seller terms with the version and reason in the query', async () => {
    mount(own());
    fireEvent.click(screen.getByRole('button', { name: 'Back to Market default' }));
    const dialog = screen.getByRole('dialog', { name: 'Back to the Market default' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove seller terms' }));
    expect(within(dialog).getByText('Choose a reason.')).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('Reason'), {
      target: { value: 'seller-request' },
    });
    call.mockResolvedValueOnce(ok(terms()));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove seller terms' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'DELETE',
        `commission-payouts/admin/sellers/${SELLER}/payout-terms?expectedVersion=3&reasonCode=seller-request`,
        undefined,
        'csrf-1',
      ),
    );
    expect(await screen.findByText('The seller is back on the Market default.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Back to Market default' })).toBeNull();
  });

  it('asks for the code in the shared step-up dialog and returns to the form when it is cancelled', async () => {
    mount(own());
    fireEvent.click(screen.getByRole('button', { name: 'Edit for this seller' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit payout terms' });
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'policy' } });
    call.mockResolvedValueOnce(
      refuse(403, 'second-factor.required', { actionKey: 'commission-payouts.payout-terms.edit' }),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save terms' }));
    expect(await screen.findByText(/change a seller's payout terms/)).toBeTruthy();
    const stepUp = screen
      .getAllByRole('dialog')
      .find(
        (d) => d.textContent?.includes('payout terms') && d !== dialog && d.hasAttribute('open'),
      )!;
    fireEvent.click(within(stepUp).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(dialog.hasAttribute('open')).toBe(true));
    expect(within(dialog).getByLabelText<HTMLSelectElement>('Reason').value).toBe('policy');
  });
});

describe('payout holds card', () => {
  const mount = (holds: PayoutHold[], canPlace = true, canRelease = true) =>
    render(
      wrap(
        <PayoutHoldsCard
          sellerId={SELLER}
          initial={holds}
          zone="Australia/Brisbane"
          canPlace={canPlace}
          canRelease={canRelease}
          csrfToken="csrf-1"
        />,
      ),
    );

  it('decides which holds an admin may release', () => {
    expect(canReleaseHold(hold())).toBe(true);
    expect(canReleaseHold(hold({ origin: 'system', reason: 'seller-suspended' }))).toBe(true);
    expect(canReleaseHold(hold({ origin: 'system', reason: 'dispute' }))).toBe(false);
    expect(canReleaseHold(hold({ origin: 'system', reason: 'bank-change' }))).toBe(false);
    expect(canReleaseHold(hold({ active: false }))).toBe(false);
  });

  it('lists active holds first, with a release button only where an admin may release', () => {
    mount([
      hold({
        holdId: 'r',
        active: false,
        releasedAt: '2026-10-25T01:00:00.000Z',
        releaseReason: 'resolved',
      }),
      hold({ holdId: 'd', origin: 'system', reason: 'dispute', sellerOrderId: null }),
      hold(),
    ]);
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[0]?.textContent).toContain('Payment disputed');
    expect(rows[0]?.textContent).toContain('Whole seller');
    expect(rows[2]?.textContent).toContain('Released');
    expect(screen.getAllByRole('button', { name: 'Release' })).toHaveLength(1);
    expect(screen.getByRole('table', { name: 'Payout holds' })).toBeTruthy();
  });

  it('shows the empty state, and no place button without the key', () => {
    mount([], false);
    expect(screen.getByText('No holds')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Place a hold' })).toBeNull();
  });

  it('places a hold on the whole seller with a closed reason', async () => {
    mount([]);
    fireEvent.click(screen.getByRole('button', { name: 'Place a hold' }));
    const dialog = screen.getByRole('dialog', { name: 'Place a payout hold' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Place hold' }));
    expect(within(dialog).getByText('Choose a reason.')).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'bank-change' } });
    call.mockResolvedValueOnce(ok(hold({ reason: 'bank-change', sellerOrderId: null })));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Place hold' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'POST',
        `commission-payouts/admin/sellers/${SELLER}/payout-holds`,
        { reason: 'bank-change' },
        'csrf-1',
      ),
    );
    expect(await screen.findByText('Hold placed.')).toBeTruthy();
    expect(screen.getByText('Bank change')).toBeTruthy();
  });

  it('needs a full order id to hold one order', async () => {
    mount([]);
    fireEvent.click(screen.getByRole('button', { name: 'Place a hold' }));
    const dialog = screen.getByRole('dialog', { name: 'Place a payout hold' });
    fireEvent.change(within(dialog).getByLabelText('Reason'), {
      target: { value: 'admin-review' },
    });
    fireEvent.click(within(dialog).getByLabelText('One seller order'));
    fireEvent.change(within(dialog).getByLabelText('Seller order ID'), {
      target: { value: 'MP-1' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Place hold' }));
    expect(within(dialog).getByText('Enter the full seller order ID.')).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText('Seller order ID'), {
      target: { value: ORDER },
    });
    call.mockResolvedValueOnce(ok(hold()));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Place hold' }));
    await waitFor(() =>
      expect(call.mock.calls[0]?.[2]).toEqual({ reason: 'admin-review', sellerOrderId: ORDER }),
    );
  });

  it('releases a hold with a reason and shows it released', async () => {
    mount([hold()]);
    fireEvent.click(screen.getByRole('button', { name: 'Release' }));
    const dialog = screen.getByRole('dialog', { name: 'Release hold' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Release hold' }));
    expect(within(dialog).getByText('Choose a reason.')).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('Reason for releasing'), {
      target: { value: 'review-complete' },
    });
    call.mockResolvedValueOnce(
      ok(
        hold({
          active: false,
          releasedAt: '2026-10-29T01:00:00.000Z',
          releaseReason: 'review-complete',
        }),
      ),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Release hold' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'POST',
        `commission-payouts/admin/payout-holds/${hold().holdId}/release`,
        { reason: 'review-complete' },
        'csrf-1',
      ),
    );
    expect(await screen.findByText('Hold released.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Release' })).toBeNull();
    expect(screen.getByText(/Released .*Review complete/)).toBeTruthy();
  });

  it('says a hold was already released and reads the list again', async () => {
    mount([hold()]);
    fireEvent.click(screen.getByRole('button', { name: 'Release' }));
    const dialog = screen.getByRole('dialog', { name: 'Release hold' });
    fireEvent.change(within(dialog).getByLabelText('Reason for releasing'), {
      target: { value: 'resolved' },
    });
    call.mockResolvedValueOnce(refuse(409, 'commission-payouts.hold-already-released'));
    call.mockResolvedValueOnce(
      ok({
        holds: [
          hold({
            active: false,
            releasedAt: '2026-10-28T00:00:00.000Z',
            releaseReason: 'resolved',
          }),
        ],
      }),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Release hold' }));
    expect(await screen.findByText(/already released/)).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Release' })).toBeNull());
  });
});
