// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));
const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

import { callApi } from '../api/client.ts';
import type { VariantPrice } from '../price/types.ts';
import type { SourceView } from '../stock/types.ts';
import { expectToast } from '../../test/toast-spy.ts';
import { exportVariantFile, type FileModel } from './variant-file.ts';
import { VariantsTable } from './variants-table.tsx';
import type { TableRow } from './variants-table-logic.ts';

// The variant file inside the offer's Variants tab (catalog design 14b): export, the preview of an
// imported file, the stale-stock tick, and the tab's own Save writing what the file changed:
// sequentially, one failed cell never costing the others, a throttled answer stopping the run.

const call = vi.mocked(callApi);
const source: SourceView = {
  id: 's1',
  name: 'Warehouse',
  isDefault: true,
  position: 0,
  address: null,
  timeZone: null,
  createdAt: '2026-10-01T00:00:00Z',
};
const price = (id: string, amount: string): VariantPrice => ({
  variantId: id,
  seriesVersion: 3,
  currency: 'AUD',
  inForce: { amount, effectiveFrom: '2026-01-01T00:00:00Z' },
  held: null,
  special: null,
  heldSpecial: null,
  retired: false,
});
const row = (id: string, label: string, amount: string, onHand: number): TableRow => ({
  variantId: id,
  label,
  price: price(id, amount),
  stock: { s1: { variantId: id, sourceId: 's1', onHand, held: 0, version: 5, retired: false } },
});
const ROWS = [row('v1', 'Small', '1000', 4), row('v2', 'Large', '2000', 9)];
const MODEL: FileModel = {
  productCode: 'AU-000001',
  currency: 'AUD',
  axes: [
    {
      code: 'size',
      options: [
        { code: 'sm', label: 'Small' },
        { code: 'lg', label: 'Large' },
      ],
    },
  ],
  variants: [
    {
      variantId: 'v1',
      variantCode: 'AU-000001-01',
      state: 'published',
      options: { size: 'sm' },
      gtin: '',
      price: '1000',
      stock: { s1: { onHand: 4 } },
    },
    {
      variantId: 'v2',
      variantCode: 'AU-000001-02',
      state: 'published',
      options: { size: 'lg' },
      gtin: '',
      price: '2000',
      stock: { s1: { onHand: 9 } },
    },
  ],
  sources: [{ id: 's1', name: 'Warehouse' }],
  showPrice: true,
  showStock: true,
  canEditPrice: true,
  canEditStock: true,
  maxRows: 20,
};

function mount(model: FileModel = MODEL) {
  return render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <VariantsTable
        offerId="o1"
        rows={ROWS}
        sources={[source]}
        currency="AUD"
        canEditPrice
        canEditStock
        csrfToken="csrf"
        fileModel={model}
      />
    </NextIntlClientProvider>,
  );
}

/** A CSV the seller picked; jsdom's File may lack `arrayBuffer`, so it is given here. */
function pickFile(text: string, name = 'variants.csv') {
  const file = new File([text], name, { type: 'text/csv' });
  const bytes = new TextEncoder().encode(text);
  Object.defineProperty(file, 'arrayBuffer', {
    value: () => Promise.resolve(bytes.buffer.slice(0)),
  });
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  fireEvent.change(input, { target: { files: [file] } });
}
const HEADER = 'product_code,variant_code,price,stock[s1],stock_exported[s1]\r\n';

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

