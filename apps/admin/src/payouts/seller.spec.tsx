// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { StepUpProvider } from '../step-up/step-up.tsx';
import type { PayoutTerms } from './seller-types.ts';
import { PayoutTermsCard } from './terms-card.tsx';
import { expectToast } from '../../test/toast-spy.ts';

const call = vi.mocked(callApi);
const SELLER = '0190a000-0000-7000-8000-0000000000c1';
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

const typeNote = (dialog: HTMLElement, text = 'Seller asked by email') =>
  fireEvent.change(within(dialog).getByLabelText('Note for reviewers'), {
    target: { value: text },
  });

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
    typeNote(dialog);
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
          note: 'Seller asked by email',
        },
        'csrf-1',
      ),
    );
    expect(await screen.findByText('Payout terms saved.')).toBeTruthy();
  });

  it('needs a note before saving, and shows a 400 on note on the field', async () => {
    mount(own());
    fireEvent.click(screen.getByRole('button', { name: 'Edit for this seller' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit payout terms' });
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'policy' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save terms' }));
    expect(within(dialog).getByText(/Write a note for the reviewers/)).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
    typeNote(dialog);
    call.mockResolvedValueOnce(
      refuse(400, 'validation.failed', { fields: [{ path: 'note', code: 'invalid' }] }),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save terms' }));
    expect(await within(dialog).findByText(/The note was refused/)).toBeTruthy();
  });

  it('says a saved change was sent for review, with its SR number', async () => {
    mount(own());
    fireEvent.click(screen.getByRole('button', { name: 'Edit for this seller' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit payout terms' });
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'policy' } });
    typeNote(dialog);
    call.mockResolvedValueOnce(ok({ ...own(), request: { id: 'r1', number: 7 } }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save terms' }));
    await expectToast('Sent for review (SR-7)', 'info');
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
    typeNote(dialog);
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
    typeNote(dialog);
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
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove seller terms' }));
    expect(within(dialog).getByText(/Write a note for the reviewers/)).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
    typeNote(dialog, 'Back to default & done');
    call.mockResolvedValueOnce(ok(terms()));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove seller terms' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'DELETE',
        `commission-payouts/admin/sellers/${SELLER}/payout-terms?expectedVersion=3&reasonCode=seller-request&note=Back%20to%20default%20%26%20done`,
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
    typeNote(dialog);
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
