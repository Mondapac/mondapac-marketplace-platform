// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

const refresh = vi.fn();
vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

import { callApi } from '../api/client.ts';
import { NotesCard } from './notes-card.tsx';
import { OrderMoreMenu, RefundButton } from './order-actions.tsx';
import { cancelBlock, fullyRefunded, refundBlock, shippingLeft, unitsLeft } from './refunds.ts';
import type { AdminNote, AdminOrderDetail, Refund, SellerPart } from './types.ts';

// The money actions and the notes of the order page (order detail decisions 1 and 3), against
// the AUD fixture and a synthetic JPY one (no minor digits), as the Market rules ask.

const call = vi.mocked(callApi);
const ORDER = '0190a000-0000-7000-8000-000000000001';
const SO_1 = '0190a000-0000-7000-8000-0000000000b1';
const SO_2 = '0190a000-0000-7000-8000-0000000000b2';
const LINE_1 = '0190a000-0000-7000-8000-0000000000c1';
const LINE_2 = '0190a000-0000-7000-8000-0000000000c2';

const markets = [
  { name: 'AU', currency: 'AUD', shipping: '500', typed: '2.50', minor: '250' },
  { name: 'ZZ', currency: 'JPY', shipping: '500', typed: '250', minor: '250' },
] as const;

function fixtures(currency: string, shippingAmount: string) {
  const money = (amount: string) => ({ amount, currency });
  const part = (over: Partial<SellerPart> = {}): SellerPart => ({
    sellerOrderId: SO_1,
    sellerId: '0190a000-0000-7000-8000-0000000000a1',
    storeName: 'Cedar Lane',
    subtotal: money('2000'),
    shipping: money(shippingAmount),
    shippingGross: money(shippingAmount),
    tax: money('182'),
    total: money('2500'),
    fulfilment: 'to-ship',
    carrier: null,
    trackingRef: null,
    shippedAt: null,
    deliveredAt: null,
    deliveryMethod: 'scheduled',
    deliveryWindowStart: null,
    deliveryWindowEnd: null,
    readyAt: null,
    deliveryAttention: null,
    lines: [
      {
        lineId: LINE_1,
        offerId: '0190a000-0000-7000-8000-0000000000d1',
        variantId: '0190a000-0000-7000-8000-0000000000e1',
        quantity: 2,
        unitPrice: money('1000'),
        lineAmount: money('2000'),
        taxInclusive: true,
        taxRateBps: 1000,
        tax: money('182'),
        productName: 'Lamb cutlets',
        variantLabel: null,
      },
    ],
    ...over,
  });
  const refund = (over: Partial<Refund> = {}): Refund => ({
    refundId: '0190a000-0000-7000-8000-0000000000f1',
    sellerOrderId: SO_1,
    state: 'succeeded',
    reason: 'damaged',
    lossBearer: 'seller',
    lossReasonCode: null,
    amount: money('1000'),
    tax: money('91'),
    shipping: null,
    lines: [{ orderLineId: LINE_1, quantity: 1, amount: money('1000'), tax: money('91') }],
    requestedAt: '2026-11-10T01:00:00.000Z',
    settledAt: '2026-11-10T01:00:01.000Z',
    creditNoteId: null,
    ...over,
  });
  const order = (over: Partial<AdminOrderDetail> = {}): AdminOrderDetail => ({
    orderId: ORDER,
    status: 'confirmed',
    cancelReason: null,
    paymentState: 'captured',
    total: money('2500'),
    tax: money('182'),
    createdAt: '2026-11-10T00:00:00.000Z',
    confirmedAt: '2026-11-10T00:01:00.000Z',
    cancelledAt: null,
    payBy: null,
    sellerOrders: [part()],
    accountId: '0190a000-0000-7000-8000-0000000000aa',
    customer: null,
    paymentIntentId: 'pi_1',
    taxStrategyId: null,
    refunds: [],
    refundsEnabled: true,
    ...over,
  });
  return { money, part, refund, order };
}

const wrap = (node: React.ReactNode) => (
  <NextIntlClientProvider locale="en-AU" messages={messages}>
    {node}
  </NextIntlClientProvider>
);

