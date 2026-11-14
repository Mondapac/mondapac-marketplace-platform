// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';
import { expectToast } from '../../test/toast-spy.ts';

const { apiMock, refresh } = vi.hoisted(() => ({
  apiMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  refresh: vi.fn<() => void>(),
}));
vi.mock('../api/client.ts', () => ({
  callApi: (...args: unknown[]) => apiMock(...args),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, replace: vi.fn(), push: vi.fn() }),
}));

import { OrderDetail } from './order-detail.tsx';
import { PackingSlip } from './packing-slip.tsx';
import type { ActivityEvent, SellerNote, SellerOrderView } from './types.ts';

const wrap = (node: ReactNode) => (
  <NextIntlClientProvider locale="en-AU" messages={messages} timeZone="Australia/Brisbane">
    {node}
  </NextIntlClientProvider>
);
const aud = (amount: string) => ({ amount, currency: 'AUD' });
const ID = '0190a000-0000-7000-8000-0000000000a1';
const L1 = '0190a000-0000-7000-8000-0000000000c1';
const L2 = '0190a000-0000-7000-8000-0000000000c2';
const order = (over: Partial<SellerOrderView> = {}): SellerOrderView => ({
  sellerOrderId: ID,
  orderId: '0190a000-0000-7000-8000-0000000000b1',
  paidAt: '2026-10-14T10:00:00.000Z',
  subtotal: aud('4500'),
  shipping: aud('500'),
  total: aud('5000'),
  fulfilment: 'to-ship',
  carrier: null,
  trackingRef: null,
  shippedAt: null,
  deliveredAt: null,
  deliveryMethod: 'instant',
  deliveryWindowStart: null,
  deliveryWindowEnd: null,
  readyAt: null,
  deliveryAttention: null,
  refunds: [],
  lines: [
    {
      lineId: L1,
      offerId: '0190a000-0000-7000-8000-0000000000d1',
      variantId: '0190a000-0000-7000-8000-0000000000e1',
      productName: 'Aged Basmati Rice',
      variantLabel: '5 kg',
      quantity: 2,
      unitPrice: aud('1500'),
      lineAmount: aud('3000'),
      taxInclusive: true,
    },
    {
      lineId: L2,
      offerId: '0190a000-0000-7000-8000-0000000000d2',
      variantId: '0190a000-0000-7000-8000-0000000000e2',
      productName: 'Dates',
      variantLabel: null,
      quantity: 1,
      unitPrice: aud('1500'),
      lineAmount: aud('1500'),
      taxInclusive: true,
    },
  ],
  ...over,
});

const mount = (
  props: Partial<Parameters<typeof OrderDetail>[0]> = {},
  initial: SellerOrderView = order(),
) =>
  render(
    wrap(
      <OrderDetail
        initial={initial}
        csrfToken="csrf"
        canMarkReady
        canDeliver
        canMarkUnavailable
        canNote
        showExtras
        notes={[]}
        activity={[]}
        {...props}
      />,
    ),
  );

beforeEach(() => {
  vi.clearAllMocks();
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});
afterEach(cleanup);

const openDialog = () => {
  fireEvent.click(screen.getByRole('button', { name: 'Mark unavailable' }));
  return screen.getByRole('dialog');
};
const confirm = (dialog: HTMLElement) =>
  fireEvent.click(within(dialog).getByRole('button', { name: 'Mark unavailable and refund' }));

