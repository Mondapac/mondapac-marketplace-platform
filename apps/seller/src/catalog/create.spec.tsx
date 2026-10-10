// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { createProblemOf } from './create-errors.ts';
import { CreateForm, descriptionOf, readable } from './create-form.tsx';
import type { ProductOptions } from './types.ts';

const call = vi.mocked(callApi);
const options: ProductOptions = {
  productTypes: ['grocery', 'dry-goods'],
  conditions: ['new'],
  locales: { default: 'en-AU', supported: ['en-AU', 'ar'] },
  sellerCanCreateProduct: true,
};
const mount = () =>
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <CreateForm options={options} csrfToken="csrf" />
    </NextIntlClientProvider>,
  );
const assign = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, 'location', { value: { assign }, writable: true });
});
afterEach(cleanup);

function fill() {
  fireEvent.change(screen.getByLabelText('Product type'), { target: { value: 'grocery' } });
  fireEvent.change(screen.getByLabelText('Condition'), { target: { value: 'new' } });
  fireEvent.change(screen.getByLabelText(/Your SKU/), { target: { value: 'OIL-1L' } });
}

describe('CreateForm', () => {
  it('offers the types and conditions of the Market and a description per locale', () => {
    mount();
    expect(screen.getByRole('option', { name: 'Dry goods' })).toBeTruthy();
    expect(screen.getByLabelText(/Description \(en-AU\)/)).toBeTruthy();
    expect(screen.getByLabelText(/Description \(ar\)/)).toBeTruthy();
  });

  it('creates the product with only the written descriptions and opens it', async () => {
    call.mockResolvedValue({
      ok: true,
      status: 201,
      body: { productId: 'p1', productCode: 'P00000001', variantIds: [], offerId: 'o1' },
    });
    mount();
    fill();
    fireEvent.change(screen.getByLabelText(/Description \(en-AU\)/), {
      target: { value: ' Cold pressed. ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create product' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/products/p1'));
    expect(call).toHaveBeenCalledWith(
      'POST',
      'catalog/seller/products',
      {
        typeCode: 'grocery',
        sellerSku: 'OIL-1L',
        conditionCode: 'new',
        description: { 'en-AU': 'Cold pressed.' },
      },
      'csrf',
    );
  });

  it('shows a refused type on the type field and keeps the form', async () => {
    call.mockResolvedValue({ ok: false, failure: { status: 422, code: 'type.not-allowed' } });
    mount();
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Create product' }));
    expect((await screen.findAllByText("You can't sell this product type yet.")).length).toBe(2);
    expect(assign).not.toHaveBeenCalled();
    expect(screen.getByLabelText<HTMLInputElement>(/Your SKU/).value).toBe('OIL-1L');
  });

  it('sends a second click only once', async () => {
    let resolve: (value: never) => void = () => undefined;
    call.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
    mount();
    fill();
    const button = screen.getByRole('button', { name: 'Create product' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(call).toHaveBeenCalledTimes(1);
    resolve({ ok: false, failure: { status: 503, code: 'access.unavailable' } } as never);
    expect(await screen.findByText(/unavailable right now/)).toBeTruthy();
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

  it('formats codes and drops empty descriptions', () => {
    expect(readable('dry-goods')).toBe('Dry goods');
    expect(descriptionOf({ a: ' ', b: ' x ' })).toEqual({ b: 'x' });
  });
});