const ok = <T,>(body: T) => ({ ok: true as const, status: 200, body });
const fail = (status: number, code: string) => ({
  ok: false as const,
  failure: { status, code },
});

beforeEach(() => {
  call.mockReset();
  refresh.mockReset();
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});
afterEach(() => cleanup());

describe.each(markets)('what is left to refund ($name)', ({ currency, shipping }) => {
  const { part, refund, order } = fixtures(currency, shipping);

  it('counts pending and succeeded refunds, never failed ones', () => {
    const refunds = [refund(), refund({ state: 'failed' }), refund({ state: 'pending' })];
    expect(unitsLeft(part(), refunds).get(LINE_1)).toBe(0);
    expect(unitsLeft(part(), [refund({ state: 'failed' })]).get(LINE_1)).toBe(2);
  });

  it('allows cancel only while no seller has started and something is left', () => {
    expect(cancelBlock(order())).toBeNull();
    expect(cancelBlock(order({ refundsEnabled: false }))).toBe('disabled');
    expect(cancelBlock(order({ paymentState: 'authorised' }))).toBe('not-paid');
    expect(cancelBlock(order({ status: 'cancelled' }))).toBe('not-paid');
    expect(
      cancelBlock(
        order({
          sellerOrders: [part(), part({ sellerOrderId: SO_2, readyAt: '2026-11-10T02:00:00Z' })],
        }),
      ),
    ).toBe('too-late');
    expect(cancelBlock(order({ sellerOrders: [part({ fulfilment: 'shipped' })] }))).toBe(
      'too-late',
    );
    expect(cancelBlock(order({ refunds: [refund({ state: 'pending' })] }))).toBe('in-progress');
    const all = refund({
      lines: [{ ...refund().lines[0]!, quantity: 2 }],
      shipping: {
        amount: fixtures(currency, shipping).money(shipping),
        tax: { amount: '0', currency },
      },
    });
    expect(fullyRefunded(part(), [all])).toBe(true);
    expect(cancelBlock(order({ refunds: [all] }))).toBe('nothing-left');
  });

  it('keeps the rest of a delivery fee refunded in part', () => {
    const { money } = fixtures(currency, shipping);
    const partial = refund({
      lines: [{ ...refund().lines[0]!, quantity: 2 }],
      shipping: { amount: money('100'), tax: money('0') },
    });
    expect(shippingLeft(part(), [partial])).toBe(400n);
    expect(fullyRefunded(part(), [partial])).toBe(false);
    expect(cancelBlock(order({ refunds: [partial] }))).toBeNull();
    // A fee whose tax was not recorded is not refunded here.
    expect(shippingLeft(part({ shippingGross: null }), [])).toBe(0n);
  });

  it('still refunds one seller after another has started', () => {
    const started = part({ sellerOrderId: SO_2, fulfilment: 'shipped' });
    const value = order({ sellerOrders: [part(), started] });
    expect(refundBlock(value, started)).toBeNull();
    expect(refundBlock({ ...value, refundsEnabled: false }, started)).toBe('disabled');
  });
});

