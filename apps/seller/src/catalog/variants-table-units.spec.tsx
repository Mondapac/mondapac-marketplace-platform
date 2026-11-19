// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));
const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

import { callApi } from '../api/client.ts';
import { expectToast } from '../../test/toast-spy.ts';
import type { SellUnitView } from './types.ts';
import { VariantsTable } from './variants-table.tsx';
import type { TableRow } from './variants-table-logic.ts';

const call = vi.mocked(callApi);
const unit = (n: number, over: Partial<SellUnitView> = {}): SellUnitView => ({
  variantId: `v${n}`,
  variantNo: n,
  variantCode: `MP-000123-0${n}`,
  state: 'published',
  label: null,
  selling: true,
  variantSku: null,
  displaySku: over.variantSku ?? `RICE-${n}`,
  ...over,
});
const row = (n: number, label: string, over: Partial<SellUnitView> = {}): TableRow => ({
  variantId: `v${n}`,
  label,
  price: null,
  stock: {},
  unit: unit(n, { label, ...over }),
});
const ROWS = [row(1, 'Small'), row(2, 'Large', { variantSku: 'LG-1' }), row(3, 'Huge')];

function mount(
  over: Partial<Parameters<typeof VariantsTable>[0]> = {},
  scope: 'PLATFORM' | 'SELLER' = 'SELLER',
  canEdit = true,
) {
  return render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <VariantsTable
        offerId="o1"
        rows={ROWS}
        sources={[]}
        currency={null}
        canEditPrice={false}
        canEditStock={false}
        units={{ canEdit, productScope: scope, sellerSku: 'RICE' }}
        csrfToken="csrf"
        {...over}
      />
    </NextIntlClientProvider>,
  );
}
const skuBox = (label: string) => screen.getByLabelText<HTMLInputElement>(`SKU for ${label}`);
const sell = (label: string) =>
  screen.getByRole<HTMLInputElement>('switch', { name: `On sale: ${label}` });