describe('Mark unavailable', () => {
  it('is hidden without the key, once ready, and after shipping', () => {
    mount({ canMarkUnavailable: false });
    expect(screen.queryByRole('button', { name: 'Mark unavailable' })).toBeNull();
    cleanup();
    mount({}, order({ readyAt: '2026-10-14T11:00:00.000Z' }));
    expect(screen.queryByRole('button', { name: 'Mark unavailable' })).toBeNull();
    cleanup();
    mount({}, order({ fulfilment: 'shipped' }));
    expect(screen.queryByRole('button', { name: 'Mark unavailable' })).toBeNull();
  });

  it('needs at least one unit, lists them, and refunds with the expected refund count', async () => {
    apiMock.mockResolvedValue({ ok: true, status: 200, body: { amount: aud('3000') } });
    mount();
    const dialog = openDialog();
    expect(
      within(dialog).getByRole<HTMLButtonElement>('button', {
        name: 'Mark unavailable and refund',
      }).disabled,
    ).toBe(true);
    fireEvent.change(within(dialog).getByLabelText(/Aged Basmati Rice/), {
      target: { value: '2' },
    });
    expect(within(dialog).getByText('2 × Aged Basmati Rice')).toBeTruthy();
    expect(within(dialog).getByText(/Each unit is refunded at the price/)).toBeTruthy();
    confirm(dialog);
    await expectToast(/Marked unavailable\. \$30\.00 is being refunded/);
    expect(apiMock).toHaveBeenCalledWith(
      'POST',
      `ordering/seller/orders/${ID}/unavailable`,
      { lines: [{ orderLineId: L1, quantity: 2 }], expectedRefunds: 0 },
      'csrf',
    );
    expect(refresh).toHaveBeenCalled();
  });

  it('says the shipping fee goes back too when every unit is chosen', () => {
    mount();
    const dialog = openDialog();
    fireEvent.change(within(dialog).getByLabelText(/Aged Basmati Rice/), {
      target: { value: '2' },
    });
    fireEvent.change(within(dialog).getByLabelText(/Dates/), { target: { value: '1' } });
    expect(within(dialog).getByText(/rest of the shipping fee/)).toBeTruthy();
  });

  it('offers only the units left after earlier refunds, and counts live refunds', async () => {
    apiMock.mockResolvedValue({ ok: true, status: 200, body: { amount: aud('1500') } });
    const refund = (state: 'succeeded' | 'failed', quantity: number, id: string) => ({
      refundId: id,
      requestedBy: 'seller' as const,
      state,
      reason: 'item-unavailable',
      amount: aud('1500'),
      shipping: null,
      lines: [{ orderLineId: L1, quantity }],
      requestedAt: '2026-10-14T10:30:00.000Z',
      settledAt: null,
    });
    mount({}, order({ refunds: [refund('succeeded', 1, 'r1'), refund('failed', 1, 'r2')] }));
    const dialog = openDialog();
    const input = within(dialog).getByLabelText<HTMLInputElement>(/Aged Basmati Rice/);
    expect(input.max).toBe('1');
    expect(within(dialog).getAllByText(/1 unit left/).length).toBe(2);
    fireEvent.change(input, { target: { value: '5' } });
    expect(input.value).toBe('1');
    confirm(dialog);
    await waitFor(() => expect(apiMock).toHaveBeenCalled());
    expect(apiMock.mock.calls[0]?.[3]).toBe('csrf');
    expect(apiMock.mock.calls[0]?.[2]).toMatchObject({ expectedRefunds: 1 });
  });

  const fail = async (status: number, code: string, text: RegExp, stale = false) => {
    refresh.mockClear();
    apiMock.mockResolvedValue({ ok: false, failure: { status, code } });
    mount();
    const dialog = openDialog();
    fireEvent.change(within(dialog).getByLabelText(/Dates/), { target: { value: '1' } });
    confirm(dialog);
    if (stale) {
      await expectToast(text, 'error');
      expect(refresh).toHaveBeenCalled();
      return;
    }
    await waitFor(() => expect(within(screen.getByRole('dialog')).getByText(text)).toBeTruthy());
    expect(refresh).not.toHaveBeenCalled();
  };

  it('asks to reload when the order was refunded or changed', async () => {
    await fail(
      409,
      'ordering.seller-order-refunded',
      /refunded or changed since you opened it/,
      true,
    );
  });
  it('asks to reload on a stale expected count', async () => {
    await fail(409, 'conflict.retry', /refunded or changed since you opened it/, true);
  });
  it('tells the seller to contact support when the refund limit is reached', async () => {
    await fail(
      409,
      'ordering.refund-limit-reached',
      /reached your refund limit for today.*support/,
    );
  });
  it('tells the seller to contact support when refunds are not set up', async () => {
    await fail(409, 'ordering.refund-limit-unset', /not set up for your store yet.*support/);
  });
  it('explains the other refusals', async () => {
    await fail(409, 'ordering.fulfilment-conflict', /can no longer be marked unavailable/, true);
    cleanup();
    await fail(422, 'ordering.refund-exceeds', /more units than are left/);
    cleanup();
    await fail(422, 'ordering.refund-rejected', /refused the refund/);
    cleanup();
    await fail(403, 'access.denied', /Your role cannot do this/);
    cleanup();
    await fail(503, 'access.unavailable', /not available right now/);
  });
});