describe.each(markets)('cancel and refund ($name)', ({ currency, shipping }) => {
  const { order } = fixtures(currency, shipping);

  const openCancel = () => {
    fireEvent.click(screen.getByRole('button', { name: 'More order actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Cancel and refund/ }));
  };

  it('is not offered without the refund key', () => {
    render(wrap(<OrderMoreMenu order={order()} canRefund={false} csrfToken="csrf" />));
    expect(screen.queryByRole('button', { name: 'More order actions' })).toBeNull();
  });

  it('says why when a seller has started', () => {
    const value = order();
    render(
      wrap(
        <OrderMoreMenu
          order={{
            ...value,
            sellerOrders: [{ ...value.sellerOrders[0]!, readyAt: '2026-11-10T02:00:00Z' }],
          }}
          canRefund
          csrfToken="csrf"
        />,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'More order actions' }));
    const item = screen.getByRole('menuitem', { name: /Cancel and refund/ });
    expect(item.getAttribute('aria-disabled')).toBe('true');
    expect(document.body.textContent).toContain('A seller has started on this order');
  });

  it('asks for a reason and a second confirmation, then sends the loss with it', async () => {
    call.mockResolvedValueOnce(ok({ orderId: ORDER, refunds: [] }));
    render(wrap(<OrderMoreMenu order={order()} canRefund csrfToken="csrf" />));
    openCancel();
    const confirm = () =>
      screen
        .getAllByRole('button', { name: 'Cancel and refund' })
        .find((button) => button.closest('dialog') !== null)!;
    expect((confirm() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'seller-cancelled' } });
    fireEvent.change(screen.getByLabelText(/Who bears the loss/), {
      target: { value: 'platform' },
    });
    fireEvent.change(screen.getByLabelText('Why the platform bears it'), {
      target: { value: 'goodwill' },
    });
    expect((confirm() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/I understand/));
    fireEvent.click(confirm());
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(call).toHaveBeenCalledWith(
      'POST',
      `ordering/admin/orders/${ORDER}/cancel`,
      { reason: 'seller-cancelled', lossBearer: 'platform', lossReasonCode: 'goodwill' },
      'csrf',
    );
    expect(await screen.findByText('The order was cancelled and refunded.')).toBeTruthy();
  });

  it('says why Confirm waits, and reports refunds Stripe refused', async () => {
    const value = order();
    call.mockResolvedValueOnce(
      ok({
        orderId: ORDER,
        refunds: [fixtures(currency, shipping).refund({ state: 'failed' })],
      }),
    );
    render(wrap(<OrderMoreMenu order={value} canRefund csrfToken="csrf" />));
    openCancel();
    expect(screen.getByText('Choose a reason and tick the box to continue.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'other' } });
    fireEvent.click(screen.getByLabelText(/I understand/));
    expect(screen.queryByText('Choose a reason and tick the box to continue.')).toBeNull();
    fireEvent.click(
      screen
        .getAllByRole('button', { name: 'Cancel and refund' })
        .find((button) => button.closest('dialog') !== null)!,
    );
    expect(await screen.findByText(/Stripe refused 1 refund/)).toBeTruthy();
  });

  it('explains a seller who marked ready at the same moment', async () => {
    call.mockResolvedValueOnce(fail(409, 'ordering.cancel-too-late'));
    render(wrap(<OrderMoreMenu order={order()} canRefund csrfToken="csrf" />));
    openCancel();
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'other' } });
    fireEvent.click(screen.getByLabelText(/I understand/));
    fireEvent.click(
      screen
        .getAllByRole('button', { name: 'Cancel and refund' })
        .find((button) => button.closest('dialog') !== null)!,
    );
    expect(await screen.findByText(/A seller started on this order a moment ago/)).toBeTruthy();
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe.each(markets)(
  'refund one seller order ($name)',
  ({ currency, shipping, typed, minor }) => {
    const { order, part, refund } = fixtures(currency, shipping);

    it('sends the units and the delivery fee in minor units', async () => {
      call.mockResolvedValueOnce(ok({}));
      const value = order({ refunds: [refund()] });
      render(wrap(<RefundButton order={value} part={part()} canRefund csrfToken="csrf" />));
      fireEvent.click(screen.getByRole('button', { name: 'Refund…' }));
      const units = screen.getByLabelText('Lamb cutlets: units to refund (up to 1)');
      fireEvent.change(units, { target: { value: '2' } });
      expect(screen.getByText('Enter a whole number from 1 to 1.')).toBeTruthy();
      fireEvent.change(units, { target: { value: '1' } });
      fireEvent.change(screen.getByLabelText(/Delivery fee to refund/), {
        target: { value: typed },
      });
      fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'damaged' } });
      fireEvent.click(screen.getByLabelText(/I understand/));
      fireEvent.click(screen.getByRole('button', { name: 'Refund' }));
      await waitFor(() => expect(refresh).toHaveBeenCalled());
      expect(call).toHaveBeenCalledWith(
        'POST',
        `ordering/admin/orders/${ORDER}/seller-orders/${SO_1}/refunds`,
        {
          lines: [{ orderLineId: LINE_1, quantity: 1 }],
          shippingAmount: minor,
          reason: 'damaged',
          lossBearer: 'seller',
        },
        'csrf',
      );
    });

    it('refuses more delivery fee than is left', () => {
      render(wrap(<RefundButton order={order()} part={part()} canRefund csrfToken="csrf" />));
      fireEvent.click(screen.getByRole('button', { name: 'Refund…' }));
      fireEvent.change(screen.getByLabelText(/Delivery fee to refund/), {
        target: { value: '9999' },
      });
      expect(screen.getByText(/of the delivery fee is left to refund/)).toBeTruthy();
    });

    it('is disabled with a reason while a refund waits for Stripe', () => {
      const value = order({ refunds: [refund({ state: 'pending' })] });
      render(wrap(<RefundButton order={value} part={part()} canRefund csrfToken="csrf" />));
      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Refund…' }).disabled).toBe(
        true,
      );
      expect(screen.getByText('A refund is still waiting for Stripe.')).toBeTruthy();
    });

    it('is not shown without the refund key', () => {
      render(wrap(<RefundButton order={order()} part={part()} canRefund={false} csrfToken="c" />));
      expect(screen.queryByRole('button', { name: 'Refund…' })).toBeNull();
    });

    it('refunds a second line only up to what is left of it', () => {
      const two = part({
        lines: [
          part().lines[0]!,
          { ...part().lines[0]!, lineId: LINE_2, productName: 'Beef mince', quantity: 3 },
        ],
      });
      render(wrap(<RefundButton order={order()} part={two} canRefund csrfToken="csrf" />));
      fireEvent.click(screen.getByRole('button', { name: 'Refund…' }));
      expect(screen.getByLabelText('Beef mince: units to refund (up to 3)')).toBeTruthy();
    });
  },
);

