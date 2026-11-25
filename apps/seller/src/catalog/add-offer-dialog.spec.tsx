// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import {
  AddOfferDialog,
  barcodeLines,
  defaultCondition,
  searchPath,
  type PlatformProduct,
  type PlatformSearchAnswer,
} from './add-offer-dialog.tsx';

const call = vi.mocked(callApi);

const product = (over: Partial<PlatformProduct> = {}): PlatformProduct => ({
  productId: '0190aaaa-0000-7000-8000-000000000001',
  productCode: 'P-1',
  name: 'Beef mince',
  brandName: 'Acme',
  categoryId: null,
  categoryName: 'Meat',
  variantCount: 2,
  alreadySelling: false,
  ...over,
});

const answer = (items: PlatformProduct[], over: Partial<PlatformSearchAnswer> = {}) => ({
  items,
  total: items.length,
  page: 1,
  pageSize: 25,
  notice: null,
  barcodeResults: [],
  ...over,
});

const ok = <T,>(body: T) => Promise.resolve({ ok: true as const, status: 200, body });

function open(navigate = vi.fn()) {
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <AddOfferDialog open csrfToken="csrf" onClose={vi.fn()} navigate={navigate} />
    </NextIntlClientProvider>,
  );
  return navigate;
}

beforeEach(() => {
  call.mockReset();
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
});
afterEach(cleanup);

describe('helpers', () => {
  it('builds the search address from the filled keys only', () => {
    expect(searchPath('', 1, [])).toBe('catalog/seller/products/platform-search');
    expect(searchPath(' beef ', 2, ['4006381333931'])).toBe(
      'catalog/seller/products/platform-search?q=beef&page=2&barcodes=4006381333931',
    );
  });
  it('splits a pasted list on lines, commas and spaces, once each', () => {
    expect(barcodeLines('1\n2, 3 ;1\n\n')).toEqual(['1', '2', '3']);
  });
  it('starts a draft as new when the Market has it', () => {
    expect(defaultCondition(['used', 'new'])).toBe('new');
    expect(defaultCondition(['used'])).toBe('used');
    expect(defaultCondition([])).toBeNull();
  });
});

describe('Add offer dialog', () => {
  it('lists what may be sold and shows a product already sold as not selectable', async () => {
    call.mockImplementation((_method, path) =>
      path.includes('options')
        ? ok({ conditions: ['new'] })
        : ok(answer([product(), product({ productId: 'x2', name: 'Lamb', alreadySelling: true })])),
    );
    open();
    expect((await screen.findByLabelText<HTMLInputElement>(/Beef mince/)).disabled).toBe(false);
    expect(screen.getByLabelText<HTMLInputElement>(/Lamb/).disabled).toBe(true);
  });

  it('creates one draft for "Sell this" and opens it', async () => {
    call.mockImplementation((method, path) => {
      if (method === 'POST') return ok({ offerId: 'offer-1' });
      return path.includes('options') ? ok({ conditions: ['new'] }) : ok(answer([product()]));
    });
    const navigate = open();
    fireEvent.click(await screen.findByLabelText(/Beef mince/));
    const sell = await screen.findByRole('button', { name: 'Sell this' });
    await waitFor(() => expect((sell as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(sell);
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/offers/offer-1'));
    expect(call).toHaveBeenCalledWith(
      'POST',
      'catalog/seller/offers',
      {
        productId: product().productId,
        sellerSku: 'P-1',
        conditionCode: 'new',
        description: {},
      },
      'csrf',
    );
  });

  it('creates one draft for each product of "Sell these" and opens the Drafts tab', async () => {
    const two = product({ productId: 'x2', productCode: 'P-2', name: 'Lamb' });
    call.mockImplementation((method, path) => {
      if (method === 'POST') return ok({ offerId: 'o' });
      return path.includes('options') ? ok({ conditions: ['new'] }) : ok(answer([product(), two]));
    });
    const navigate = open();
    fireEvent.click(await screen.findByLabelText(/Beef mince/));
    fireEvent.click(screen.getByLabelText(/Lamb/));
    const sell = await screen.findByRole('button', { name: 'Sell these (2)' });
    await waitFor(() => expect((sell as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(sell);
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/offers?view=drafts'));
    expect(call.mock.calls.filter(([method]) => method === 'POST')).toHaveLength(2);
  });

  it('picks the products found by a pasted barcode list', async () => {
    call.mockImplementation((_method, path) => {
      if (path.includes('options')) return ok({ conditions: ['new'] });
      if (path.includes('barcodes=')) {
        return ok(
          answer([], {
            barcodeResults: [
              { input: '4006381333931', status: 'found', product: product() },
              { input: '123', status: 'invalid', product: null },
            ],
          }),
        );
      }
      return ok(answer([]));
    });
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Paste barcodes' }));
    fireEvent.change(screen.getByLabelText('Barcodes'), {
      target: { value: '4006381333931\n123' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Find products' }));
    expect(await screen.findByText('Not a valid barcode')).toBeTruthy();
    expect(await screen.findByText('1 product selected')).toBeTruthy();
  });

  it('says so when the shop has no business activity', async () => {
    call.mockImplementation((_m, path) =>
      path.includes('options')
        ? ok({ conditions: ['new'] })
        : ok(answer([], { notice: 'no-activity' })),
    );
    open();
    expect(await screen.findByText(/no business activity/)).toBeTruthy();
  });
});