const save = (count: number) =>
  screen.getByRole('button', { name: `Save ${count} change${count === 1 ? '' : 's'}` });

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('VariantsTable SKU and Selling', () => {
  it('shows the saved SKU, the fallback SKU as placeholder and the switch state', () => {
    mount();
    expect(skuBox('Large').value).toBe('LG-1');
    expect(skuBox('Small').value).toBe('');
    expect(skuBox('Small').placeholder).toBe('RICE-1');
    expect(skuBox('Huge').placeholder).toBe('RICE-3');
    expect(sell('Small').checked).toBe(true);
    expect(screen.getByText('MP-000123-02')).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Sizes you sell' })).toBeNull();
  });

  it('shows nothing of it without the catalog view permission', () => {
    mount({ units: null });
    expect(screen.queryByLabelText(/SKU for/)).toBeNull();
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('is read only without the edit permission', () => {
    mount({}, 'SELLER', false);
    expect(screen.queryByLabelText(/SKU for/)).toBeNull();
    expect(screen.getByText('LG-1')).toBeTruthy();
    expect(screen.getByText('RICE-1')).toBeTruthy();
    expect(sell('Small').disabled).toBe(true);
    expect(screen.queryByRole('button', { name: /Save/ })).toBeNull();
  });

  it('mutes an off-sale row, says so, and keeps price and stock editable', () => {
    mount({
      rows: [{ ...ROWS[0]!, unit: unit(1, { label: 'Small', selling: false }) }, ROWS[1]!],
      currency: 'AUD',
      canEditPrice: true,
    });
    const small = screen.getByRole('rowheader', { name: /Small/ }).closest('tr')!;
    expect(within(small).getByText('Off sale')).toBeTruthy();
    expect(small.className).toContain('bg-muted');
    expect(within(small).getByLabelText('Price for Small')).toBeTruthy();
    expect(screen.getAllByText('Off sale')).toHaveLength(1);
  });

  it('sends one PUT with only the changed units, trimmed, and nothing for an unchanged save', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: { changedVariantIds: ['v1', 'v3'] } });
    mount();
    expect(screen.getByRole('button', { name: 'Save changes' }).hasAttribute('disabled')).toBe(
      true,
    );
    fireEvent.change(skuBox('Small'), { target: { value: '  SM-1 ' } });
    fireEvent.click(sell('Huge'));
    fireEvent.click(save(2));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(call).toHaveBeenCalledWith(
      'PUT',
      'catalog/seller/offers/o1/sell-units',
      {
        units: [
          { variantId: 'v1', variantSku: 'SM-1' },
          { variantId: 'v3', selling: false },
        ],
      },
      'csrf',
    );
    await expectToast('Saved 2 changes.');
    expect(refresh).toHaveBeenCalled();
  });

  it('clears a SKU with an empty field', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: { changedVariantIds: ['v2'] } });
    mount();
    fireEvent.change(skuBox('Large'), { target: { value: '' } });
    fireEvent.click(save(1));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(call.mock.calls[0]![2]).toEqual({ units: [{ variantId: 'v2', variantSku: null }] });
  });

  it('with several new SKUs, marks each one as maybe used and shows the table message', async () => {
    call.mockResolvedValue({ ok: false, failure: { status: 409, code: 'offer.sku-taken' } });
    mount();
    fireEvent.change(skuBox('Small'), { target: { value: 'A1' } });
    fireEvent.change(skuBox('Huge'), { target: { value: 'A2' } });
    fireEvent.click(save(2));
    await screen.findByText(/One of the SKUs you entered is already in use/);
    expect(screen.getAllByText('You may already use this SKU. Change it if so.')).toHaveLength(2);
    expect(skuBox('Small').getAttribute('aria-invalid')).toBe('true');
    expect(skuBox('Huge').getAttribute('aria-describedby')).toBeTruthy();
    // the first invalid field takes focus
    await waitFor(() => expect(document.activeElement).toBe(skuBox('Small')));
  });

  it('offers a Reload button when the sizes changed elsewhere', async () => {
    call.mockResolvedValue({ ok: false, failure: { status: 409, code: 'conflict.stale' } });
    mount();
    fireEvent.change(skuBox('Small'), { target: { value: 'SM' } });
    fireEvent.click(save(1));
    fireEvent.click(await screen.findByRole('button', { name: 'Reload' }));
    expect(refresh).toHaveBeenCalled();
  });

  it('does not send the units, and keeps every draft, when the price step-up is cancelled', async () => {
    call.mockResolvedValue({ ok: false, failure: { status: 0, code: 'step-up.cancelled' } });
    mount({
      currency: 'AUD',
      canEditPrice: true,
      rows: ROWS.map((r, i) => ({
        ...r,
        price:
          i === 0
            ? {
                variantId: 'v1',
                seriesVersion: 3,
                currency: 'AUD',
                inForce: { amount: '1000', effectiveFrom: 'x' },
                held: null,
                special: null,
                heldSpecial: null,
                retired: false,
              }
            : null,
      })),
    });
    fireEvent.change(screen.getByLabelText('Price for Small'), { target: { value: '12' } });
    fireEvent.change(skuBox('Large'), { target: { value: 'NEW' } });
    fireEvent.click(save(2));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(call.mock.calls[0]![1]).toMatch(/regular-price/);
    expect(skuBox('Large').value).toBe('NEW');
    expect(screen.getByLabelText<HTMLInputElement>('Price for Small').value).toBe('12');
    await waitFor(() => expect(save(2)).toBeTruthy());
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('refuses a malformed SKU before sending, on that field', () => {
    mount();
    fireEvent.change(skuBox('Small'), { target: { value: 'has space' } });
    fireEvent.click(save(1));
    expect(call).not.toHaveBeenCalled();
    expect(
      screen.getByText('Use 1 to 64 letters, digits or symbols, with no spaces.'),
    ).toBeTruthy();
    expect(skuBox('Small').getAttribute('aria-invalid')).toBe('true');
    expect(skuBox('Small').getAttribute('aria-describedby')).toBeTruthy();
  });

  it('refuses the same SKU on two rows before sending', () => {
    mount();
    fireEvent.change(skuBox('Small'), { target: { value: 'LG-1' } });
    fireEvent.click(save(1));
    expect(call).not.toHaveBeenCalled();
    expect(screen.getAllByText(/typed on more than one variant/)).toHaveLength(2);
  });

  it('keeps the last size selling: its switch is disabled with a hint', () => {
    mount();
    fireEvent.click(sell('Small'));
    fireEvent.click(sell('Large'));
    expect(sell('Huge').disabled).toBe(true);
    const hint = screen.getByText('At least one size must stay on sale.').closest('p')!;
    expect(sell('Huge').getAttribute('aria-describedby')).toBe(hint.id);
    fireEvent.click(sell('Small'));
    expect(sell('Huge').disabled).toBe(false);
  });

  it('shows Sizes you sell on a PLATFORM product, driving the same state as the column', () => {
    mount({}, 'PLATFORM');
    const sizes = screen.getByRole('group', { name: 'Sizes you sell' });
    const box = (label: string) =>
      within(sizes).getByRole<HTMLInputElement>('checkbox', { name: label });
    expect(box('Small').checked).toBe(true);
    fireEvent.click(box('Small'));
    expect(sell('Small').checked).toBe(false);
    fireEvent.click(sell('Large'));
    expect(box('Large').checked).toBe(false);
    // Huge is the last one on sale in both places.
    expect(box('Huge').disabled).toBe(true);
    expect(sell('Huge').disabled).toBe(true);
    expect(within(sizes).getByText('At least one size must stay on sale.')).toBeTruthy();
  });

  it('names a size by its code when it has no label', () => {
    mount({ rows: [{ ...ROWS[0]!, unit: unit(1, { label: null }) }, ROWS[1]!] }, 'PLATFORM');
    const sizes = screen.getByRole('group', { name: 'Sizes you sell' });
    expect(within(sizes).getByRole('checkbox', { name: 'MP-000123-01' })).toBeTruthy();
  });

  it('shows a taken SKU on the only SKU that was set', async () => {
    call.mockResolvedValue({ ok: false, failure: { status: 409, code: 'offer.sku-taken' } });
    mount();
    fireEvent.change(skuBox('Small'), { target: { value: 'TAKEN' } });
    fireEvent.click(save(1));
    expect(await screen.findByText('You already use this SKU. Pick a different one.')).toBeTruthy();
    expect(skuBox('Small').value).toBe('TAKEN');
    expect(skuBox('Small').getAttribute('aria-invalid')).toBe('true');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('shows the server refusal that no unit would keep selling as a table error', async () => {
    call.mockResolvedValue({ ok: false, failure: { status: 422, code: 'offer.none-selling' } });
    mount();
    fireEvent.change(skuBox('Small'), { target: { value: 'SM' } });
    fireEvent.click(save(1));
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /At least one size must stay on sale/,
    );
    expect(skuBox('Small').value).toBe('SM');
  });

  it('maps throttling to the existing throttle message and keeps the drafts', async () => {
    call.mockResolvedValue({
      ok: false,
      failure: { status: 429, code: 'request.throttled', details: { retryAfterSeconds: 30 } },
    });
    mount();
    fireEvent.change(skuBox('Small'), { target: { value: 'SM' } });
    fireEvent.click(save(1));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Too many requests. Wait a moment and try again.',
    );
    expect(skuBox('Small').value).toBe('SM');
  });

  it('saves prices and units together and reports a failed unit write like a failed cell', async () => {
    call
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: { status: 'accepted', seriesVersion: 4, recordId: 'r', effectiveFrom: null },
      })
      .mockResolvedValueOnce({ ok: false, failure: { status: 409, code: 'offer.sku-taken' } });
    mount({
      currency: 'AUD',
      canEditPrice: true,
      rows: ROWS.map((r, i) => ({
        ...r,
        price:
          i === 0
            ? {
                variantId: 'v1',
                seriesVersion: 3,
                currency: 'AUD',
                inForce: { amount: '1000', effectiveFrom: 'x' },
                held: null,
                special: null,
                heldSpecial: null,
                retired: false,
              }
            : null,
      })),
    });
    fireEvent.change(screen.getByLabelText('Price for Small'), { target: { value: '12' } });
    fireEvent.change(skuBox('Large'), { target: { value: 'DUP' } });
    fireEvent.click(save(2));
    await expectToast('Saved 1, 1 could not be saved. The cells that failed show why.', 'info');
    expect(call.mock.calls[1]![1]).toBe('catalog/seller/offers/o1/sell-units');
    expect(screen.getByText('You already use this SKU. Pick a different one.')).toBeTruthy();
  });
});
