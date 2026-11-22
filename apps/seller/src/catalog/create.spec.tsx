// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from '@mondapac/ui';
import type * as Ui from '@mondapac/ui';
import messages from '../../messages/en.json';

vi.mock('@mondapac/ui', async (original) => ({
  ...(await original<typeof Ui>()),
  DescriptionWriter: () => null,
}));
vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));
// The picker reads its own list (categories C5a); here the read is a fixed, already answered one.
const pickerState = vi.hoisted(() => {
  const value: { state: 'ready' | 'failed'; choices?: readonly unknown[] } = {
    state: 'ready',
    choices: [],
  };
  return { value };
});
vi.mock('./category-choices.ts', () => ({
  useCategoryChoices: () => ({ choices: pickerState.value, load: () => undefined }),
}));
const replace = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace, refresh: vi.fn() }) }));

import { callApi } from '../api/client.ts';
import { blankProduct } from './add-offer.tsx';
import { createProblemOf } from './create-errors.ts';
import { EditForm } from './edit-form.tsx';
import { readable } from './format.ts';
import type { ProductOptions } from './types.ts';
import { expectFlash } from '../../test/toast-spy.ts';

const call = vi.mocked(callApi);
const RICE = {
  id: 'c2',
  level: 4,
  name: 'Rice',
  path: ['Pantry', 'Rice'],
  general: false,
  status: 'active',
};
const options: ProductOptions = {
  productTypes: ['grocery', 'dry-goods'],
  conditions: ['new', 'used'],
  taxCategories: [
    { code: 'gst', labelKey: 'catalog.tax.taxable' },
    { code: 'gst-free-food', labelKey: 'catalog.tax.gst-free' },
    // A key the message catalogue lacks falls back to the code shown as words.
    { code: 'no-label', labelKey: 'catalog.tax.no-label' },
    { code: 'unknown-key', labelKey: 'catalog.tax.nothing-here' },
  ],
  categories: [
    { categoryId: 'c1', parentId: null, names: { 'en-AU': 'Pantry' } },
    { categoryId: 'c2', parentId: 'c1', names: { 'en-AU': 'Rice' } },
  ],
  locales: { default: 'en-AU', supported: ['en-AU', 'ar'] },
  sellerCanCreateProduct: true,
};
const mount = () =>
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <EditForm
        product={blankProduct(options)}
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

const realLocation = window.location;
const assign = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  pickerState.value = { state: 'ready', choices: [RICE] };
  replace.mockReset();
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  Object.defineProperty(window, 'location', {
    value: { assign, reload: vi.fn() },
    writable: true,
    configurable: true,
  });
});
afterEach(() => {
  cleanup();
  Object.defineProperty(window, 'location', {
    value: realLocation,
    writable: true,
    configurable: true,
  });
});

