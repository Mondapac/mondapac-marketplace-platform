// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { STEP_UP_CANCELLED } from '../step-up/step-up.tsx';
import { commissionProblemOf } from './errors.ts';
import { CommissionRateCard } from './rate-card.tsx';
import { bpsOf, percentOf, type CommissionRate } from './types.ts';
import { expectToast } from '../../test/toast-spy.ts';

const call = vi.mocked(callApi);
const wrap = (node: ReactNode) => (
  <NextIntlClientProvider locale="en-AU" messages={messages}>
    {node}
  </NextIntlClientProvider>
);
const SELLER = '0190a000-0000-7000-8000-0000000000a1';
const RATE = `commission-payouts/admin/sellers/${SELLER}/commission-rate`;
const rate = (rateBps: number, source: 'seller' | 'market' = 'seller'): CommissionRate => ({
  sellerId: SELLER,
  rateBps,
  source,
  marketRateBps: 1500,
});

beforeEach(() => {
  vi.clearAllMocks();
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute('open');
  };
});
afterEach(cleanup);

const NOTE = /Note for reviewers/;
const typeNote = (scope: { getByLabelText: (text: RegExp) => HTMLElement }, text = 'Fee review') =>
  fireEvent.change(scope.getByLabelText(NOTE), { target: { value: text } });

const mountRate = (initial: CommissionRate, canEdit = true) =>
  render(wrap(<CommissionRateCard initial={initial} canEdit={canEdit} csrfToken="csrf" />));

