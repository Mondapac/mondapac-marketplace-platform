// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Ui from '@mondapac/ui';
import messages from '../../messages/en.json';

vi.mock('@mondapac/ui', async (original) => ({
  ...(await original<typeof Ui>()),
  DescriptionWriter: () => null,
}));
vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));
const replace = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace, refresh: vi.fn() }) }));

import { callApi } from '../api/client.ts';
import { BLANK_PRODUCT } from './add-offer.tsx';
import { createProblemOf } from './create-errors.ts';
import { EditForm } from './edit-form.tsx';
import { readable } from './format.ts';
import type { ProductOptions } from './types.ts';
import { expectFlash } from '../../test/toast-spy.ts';

const call = vi.mocked(callApi);
const options: ProductOptions = {
  productTypes: ['grocery', 'dry-goods'],
  conditions: ['new', 'used'],
  locales: { default: 'en-AU', supported: ['en-AU', 'ar'] },
  sellerCanCreateProduct: true,
};
const mount = () =>
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <EditForm
        product={BLANK_PRODUCT}
        photos={null}
        locales={options.locales.supported}
        defaultLocale="en-AU"
        marketName="Australia"
        csrfToken="csrf"
        add={{ options }}
      />
    </NextIntlClientProvider>,
  );
const created = {
  ok: true,
  status: 201,
  body: { productId: 'p1', productCode: 'P00000001', variantIds: ['v1'], offerId: 'o1' },
} as const;
const saved = { ok: true, status: 200, body: { variantIds: ['v1'], refusedFields: [] } } as const;

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, 'location', {
    value: { assign: vi.fn(), reload: vi.fn() },
    writable: true,
  });
});
afterEach(cleanup);

function fill() {
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: ' Olive oil ' } });
  fireEvent.change(screen.getByLabelText('Product type'), { target: { value: 'grocery' } });
  fireEvent.change(screen.getByLabelText(/Your SKU/), { target: { value: ' OIL-1L ' } });
}
const saveDraft = () => fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));

describe('Add product page', () => {
  it('opens as the one-page form with the offer card, and posts nothing', () => {
    mount();
    expect(screen.getByRole('heading', { level: 1, name: 'Add product' })).toBeTruthy();
    expect(screen.getByText('Your offer')).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Dry goods' })).toBeTruthy();
    expect(screen.getByLabelText<HTMLSelectElement>('Condition').value).toBe('new');
    expect(screen.queryByLabelText(/Description \((en-AU|ar)\)/)).toBeNull();
    // Cards that need the saved product wait, empty.
    expect(screen.getAllByText(/Save the draft first\./).length).toBe(4);
    const submit = screen.getByRole('button', { name: 'Submit for review' });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/To submit: add a title, choose a product type/)).toBeTruthy();
    expect(screen.queryByText('Unsaved product')).toBeNull();
    expect(call).not.toHaveBeenCalled();
  });

  it('shows the Unsaved product bar after the first edit, still without a request', () => {
    mount();
    fill();
    expect(screen.getByText('Unsaved product')).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
  });

  it('creates, then saves the page, then opens the edit page of the new product', async () => {
    call.mockResolvedValueOnce(created).mockResolvedValueOnce(saved);
    mount();
    fill();
    saveDraft();
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/products/p1/edit'));
    expect(call).toHaveBeenNthCalledWith(
      1,
      'POST',
      'catalog/seller/products',
      { typeCode: 'grocery', sellerSku: 'OIL-1L', conditionCode: 'new', description: {} },
      'csrf',
    );
    expect(call).toHaveBeenNthCalledWith(
      2,
      'PUT',
      'catalog/seller/products/p1/draft',
      { content: { texts: { 'en-AU': { name: 'Olive oil' } } }, variantIds: ['v1'] },
      'csrf',
    );
    expectFlash('Draft saved.');
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('asks for the offer fields locally and posts nothing while they are empty', () => {
    mount();
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Olive oil' } });
    saveDraft();
    expect(call).not.toHaveBeenCalled();
    expect(screen.getAllByText('This field is required.').length).toBe(2);
    expect(replace).not.toHaveBeenCalled();
  });

  it('shows a refused SKU on the SKU field, keeps the page and posts no draft', async () => {
    call.mockResolvedValueOnce({ ok: false, failure: { status: 409, code: 'offer.sku-taken' } });
    mount();
    fill();
    saveDraft();
    expect(
      (await screen.findAllByText('You already have an open offer with this SKU.')).length,
    ).toBe(2);
    expect(call).toHaveBeenCalledTimes(1);
    expect(replace).not.toHaveBeenCalled();
    expect(screen.getByLabelText<HTMLInputElement>('Title').value).toBe(' Olive oil ');
    // The seller can fix it and try again.
    call.mockResolvedValueOnce(created).mockResolvedValueOnce(saved);
    fireEvent.change(screen.getByLabelText(/Your SKU/), { target: { value: 'OIL-2L' } });
    saveDraft();
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/products/p1/edit'));
  });

  it('sends a second click only once', async () => {
    let resolve: (value: never) => void = () => undefined;
    call.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
    mount();
    fill();
    const form = screen.getByLabelText('Title').closest('form')!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(call).toHaveBeenCalledTimes(1);
    resolve({ ok: false, failure: { status: 503, code: 'access.unavailable' } } as never);
    expect((await screen.findAllByText(/unavailable right now/)).length).toBeGreaterThan(0);
  });

  it('still opens the edit page when the draft save fails after the create', async () => {
    call
      .mockResolvedValueOnce(created)
      .mockResolvedValueOnce({ ok: false, failure: { status: 503, code: 'access.unavailable' } });
    mount();
    fill();
    saveDraft();
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/products/p1/edit'));
    expectFlash(/Your product was created, but the page was not saved\./, 'error');
    // The product is not created a second time.
    expect(call.mock.calls.filter(([method]) => method === 'POST').length).toBe(1);
  });

  it('says on the edit page when the save refused a text', async () => {
    call.mockResolvedValueOnce(created).mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: {
        variantIds: ['v1'],
        refusedFields: [{ field: 'name', ref: null, locale: 'en-AU', code: 'claim-text' }],
      },
    });
    mount();
    fill();
    saveDraft();
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/products/p1/edit'));
    expectFlash(/some text was not saved/, 'error');
  });

  it('does not offer Submit for review before the product exists', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Submit for review' }));
    expect(call).not.toHaveBeenCalled();
  });
});

describe('helpers', () => {
  it('maps API refusals to messages', () => {
    expect(createProblemOf({ status: 409, code: 'offer.sku-taken' }).fields).toEqual({
      sellerSku: 'catalog.create.error.sku-taken',
    });
    expect(
      createProblemOf({
        status: 400,
        code: 'validation.failed',
        details: { fields: [{ path: 'sellerSku', code: 'required' }] },
      }).fields,
    ).toEqual({ sellerSku: 'catalog.create.validation.required' });
    expect(createProblemOf({ status: 422, code: 'setting.product-creation-off' }).form).toBe(
      'catalog.create.error.creation-off',
    );
  });

  it('formats codes', () => {
    expect(readable('dry-goods')).toBe('Dry goods');
  });
});