function fill() {
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: ' Olive oil ' } });
  fireEvent.change(screen.getByLabelText('Product type'), { target: { value: 'grocery' } });
  fireEvent.change(screen.getByLabelText(/Your SKU/), { target: { value: ' OIL-1L ' } });
}
function classify() {
  fireEvent.click(screen.getByRole('combobox', { name: 'Add a category' }));
  fireEvent.click(screen.getByRole('option', { name: /Rice/ }));
  fireEvent.change(screen.getByLabelText('Tax category'), { target: { value: 'gst-free-food' } });
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
    expect(screen.getAllByText(/Save the draft first\./).length).toBe(3);
    // Category and tax category work before the first save; tags wait for the product.
    expect(screen.getByRole('combobox', { name: 'Add a category' })).toBeTruthy();
    expect(screen.getByLabelText('Tax category')).toBeTruthy();
    expect(screen.getByText(/Tags: save the draft first/)).toBeTruthy();
    const submit = screen.getByRole('button', { name: 'Submit for review' });
    expect((submit as HTMLButtonElement).disabled).toBe(false);
    expect(submit.getAttribute('aria-disabled')).toBe('true');
    expect(
      screen.getByText(
        /To submit: add a title, choose a product type.*category.*tax category.*save the draft first/,
      ),
    ).toBeTruthy();
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
    classify();
    saveDraft();
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/products/p1'));
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
      {
        content: {
          texts: { 'en-AU': { name: 'Olive oil' } },
          categoryIds: ['c2'],
          taxCategoryCode: 'gst-free-food',
        },
        variantIds: ['v1'],
      },
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
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/products/p1'));
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
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/products/p1'));
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
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/products/p1'));
    expectFlash(/some text was not saved/, 'error');
  });

  it('clears the unsaved guard and flashes the result before it leaves the page', async () => {
    call.mockResolvedValueOnce(created).mockResolvedValueOnce(saved);
    const seen: { bar: boolean; prevented: boolean; flashed: boolean }[] = [];
    replace.mockImplementation(() => {
      const unload = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(unload);
      seen.push({
        bar: screen.queryByText('Unsaved product') !== null,
        prevented: unload.defaultPrevented,
        flashed: vi.mocked(toast.flash).mock.calls.length > 0,
      });
    });
    mount();
    fill();
    expect(screen.getByText('Unsaved product')).toBeTruthy();
    saveDraft();
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/products/p1'));
    expect(seen).toEqual([{ bar: false, prevented: false, flashed: true }]);
    const flash = vi.mocked(toast.flash).mock.invocationCallOrder[0] ?? Infinity;
    expect(flash).toBeLessThan(replace.mock.invocationCallOrder[0] ?? 0);
  });

  it('goes to the sign-in page on a 401 from the create, and does not leave the page', async () => {
    call.mockResolvedValueOnce({ ok: false, failure: { status: 401, code: 'auth.required' } });
    mount();
    fill();
    saveDraft();
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/session-ended'));
    expect(replace).not.toHaveBeenCalled();
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('goes to the sign-in page on a 401 from the draft save after the create', async () => {
    call
      .mockResolvedValueOnce(created)
      .mockResolvedValueOnce({ ok: false, failure: { status: 401, code: 'auth.required' } });
    mount();
    fill();
    saveDraft();
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/session-ended'));
    expect(replace).not.toHaveBeenCalled();
  });

  it('shows a refused product type on the type field and saves no draft', async () => {
    call.mockResolvedValueOnce({ ok: false, failure: { status: 422, code: 'type.not-allowed' } });
    mount();
    fill();
    saveDraft();
    const message = await screen.findAllByText("You can't sell this product type yet.");
    expect(message.length).toBe(2);
    const type = screen.getByLabelText('Product type');
    expect(type.getAttribute('aria-invalid')).toBe('true');
    expect(call).toHaveBeenCalledTimes(1);
    expect(replace).not.toHaveBeenCalled();
  });

  it('shows the banner and keeps the form when the market has product creation off', async () => {
    call.mockResolvedValueOnce({
      ok: false,
      failure: { status: 422, code: 'setting.product-creation-off' },
    });
    mount();
    fill();
    saveDraft();
    expect(
      await screen.findByText('Your market does not let sellers add products yet.'),
    ).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>('Title').value).toBe(' Olive oil ');
    expect(replace).not.toHaveBeenCalled();
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('creates once when Save draft is pressed twice before the create answers', async () => {
    let resolve: (value: never) => void = () => undefined;
    call.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
    call.mockResolvedValueOnce(saved);
    mount();
    fill();
    const form = screen.getByLabelText('Title').closest('form')!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(call).toHaveBeenCalledTimes(1);
    resolve(created as never);
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/products/p1'));
    fireEvent.submit(form);
    expect(call.mock.calls.filter(([method]) => method === 'POST').length).toBe(1);
    expect(replace).toHaveBeenCalledTimes(1);
  });

  it('locks the fields while the product is being created', async () => {
    let resolve: (value: never) => void = () => undefined;
    call.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
    mount();
    fill();
    fireEvent.submit(screen.getByLabelText('Title').closest('form')!);
    expect(screen.getByLabelText<HTMLInputElement>('Title').closest('fieldset')?.disabled).toBe(
      true,
    );
    resolve({ ok: false, failure: { status: 503, code: 'access.unavailable' } } as never);
    await screen.findAllByText(/unavailable right now/);
    expect(screen.getByLabelText<HTMLInputElement>('Title').closest('fieldset')?.disabled).toBe(
      false,
    );
  });

  it('unlocks the form when leaving the page throws', async () => {
    call.mockResolvedValueOnce(created).mockResolvedValueOnce(saved);
    replace.mockImplementationOnce(() => {
      throw new Error('navigation failed');
    });
    mount();
    fill();
    saveDraft();
    await waitFor(() => expect(replace).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getByLabelText<HTMLInputElement>('Title').closest('fieldset')?.disabled).toBe(
        false,
      ),
    );
  });

  it('tells the seller when the category list could not be loaded', () => {
    pickerState.value = { state: 'failed' };
    render(
      <NextIntlClientProvider locale="en-AU" messages={messages}>
        <EditForm
          product={blankProduct({ ...options, categories: [] })}
          photos={null}
          locales={options.locales.supported}
          defaultLocale="en-AU"
          marketName="Australia"
          csrfToken="csrf"
          add={{ options: { ...options, categories: [] } }}
        />
      </NextIntlClientProvider>,
    );
    fireEvent.click(screen.getByRole('combobox', { name: 'Add a category' }));
    expect(screen.getByText("We couldn't load the categories.")).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('explains the category and the tax category, with the tax names from the messages', () => {
    mount();
    expect(screen.getByText(/Choose a category or subcategory\./)).toBeTruthy();
    expect(screen.getByText(/Required\. Separate from the product category/)).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Choose a tax category' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Taxable' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'GST-free' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'No label' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Unknown key' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Choose a product type' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Choose a condition' })).toBeTruthy();
  });

  it('keeps the DOM, and so the Tab order, in the visual order', () => {
    mount();
    const before = (a: HTMLElement, b: HTMLElement) =>
      expect(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const submit = screen.getByRole('button', { name: 'Submit for review' });
    const title = screen.getByLabelText('Title');
    const category = screen.getByRole('combobox', { name: 'Add a category' });
    const tax = screen.getByLabelText('Tax category');
    const type = screen.getByLabelText('Product type');
    const sku = screen.getByLabelText(/Your SKU/);
    const organisation = screen.getByRole('heading', { name: 'Organisation' });
    [submit, title, category, tax, type, sku, organisation].reduce((a, b) => {
      before(a, b);
      return b;
    });
  });

  it('keeps the unavailable Submit focusable and tied to the "To submit" line', () => {
    mount();
    const submit = screen.getByRole('button', { name: 'Submit for review' });
    submit.focus();
    expect(document.activeElement).toBe(submit);
    expect(submit.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(submit);
    expect(call).not.toHaveBeenCalled();
    const line = screen.getByText(/^To submit:/);
    expect(submit.getAttribute('aria-describedby')).toBe(line.id);
    expect(line.parentElement?.getAttribute('aria-live')).toBe('polite');
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
    expect(readable('gst-free-food')).toBe('GST free food');
    expect(readable('gst')).toBe('GST');
  });
});