const note = (over: Partial<SellerNote> = {}): SellerNote => ({
  noteId: 'n1',
  body: 'Customer asked for a gift bag',
  authorName: 'Amina',
  byYou: false,
  createdAt: '2026-10-14T12:00:00.000Z',
  ...over,
});

describe('Order notes', () => {
  it('lists notes, with the author, and a placeholder for an erased body', () => {
    mount({
      notes: [note(), note({ noteId: 'n2', body: null, byYou: true })],
    });
    expect(screen.getByText('Customer asked for a gift bag')).toBeTruthy();
    expect(screen.getByText(/Amina · /)).toBeTruthy();
    expect(screen.getByText('This note is no longer available.')).toBeTruthy();
    expect(screen.getByText(/You · /)).toBeTruthy();
  });

  it('shows the empty and the unavailable states', () => {
    mount({ notes: [] });
    expect(screen.getByText('No notes yet.')).toBeTruthy();
    cleanup();
    mount({ notes: null });
    expect(screen.getByText(/Notes could not be loaded/)).toBeTruthy();
    expect(screen.queryByLabelText('Add a note')).toBeNull();
  });

  it('hides the form without the note key', () => {
    mount({ canNote: false });
    expect(screen.queryByLabelText('Add a note')).toBeNull();
    expect(screen.getByText('No notes yet.')).toBeTruthy();
  });

  it('adds a note, clears the form and reads the page again', async () => {
    apiMock.mockResolvedValue({ ok: true, status: 201, body: note() });
    mount();
    fireEvent.change(screen.getByLabelText('Add a note'), { target: { value: '  Call first  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    await waitFor(() => expect(screen.getByText('Note added.')).toBeTruthy());
    expect(apiMock).toHaveBeenCalledWith(
      'POST',
      `ordering/seller/orders/${ID}/notes`,
      { body: 'Call first' },
      'csrf',
    );
    expect(refresh).toHaveBeenCalled();
    expect(screen.getByLabelText<HTMLTextAreaElement>('Add a note').value).toBe('');
  });

  it('refuses an empty or too long note without calling the API', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    expect(screen.getByText('Write a note first.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Add a note'), { target: { value: 'x'.repeat(2001) } });
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    expect(screen.getByText(/up to 2000 characters/)).toBeTruthy();
    expect(apiMock).not.toHaveBeenCalled();
  });

  it('explains an erased customer', async () => {
    apiMock.mockResolvedValue({
      ok: false,
      failure: { status: 409, code: 'ordering.customer-erased' },
    });
    mount();
    fireEvent.change(screen.getByLabelText('Add a note'), { target: { value: 'Hello' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    await waitFor(() => expect(screen.getByText(/account was deleted/)).toBeTruthy());
  });

  it('explains an order that is no longer there', async () => {
    apiMock.mockResolvedValue({
      ok: false,
      failure: { status: 404, code: 'ordering.seller-order-not-found' },
    });
    mount();
    fireEvent.change(screen.getByLabelText('Add a note'), { target: { value: 'Hello' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    await waitFor(() => expect(screen.getByText(/no longer available/)).toBeTruthy());
  });
});

describe('Order timeline', () => {
  const events: ActivityEvent[] = [
    {
      kind: 'order-paid',
      at: '2026-10-14T10:00:00.000Z',
      refundId: null,
      amount: null,
      reason: null,
      by: 'customer',
    },
    {
      kind: 'refund-requested',
      at: '2026-10-14T10:30:00.000Z',
      refundId: 'r1',
      amount: aud('1500'),
      reason: 'item-unavailable',
      by: 'seller',
    },
    {
      kind: 'refund-succeeded',
      at: '2026-10-14T10:31:00.000Z',
      refundId: 'r1',
      amount: aud('1500'),
      reason: 'item-unavailable',
      by: null,
    },
    {
      kind: 'seller-order-ready',
      at: '2026-10-14T11:00:00.000Z',
      refundId: null,
      amount: null,
      reason: null,
      by: 'seller',
    },
  ];

  it('renders each step in order, with amounts, who and the zone time', () => {
    mount({ activity: events });
    const list = screen.getByRole('heading', { name: 'Activity' }).closest('section, div')!;
    const items = within(list.parentElement!)
      .getAllByRole('listitem')
      .filter((li) => /Payment received|Refund of|Marked ready/.test(li.textContent ?? ''));
    expect(items.map((li) => li.firstElementChild?.textContent)).toEqual([
      'Payment received',
      'Refund of $15.00 requested',
      'Refund of $15.00 paid back to the customer',
      'Marked ready',
    ]);
    expect(screen.getByText(/Your store · Item unavailable/)).toBeTruthy();
    expect(screen.getAllByText(/8:00 pm|8:00 PM/i).length).toBeGreaterThan(0);
  });

  it('shows the empty and the unavailable states', () => {
    mount({ activity: [] });
    expect(screen.getByText('Nothing has happened yet.')).toBeTruthy();
    cleanup();
    mount({ activity: null });
    expect(screen.getByText(/activity could not be loaded/)).toBeTruthy();
  });
});

const SHIP_TO = {
  recipientFirstName: 'Sara',
  recipientLastName: 'Khan',
  phone: '+61400000000',
  line1: '1 Queen St',
  line2: null,
  suburb: 'Brisbane City',
  region: 'QLD',
  postcode: '4000',
  countryCode: 'AU',
};

describe('Packing slip', () => {
  it('opens from the order page in a new tab', () => {
    mount();
    const link = screen.getByRole('link', { name: 'Print packing slip' });
    expect(link.getAttribute('href')).toBe(`/orders/${ID}/packing-slip`);
    expect(link.getAttribute('target')).toBe('_blank');
  });

  it('prints the units still to send and the address, with no prices', () => {
    const print = vi.spyOn(window, 'print').mockImplementation(() => undefined);
    render(
      wrap(
        <PackingSlip
          order={order({
            buyerNote: 'Leave at the door',
            shipTo: {
              recipientFirstName: 'Sara',
              recipientLastName: 'Khan',
              phone: '+61400000000',
              line1: '1 Queen St',
              line2: null,
              suburb: 'Brisbane City',
              region: 'QLD',
              postcode: '4000',
              countryCode: 'AU',
            },
            refunds: [
              {
                refundId: 'r1',
                requestedBy: 'seller',
                state: 'succeeded',
                reason: 'item-unavailable',
                amount: aud('1500'),
                shipping: null,
                lines: [{ orderLineId: L2, quantity: 1 }],
                requestedAt: '2026-10-14T10:30:00.000Z',
                settledAt: null,
              },
            ],
          })}
        />,
      ),
    );
    expect(screen.getByRole('heading', { name: 'Packing slip' })).toBeTruthy();
    expect(screen.getByText('Sara Khan')).toBeTruthy();
    expect(screen.getByText('Brisbane City QLD 4000')).toBeTruthy();
    expect(screen.getByText('Leave at the door')).toBeTruthy();
    expect(screen.getByText(/Aged Basmati Rice/)).toBeTruthy();
    expect(screen.queryByText('Dates')).toBeNull();
    expect(screen.queryByText(/\$/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Print' }));
    expect(print).toHaveBeenCalled();
  });

  it('is offered and printed only while the order is still to send', () => {
    for (const fulfilment of ['shipped', 'delivered'] as const) {
      cleanup();
      mount({}, order({ fulfilment }));
      expect(screen.queryByRole('link', { name: 'Print packing slip' })).toBeNull();
      cleanup();
      render(wrap(<PackingSlip order={order({ fulfilment })} />));
      expect(screen.getByText(/no packing slip to print/)).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Print' })).toBeNull();
    }
    const refundedInFull = order({
      refunds: order().lines.map((line, index) => ({
        refundId: `r${index}`,
        requestedBy: 'seller' as const,
        state: 'succeeded' as const,
        reason: 'item-unavailable',
        amount: aud('100'),
        shipping: null,
        lines: [{ orderLineId: line.lineId, quantity: line.quantity }],
        requestedAt: '2026-10-14T10:30:00.000Z',
        settledAt: null,
      })),
    });
    cleanup();
    render(wrap(<PackingSlip order={{ ...refundedInFull, shipTo: SHIP_TO }} />));
    expect(screen.getByText(/no packing slip to print/)).toBeTruthy();
    expect(screen.queryByText('Sara Khan')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Print' })).toBeNull();
  });

  it('says when there is no address', () => {
    render(wrap(<PackingSlip order={order({ shipTo: null })} />));
    expect(screen.getByText('No delivery address is on this order.')).toBeTruthy();
  });
});