describe('CommissionRateCard', () => {
  it('shows the Market rate as a percent with its source', () => {
    mountRate(rate(1500, 'market'));
    expect(screen.getByText('15%')).toBeTruthy();
    expect(screen.getByText('Market default')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Reset to Market rate' })).toBeNull();
  });

  it('shows the seller own rate, with the Market rate beside it, and a reset button', () => {
    mountRate(rate(1250));
    expect(screen.getByText('12.5%')).toBeTruthy();
    expect(screen.getByText("This seller's own rate")).toBeTruthy();
    expect(screen.getByText('The Market rate is 15%.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reset to Market rate' })).toBeTruthy();
  });

  it('hides every control without the edit permission', () => {
    mountRate(rate(1250), false);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('saves the percent as basis points and shows the answer', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: rate(1275) });
    mountRate(rate(1500, 'market'));
    fireEvent.change(screen.getByLabelText(/Commission rate/), { target: { value: '12.75' } });
    typeNote(screen);
    fireEvent.click(screen.getByRole('button', { name: 'Save rate' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(call).toHaveBeenCalledWith('PUT', RATE, { rateBps: 1275, note: 'Fee review' }, 'csrf');
    await expectToast(/Rate saved/);
    expect(screen.getByText('12.75%')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reset to Market rate' })).toBeTruthy();
  });

  it('needs a note before saving, and says so on the field', () => {
    mountRate(rate(1500));
    fireEvent.change(screen.getByLabelText(/Commission rate/), { target: { value: '12' } });
    fireEvent.change(screen.getByLabelText(NOTE), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save rate' }));
    expect(screen.getByText(/Write a note for the reviewers/)).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
    expect(screen.getByText('3 / 500')).toBeTruthy();
  });

  it('says a saved change was sent for review, with its SR number', async () => {
    call.mockResolvedValue({
      ok: true,
      status: 200,
      body: { ...rate(1200), request: { id: 'r1', number: 42 } },
    });
    mountRate(rate(1500));
    fireEvent.change(screen.getByLabelText(/Commission rate/), { target: { value: '12' } });
    typeNote(screen);
    fireEvent.click(screen.getByRole('button', { name: 'Save rate' }));
    await expectToast('Sent for review (SR-42)', 'info');
  });

  it('shows a 400 on note as an error on the note field', async () => {
    call.mockResolvedValue({
      ok: false,
      failure: {
        status: 400,
        code: 'validation.failed',
        details: { fields: [{ path: 'note', code: 'required' }] },
      },
    });
    mountRate(rate(1500));
    fireEvent.change(screen.getByLabelText(/Commission rate/), { target: { value: '12' } });
    typeNote(screen);
    fireEvent.click(screen.getByRole('button', { name: 'Save rate' }));
    expect(await screen.findByText(/The note was refused/)).toBeTruthy();
    expect(screen.queryByText(/That rate was refused/)).toBeNull();
  });

  it('refuses a bad percent before calling the API', () => {
    mountRate(rate(1500));
    for (const bad of ['', 'abc', '-1', '12.345', '30.01', '31']) {
      fireEvent.change(screen.getByLabelText(/Commission rate/), { target: { value: bad } });
      fireEvent.click(screen.getByRole('button', { name: 'Save rate' }));
      expect(screen.getByText(/Enter a percentage between 0 and 30/)).toBeTruthy();
    }
    expect(call).not.toHaveBeenCalled();
  });

  it('asks before resetting, and sends DELETE only after the confirm', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: rate(1500, 'market') });
    mountRate(rate(1250));
    fireEvent.click(screen.getByRole('button', { name: 'Reset to Market rate' }));
    const dialog = screen.getByRole('dialog', { name: 'Reset to the Market rate?' });
    expect(call).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Yes, reset' }));
    expect(call).not.toHaveBeenCalled();
    expect(within(dialog).getByText(/Write a note for the reviewers/)).toBeTruthy();
    typeNote(within(dialog), 'Back to default & done');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Yes, reset' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'DELETE',
        `${RATE}?note=Back%20to%20default%20%26%20done`,
        undefined,
        'csrf',
      ),
    );
    await expectToast(/back on the Market rate/);
    expect(screen.getByText('Market default')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Reset to Market rate' })).toBeNull();
  });

  it('cancelling the confirm sends nothing', () => {
    mountRate(rate(1250));
    fireEvent.click(screen.getByRole('button', { name: 'Reset to Market rate' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(call).not.toHaveBeenCalled();
  });

  it('treats rate-not-set as already on the Market rate', async () => {
    call.mockResolvedValue({
      ok: false,
      failure: { status: 404, code: 'commission-payouts.rate-not-set' },
    });
    mountRate(rate(1250));
    fireEvent.click(screen.getByRole('button', { name: 'Reset to Market rate' }));
    typeNote(within(screen.getByRole('dialog')));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, reset' }));
    expect(await screen.findByText(/already on the Market rate/)).toBeTruthy();
    expect(screen.getByText('Market default')).toBeTruthy();
  });

  it('keeps the screen as it was when the admin closes the code dialog', async () => {
    call.mockResolvedValue({ ok: false, failure: { status: 0, code: STEP_UP_CANCELLED } });
    mountRate(rate(1250));
    fireEvent.change(screen.getByLabelText(/Commission rate/), { target: { value: '11' } });
    typeNote(screen);
    fireEvent.click(screen.getByRole('button', { name: 'Save rate' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Reset to Market rate' }));
    typeNote(within(screen.getByRole('dialog')));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, reset' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/Rate saved|back on the Market rate/)).toBeNull();
    expect(screen.getByText('12.5%')).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: 'Reset to the Market rate?' })).toBeNull();
  });

  it('shows a refusal in words', async () => {
    call.mockResolvedValue({ ok: false, failure: { status: 403, code: 'access.denied' } });
    mountRate(rate(1500));
    typeNote(screen);
    fireEvent.click(screen.getByRole('button', { name: 'Save rate' }));
    expect(await screen.findByText('Your role cannot change commission rates.')).toBeTruthy();
  });
});

describe('helpers', () => {
  it('convert percent and basis points exactly', () => {
    expect(bpsOf('15')).toBe(1500);
    expect(bpsOf('12.5')).toBe(1250);
    expect(bpsOf('0.05')).toBe(5);
    expect(bpsOf('30')).toBe(3000);
    expect(bpsOf('30.00')).toBe(3000);
    expect(bpsOf('30.01')).toBeNull();
    expect(bpsOf('1.234')).toBeNull();
    expect(bpsOf('')).toBeNull();
    expect(percentOf(1500, 'en-AU')).toBe('15');
    expect(percentOf(1275, 'en-AU')).toBe('12.75');
  });

  it('name a failed call', () => {
    expect(commissionProblemOf({ status: 404, code: 'commission-payouts.rate-not-set' })).toBe(
      'not-set',
    );
    expect(commissionProblemOf({ status: 503, code: 'x' })).toBe('unavailable');
    expect(commissionProblemOf({ status: 500, code: 'x' })).toBe('unknown');
  });
});
