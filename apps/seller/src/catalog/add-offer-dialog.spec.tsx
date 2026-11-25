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
  primaryImageId: null,
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
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/offers/offer-1?new=1#sizes'));
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
    // No earlier offer has a handling: none is declared for the seller.
    expect(call.mock.calls.filter(([method]) => method === 'PUT')).toHaveLength(0);
  });

  it('starts a draft with the condition and handling of the last offer that has them', async () => {
    call.mockImplementation((method, path) => {
      if (method === 'POST') return ok({ offerId: 'offer-1' });
      if (method === 'PUT') return ok({ changedFields: ['handling'] });
      if (path.includes('options')) return ok({ conditions: ['new', 'used'] });
      if (path.startsWith('catalog/seller/offers'))
        return ok({
          items: [
            { conditionCode: 'new', handling: null },
            { conditionCode: 'used', handling: 'REPACKED' },
          ],
        });
      return ok(answer([product()]));
    });
    const navigate = open();
    fireEvent.click(await screen.findByLabelText(/Beef mince/));
    const sell = await screen.findByRole('button', { name: 'Sell this' });
    await waitFor(() => expect((sell as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(sell);
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(call).toHaveBeenCalledWith(
      'POST',
      'catalog/seller/offers',
      expect.objectContaining({ conditionCode: 'used' }),
      'csrf',
    );
    expect(call).toHaveBeenCalledWith(
      'PUT',
      'catalog/seller/offers/offer-1/handling',
      { handling: 'REPACKED' },
      'csrf',
    );
  });

  it('creates one draft for each product of "Sell these" and opens the quick entry table', async () => {
    const two = product({ productId: 'x2', productCode: 'P-2', name: 'Lamb' });
    let next = 0;
    call.mockImplementation((method, path) => {
      if (method === 'POST') return ok({ offerId: `o${(next += 1)}` });
      return path.includes('options') ? ok({ conditions: ['new'] }) : ok(answer([product(), two]));
    });
    const navigate = open();
    fireEvent.click(await screen.findByLabelText(/Beef mince/));
    fireEvent.click(screen.getByLabelText(/Lamb/));
    const sell = await screen.findByRole('button', { name: 'Sell these (2)' });
    await waitFor(() => expect((sell as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(sell);
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/offers/new?ids=o1,o2'));
    expect(call.mock.calls.filter(([method]) => method === 'POST')).toHaveLength(2);
  });

  it('keeps the dialog open and names what was refused when some drafts fail', async () => {
    const two = product({ productId: 'x2', productCode: 'P-2' });
    call.mockImplementation((method, path, body) => {
      if (method === 'POST') {
        return (body as { productId: string }).productId === 'x2'
          ? Promise.resolve({
              ok: false as const,
              failure: { status: 409, code: 'offer.sku-taken' },
            })
          : ok({ offerId: 'o1' });
      }
      return path.includes('options') ? ok({ conditions: ['new'] }) : ok(answer([product(), two]));
    });
    const navigate = open();
    fireEvent.click((await screen.findAllByLabelText(/Beef mince/))[0]!);
    fireEvent.click((await screen.findAllByLabelText(/Beef mince/))[1]!);
    const sell = await screen.findByRole('button', { name: 'Sell these (2)' });
    await waitFor(() => expect((sell as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(sell);
    expect(await screen.findByText(/you already use this product code/)).toBeTruthy();
    expect(navigate).not.toHaveBeenCalled();
    expect(await screen.findByText('Open the 1 draft that was created')).toBeTruthy();
    expect(screen.getByText('1 product selected')).toBeTruthy();
  });

  it('opens the drafts of an earlier try together with those of the retry', async () => {
    const two = product({ productId: 'x2', productCode: 'P-2', name: 'Lamb' });
    let refuseLamb = true;
    call.mockImplementation((method, path, body) => {
      if (method === 'POST') {
        if ((body as { productId: string }).productId === 'x2' && refuseLamb) {
          refuseLamb = false;
          return Promise.resolve({
            ok: false as const,
            failure: { status: 503, code: 'access.unavailable' },
          });
        }
        return ok({ offerId: (body as { productId: string }).productId === 'x2' ? 'o2' : 'o1' });
      }
      return path.includes('options') ? ok({ conditions: ['new'] }) : ok(answer([product(), two]));
    });
    const navigate = open();
    fireEvent.click(await screen.findByLabelText(/Beef mince/));
    fireEvent.click(screen.getByLabelText(/Lamb/));
    const sell = await screen.findByRole('button', { name: 'Sell these (2)' });
    await waitFor(() => expect((sell as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(sell);
    expect(await screen.findByText('Open the 1 draft that was created')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Sell this' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/offers/new?ids=o1,o2'));
  });

  it('offers a retry when the shop settings cannot be read', async () => {
    let optionCalls = 0;
    call.mockImplementation((_m, path) => {
      if (path.includes('options')) {
        optionCalls += 1;
        return optionCalls === 1
          ? Promise.resolve({ ok: false as const, failure: { status: 503, code: 'x' } })
          : ok({ conditions: ['new'] });
      }
      return ok(answer([product()]));
    });
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(optionCalls).toBe(2));
    expect(screen.queryByText(/couldn't get your shop's settings/)).toBeNull();
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