describe('internal notes', () => {
  const note = (over: Partial<AdminNote> = {}): AdminNote => ({
    noteId: '0190a000-0000-7000-8000-000000000101',
    body: 'Customer called about the bread.',
    authorAccountId: '0190a000-0000-7000-8000-000000000201',
    authorName: 'Reza',
    byYou: false,
    createdAt: '2026-11-10T00:30:00.000Z',
    ...over,
  });

  it('lists notes, with a note whose text went with an erased customer', () => {
    render(
      wrap(
        <NotesCard
          orderId={ORDER}
          notes={[note(), note({ noteId: 'n2', body: null, byYou: true })]}
          canWrite={false}
          csrfToken="csrf"
        />,
      ),
    );
    expect(screen.getByText('Customer called about the bread.')).toBeTruthy();
    expect(screen.getByText(/^Reza, /)).toBeTruthy();
    expect(screen.getByText(/^You, /)).toBeTruthy();
    expect(screen.getByText(/this note's text was removed/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add note' })).toBeNull();
  });

  it('adds a note and reads the page again', async () => {
    call.mockResolvedValueOnce({ ok: true, status: 201, body: note() });
    render(wrap(<NotesCard orderId={ORDER} notes={[]} canWrite csrfToken="csrf" />));
    expect(screen.getByText('No notes yet.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    expect(screen.getByText('Write a note first.')).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Add a note'), { target: { value: ' Called back ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(call).toHaveBeenCalledWith(
      'POST',
      `ordering/admin/orders/${ORDER}/notes`,
      { body: 'Called back' },
      'csrf',
    );
  });

  it('explains an erased customer', async () => {
    call.mockResolvedValueOnce(fail(409, 'ordering.customer-erased'));
    render(wrap(<NotesCard orderId={ORDER} notes={[]} canWrite csrfToken="csrf" />));
    fireEvent.change(screen.getByLabelText('Add a note'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    expect(await screen.findByText(/new notes can't be added/)).toBeTruthy();
  });

  it('says when the notes did not load and offers no form', () => {
    render(wrap(<NotesCard orderId={ORDER} notes={null} canWrite csrfToken="csrf" />));
    expect(screen.getByText("We couldn't load the notes.")).toBeTruthy();
    expect(screen.queryByLabelText('Add a note')).toBeNull();
  });
});