describe('the variant file in the Variants tab', () => {
  it('exports the CSV of the live variants, named by the product code', async () => {
    let text = '';
    const create = vi.fn((blob: Blob) => {
      void blob.text().then((value) => (text = value));
      return 'blob:v';
    });
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() });
    const names: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      names.push(this.download);
    });
    try {
      mount();
      fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
      await waitFor(() => expect(text).not.toBe(''));
      expect(text).toBe(exportVariantFile(MODEL).replace(/^\uFEFF/, ''));
      expect(names[0]).toMatch(/^variants-AU-000001-\d{4}-\d{2}-\d{2}\.csv$/);
    } finally {
      click.mockRestore();
    }
  });

  it('shows an unchanged export as no changes, and applies nothing', async () => {
    mount();
    pickFile(exportVariantFile(MODEL));
    const dialog = await screen.findByRole('dialog', { name: 'Check the changes' });
    expect(within(dialog).getByText('The file has no changes.')).toBeTruthy();
    expect(
      within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Nothing to apply' }).disabled,
    ).toBe(true);
  });

  it('lists changed cells as current to file, fills the drafts, and Save writes them one by one', async () => {
    call.mockResolvedValue({
      ok: true,
      status: 200,
      body: { status: 'pending-review', seriesVersion: 4, recordId: 'r', effectiveFrom: null },
    });
    mount();
    pickFile(`${HEADER}AU-000001,AU-000001-01,25.00,4,4\r\n`);
    const dialog = await screen.findByRole('dialog', { name: 'Check the changes' });
    expect(within(dialog).getByText('10.00 to 25.00')).toBeTruthy();
    // The stock cell equals the current level: it is not listed.
    expect(within(dialog).queryByText(/Stock at Warehouse/)).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply 1 change' }));

    expect(screen.getByLabelText<HTMLInputElement>('Price for Small').value).toBe('25.00');
    fireEvent.click(screen.getByRole('button', { name: 'Save 1 change' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    // The same route and version as a typed cell: a price jump still goes to review there.
    expect(call).toHaveBeenCalledWith(
      'PUT',
      'pricing/seller/offers/o1/variants/v1/regular-price',
      { amount: '2500', currency: 'AUD', expectedVersion: 3 },
      'csrf',
    );
    await expectToast('Saved 1 change.');
  });

  it('keeps a stock cell that moved since the export out until it is ticked', async () => {
    call.mockResolvedValue({
      ok: true,
      status: 200,
      body: { stockItemId: 'i', onHand: 20, version: 6, changed: true },
    });
    mount();
    // Written when the level was 6; it is 4 now.
    pickFile(`${HEADER}AU-000001,AU-000001-01,,20,6\r\n`);
    const dialog = await screen.findByRole('dialog', { name: 'Check the changes' });
    expect(within(dialog).getByText('4 to 20')).toBeTruthy();
    expect(
      within(dialog).getByText('The stock changed since you exported this file.'),
    ).toBeTruthy();
    expect(
      within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Nothing to apply' }).disabled,
    ).toBe(true);

    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Apply anyway' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply 1 change' }));
    expect(
      screen.getAllByLabelText<HTMLInputElement>('Units in stock at Warehouse')[0]!.value,
    ).toBe('20');
    fireEvent.click(screen.getByRole('button', { name: 'Save 1 change' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(call).toHaveBeenCalledWith(
      'PUT',
      'inventory/seller/offers/o1/variants/v1/sources/s1/stock',
      { onHand: 20, expectedVersion: 5 },
      'csrf',
    );
  });

  it('treats a file with no stock_exported value like a moved level', async () => {
    mount();
    pickFile('product_code,variant_code,stock[s1]\r\nAU-000001,AU-000001-01,20\r\n');
    const dialog = await screen.findByRole('dialog', { name: 'Check the changes' });
    expect(within(dialog).getByRole('checkbox', { name: 'Apply anyway' })).toBeTruthy();
  });

  it('stops the run on a throttled answer and keeps every unsent and failed cell as a draft', async () => {
    call
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: { status: 'accepted', seriesVersion: 4, recordId: 'r', effectiveFrom: null },
      })
      .mockResolvedValueOnce({
        ok: false,
        failure: { status: 429, code: 'request.throttled', details: { retryAfterSeconds: 90 } },
      });
    mount();
    pickFile(`${HEADER}AU-000001,AU-000001-01,11.00,4,4\r\nAU-000001,AU-000001-02,22.00,12,9\r\n`);
    const dialog = await screen.findByRole('dialog', { name: 'Check the changes' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply 3 changes' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save 3 changes' }));

    // Price of v1 saved; price of v2 throttled; the stock write is never attempted.
    await waitFor(() => expect(call).toHaveBeenCalledTimes(2));
    await expectToast(
      'Too many changes at once. Saved 1; the rest are kept as drafts. Press Save again in 2 minutes.',
      'warning',
    );
    expect(call).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText<HTMLInputElement>('Price for Large').value).toBe('22.00');
    expect(
      screen.getAllByLabelText<HTMLInputElement>('Units in stock at Warehouse')[1]!.value,
    ).toBe('12');
    expect(
      screen.getByText('Not saved yet: too many changes at once. Try again shortly.'),
    ).toBeTruthy();
  });

  it('refuses a file with a column the role may not change, before any preview', async () => {
    mount({ ...MODEL, canEditPrice: false });
    pickFile(`${HEADER}AU-000001,AU-000001-01,11.00,4,4\r\n`);
    expect(
      await screen.findByText(
        'Your role can’t change these columns: price. Remove them from the file.',
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: 'Check the changes' })).toBeNull();
  });

  it('offers no import without a key to change price or stock, and no file tools without a model', () => {
    mount({ ...MODEL, canEditPrice: false, canEditStock: false });
    expect(screen.getByRole('button', { name: 'Export CSV' })).toBeTruthy();
    expect(screen.queryByText('Import CSV')).toBeNull();
    cleanup();
    render(
      <NextIntlClientProvider locale="en-AU" messages={messages}>
        <VariantsTable
          offerId="o1"
          rows={ROWS}
          sources={[source]}
          currency="AUD"
          canEditPrice
          canEditStock
          csrfToken="csrf"
        />
      </NextIntlClientProvider>,
    );
    expect(screen.queryByRole('button', { name: 'Export CSV' })).toBeNull();
  });
});
