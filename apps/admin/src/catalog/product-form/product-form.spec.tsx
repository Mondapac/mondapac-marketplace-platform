// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../messages/en.json';
import type { callApi } from '../../api/client.ts';

// The form also reads the photo library of the product (P1 images). That call goes to its own
// mock, so `call` sees the same calls in the same order as before; the images card has its own
// spec (images-section.spec.tsx).
const mocks = vi.hoisted(() => ({
  call: vi.fn<typeof callApi>(),
  images: vi.fn<typeof callApi>(),
}));
vi.mock('../../api/client.ts', () => ({
  callApi: ((...args: Parameters<typeof callApi>) =>
    args[0] === 'GET' && args[1].endsWith('/images')
      ? mocks.images(...args)
      : mocks.call(...args)) as typeof callApi,
}));

import { expectToast } from '../../../test/toast-spy.ts';
import { ProductCreateForm } from './create-form.tsx';
import { contentWithTexts, ProductEdit, textsOf } from './edit-form.tsx';
import { problemOf } from './errors.ts';
import type { ProductView } from './types.ts';

const call = mocks.call;
const ID = '0190a000-0000-7000-8000-0000000000c1';
const CATEGORY = '0190a000-0000-7000-8000-0000000000d1';
const CHILD = '0190a000-0000-7000-8000-0000000000d2';
const assign = vi.fn();

const view = (over: Partial<ProductView> = {}): ProductView => ({
  productId: ID,
  productCode: 'P00000001',
  typeCode: 'simple',
  familyCode: 'default',
  variantModel: 'single',
  status: 'draft',
  variants: [{ variantId: '0190a000-0000-7000-8000-0000000000e1', state: 'proposed' }],
  maxVariants: 100,
  lastChangedAt: '2026-11-05T01:00:00.000Z',
  createdAt: '2026-11-05T01:00:00.000Z',
  form: {
    taxCategoryCodes: ['gst-free', 'gst'],
    fields: [
      {
        code: 'origin',
        dataType: 'select',
        localizable: false,
        required: false,
        isVariantOption: false,
        bounds: {},
        names: { en: 'Country of origin' },
        options: [
          { code: 'in', labels: { en: 'India' } },
          { code: 'au', labels: { en: 'Australia' } },
        ],
      },
      {
        code: 'grain',
        dataType: 'text',
        localizable: false,
        required: true,
        isVariantOption: false,
        bounds: { maxLength: 10 },
        names: { en: 'Grain length' },
        options: [],
      },
    ],
    categories: [
      { categoryId: CATEGORY, parentId: null, names: { en: 'Pantry' } },
      { categoryId: CHILD, parentId: CATEGORY, names: { en: 'Rice' } },
    ],
  },
  locales: { default: 'en', supported: ['en', 'ar'] },
  workingCopy: {
    content: {
      texts: {
        en: { name: 'Sella rice', shortDescription: 'Short', description: 'Long grain' },
        ar: { name: 'أرز' },
      },
      imageIds: ['img-1'],
    },
    lastSavedAt: '2026-11-05T01:00:00.000Z',
    baseRevisionId: null,
  },
  published: null,
  ...over,
});

function mountEdit() {
  return render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <ProductEdit productId={ID} csrfToken="csrf-1" />
    </NextIntlClientProvider>,
  );
}
const ok = <T,>(body: T) => ({ ok: true as const, status: 200, body });
const fail = (status: number, code: string, details?: object) => ({
  ok: false as const,
  failure: { status, code, ...(details === undefined ? {} : { details }) },
});
const discardDialog = (): HTMLElement =>
  screen.getByText('Discard this product?').closest('dialog') as HTMLElement;
const lastBody = (index: number) => call.mock.calls[index]?.[2] as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  call.mockReset();
  mocks.images.mockReset();
  mocks.images.mockResolvedValue({ ok: true, status: 200, body: { images: [] } });
  Object.defineProperty(window, 'location', {
    value: { assign, href: `${document.baseURI.replace(/\/$/, '')}/catalog/products/edit` },
    writable: true,
  });
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
});
afterEach(cleanup);

describe('the create form', () => {
  const mount = () =>
    render(
      <NextIntlClientProvider locale="en-AU" messages={messages}>
        <ProductCreateForm csrfToken="csrf-1" />
      </NextIntlClientProvider>,
    );

  it('reads the options, asks for a type, and creates the draft with the type only', async () => {
    call.mockResolvedValueOnce(
      ok({
        productTypes: ['simple', 'configurable'],
        locales: { default: 'en', supported: ['en'] },
      }),
    );
    mount();
    expect(await screen.findByRole('heading', { name: 'Add product' })).toBeTruthy();
    expect(call.mock.calls[0]?.slice(0, 2)).toEqual([
      'GET',
      'catalog/admin/platform-products/options',
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'Create draft' }));
    expect(screen.getByText('Choose a product type.')).toBeTruthy();
    expect(call).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByLabelText('Product type'), { target: { value: 'configurable' } });
    call.mockResolvedValueOnce(ok({ productId: ID, productCode: 'P1', variantIds: [] }));
    fireEvent.click(screen.getByRole('button', { name: 'Create draft' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(`/catalog/products/${ID}/edit`));
    expect(call.mock.calls[1]).toEqual([
      'POST',
      'catalog/admin/platform-products',
      { typeCode: 'configurable' },
      'csrf-1',
    ]);
  });

  it('says why a create was refused and keeps the form', async () => {
    call.mockResolvedValueOnce(
      ok({ productTypes: ['simple'], locales: { default: 'en', supported: ['en'] } }),
    );
    mount();
    await screen.findByLabelText('Product type');
    fireEvent.change(screen.getByLabelText('Product type'), { target: { value: 'simple' } });
    call.mockResolvedValueOnce(fail(422, 'product.type-not-offered'));
    fireEvent.click(screen.getByRole('button', { name: 'Create draft' }));
    expect(await screen.findByText("This Market doesn't offer that product type.")).toBeTruthy();
    expect(assign).not.toHaveBeenCalled();
  });

  it('shows a load error with a retry, and goes to sign-in on a 401', async () => {
    call.mockResolvedValueOnce(fail(503, 'access.unavailable'));
    mount();
    expect(await screen.findByText('The product could not be loaded.')).toBeTruthy();
    call.mockResolvedValueOnce(
      ok({ productTypes: ['simple'], locales: { default: 'en', supported: ['en'] } }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByLabelText('Product type')).toBeTruthy();
    cleanup();
    call.mockResolvedValueOnce(fail(401, 'session.invalid'));
    mount();
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/session-ended'));
  });
});

describe('the edit form', () => {
  it('shows the saved English title and description, no language picker, and the lock note', async () => {
    call.mockResolvedValueOnce(ok(view()));
    mountEdit();
    expect((await screen.findByLabelText<HTMLInputElement>('Title')).value).toBe('Sella rice');
    expect(screen.getByLabelText<HTMLTextAreaElement>(/Description/).value).toBe('Long grain');
    expect(screen.queryByRole('combobox', { name: /language/i })).toBeNull();
    expect(screen.getByText('One size')).toBeTruthy();
    expect(screen.getByText(/can't switch between these after the first publish/)).toBeTruthy();
    expect(screen.getByText('Draft')).toBeTruthy();
    expect(screen.getByText('Platform product')).toBeTruthy();
    expect(call.mock.calls[0]?.slice(0, 2)).toEqual([
      'GET',
      `catalog/admin/platform-products/${ID}`,
    ]);
  });

  it('saves the draft writing the default language only and keeping every other key', async () => {
    call.mockResolvedValueOnce(ok(view()));
    mountEdit();
    fireEvent.change(await screen.findByLabelText('Title'), {
      target: { value: ' Basmati rice ' },
    });
    fireEvent.change(screen.getByLabelText('Tax category'), { target: { value: 'gst-free' } });
    call.mockResolvedValueOnce(
      ok({ variantIds: ['0190a000-0000-7000-8000-0000000000e1'], refusedFields: [] }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expectToast('Draft saved.'));
    expect(call.mock.calls[1]?.slice(0, 2)).toEqual([
      'PUT',
      `catalog/admin/platform-products/${ID}/draft`,
    ]);
    expect(lastBody(1)).toEqual({
      content: {
        texts: {
          en: { name: 'Basmati rice', shortDescription: 'Short', description: 'Long grain' },
          ar: { name: 'أرز' },
        },
        imageIds: ['img-1'],
        taxCategoryCode: 'gst-free',
      },
      variantIds: ['0190a000-0000-7000-8000-0000000000e1'],
    });
  });

  it('files a product in categories picked by their full path from a searchable list', async () => {
    call.mockResolvedValueOnce(ok(view()));
    mountEdit();
    const box = await screen.findByRole('combobox', { name: /Product category/ });
    fireEvent.click(box);
    fireEvent.click(await screen.findByRole('option', { name: 'Pantry › Rice' }));
    call.mockResolvedValueOnce(ok({ variantIds: [], refusedFields: [] }));
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(2));
    expect((lastBody(1)['content'] as Record<string, unknown>)['categoryIds']).toEqual([CHILD]);
  });

  it('publishes: saves first, then submits without replacing anything, and shows Published', async () => {
    call.mockResolvedValueOnce(ok(view()));
    mountEdit();
    fireEvent.change(await screen.findByLabelText('Title'), { target: { value: 'Rice' } });
    call.mockResolvedValueOnce(ok({ variantIds: [], refusedFields: [] }));
    call.mockResolvedValueOnce(ok({ revisionId: 'r1', revisionNo: 1, published: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    await waitFor(() => expectToast('Product published.'));
    expect(call.mock.calls[1]?.[0]).toBe('PUT');
    expect(call.mock.calls[2]).toEqual([
      'POST',
      `catalog/admin/platform-products/${ID}/submit`,
      { replacePending: false },
      'csrf-1',
    ]);
    expect(screen.getByText('Published')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Publish changes' })).toBeTruthy();
  });

  it('does not submit when a text kept its last value, and marks the field', async () => {
    call.mockResolvedValueOnce(ok(view()));
    mountEdit();
    fireEvent.change(await screen.findByLabelText('Title'), {
      target: { value: 'Certified halal rice' },
    });
    call.mockResolvedValueOnce(
      ok({
        variantIds: [],
        refusedFields: [
          { field: 'platform-product.name', ref: null, locale: 'en', code: 'claim-text.found' },
        ],
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    expect(await screen.findByText(/Not saved: this text holds a claim/)).toBeTruthy();
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('lists what a draft still lacks when the submit says it is not ready', async () => {
    call.mockResolvedValueOnce(ok(view()));
    mountEdit();
    await screen.findByLabelText('Title');
    // Nothing was edited, so Publish submits the saved draft without saving again.
    call.mockResolvedValueOnce(
      fail(422, 'revision.not-ready', { issues: [{ path: 'taxCategoryCode', code: 'required' }] }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    expect(await screen.findByText("The product isn't ready to publish yet:")).toBeTruthy();
    expect(screen.getByText('taxCategoryCode: required')).toBeTruthy();
  });

  it('reads the product again after a stale save', async () => {
    call.mockResolvedValueOnce(ok(view()));
    mountEdit();
    fireEvent.change(await screen.findByLabelText('Title'), { target: { value: 'Rice' } });
    call.mockResolvedValueOnce(fail(409, 'conflict.stale'));
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(await screen.findByText(/Someone else changed this product/)).toBeTruthy();
    call.mockResolvedValueOnce(ok(view({ status: 'published' })));
    fireEvent.click(screen.getByRole('button', { name: 'Read the product again' }));
    expect(await screen.findByText('Published')).toBeTruthy();
  });

  it('edits the attributes: a searchable list and a text with its bounds', async () => {
    call.mockResolvedValueOnce(ok(view()));
    mountEdit();
    fireEvent.click(await screen.findByRole('combobox', { name: /Country of origin/ }));
    fireEvent.click(await screen.findByRole('option', { name: 'India' }));
    fireEvent.change(screen.getByLabelText('Grain length'), {
      target: { value: 'Extra long grain' },
    });
    expect(screen.getByText('At most 10 characters.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Grain length'), { target: { value: 'Extra long' } });
    call.mockResolvedValueOnce(ok({ variantIds: [], refusedFields: [] }));
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(2));
    expect((lastBody(1)['content'] as Record<string, unknown>)['attributeValues']).toEqual({
      origin: 'in',
      grain: 'Extra long',
    });
  });

  it('adds a variant to a configurable product, mints its id, and writes the draft again', async () => {
    const minted = '0190a000-0000-7000-8000-0000000000e9';
    call.mockResolvedValueOnce(
      ok(
        view({
          variantModel: 'configurable',
          variants: [],
          form: {
            ...view().form,
            fields: [
              {
                code: 'size',
                dataType: 'select',
                localizable: false,
                required: true,
                isVariantOption: true,
                bounds: {},
                names: { en: 'Size' },
                options: [{ code: 'l', labels: { en: 'Large' } }],
              },
            ],
          },
        }),
      ),
    );
    mountEdit();
    expect(await screen.findByText('Different sizes or flavours')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add variant' }));
    fireEvent.change(screen.getByLabelText('Size'), { target: { value: 'l' } });
    call.mockResolvedValueOnce(ok({ variantIds: [minted], refusedFields: [] }));
    call.mockResolvedValueOnce(ok({ variantIds: [minted], refusedFields: [] }));
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(3));
    expect(lastBody(1)['variantIds']).toEqual([null]);
    expect(lastBody(2)['variantIds']).toEqual([minted]);
    expect((lastBody(2)['content'] as { variants: unknown[] }).variants).toEqual([
      { variantId: minted, optionValues: { size: 'l' } },
    ]);
  });

  it('keeps Save draft off until something changes, then asks before leaving with unsaved edits', async () => {
    call.mockResolvedValueOnce(ok(view()));
    mountEdit();
    const saveDraft = await screen.findByRole('button', { name: 'Save draft' });
    expect((saveDraft as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Rice' } });
    expect((saveDraft as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('link', { name: 'Back to products' }));
    expect(await screen.findByText('Leave without saving?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Stay on page' }));
    call.mockResolvedValueOnce(ok({ variantIds: [], refusedFields: [] }));
    fireEvent.click(saveDraft);
    await waitFor(() => expectToast('Draft saved.'));
    expect((saveDraft as HTMLButtonElement).disabled).toBe(true);
  });

  it('lets the admin leave after choosing Leave page, and not ask again after a save', async () => {
    call.mockResolvedValueOnce(ok(view()));
    mountEdit();
    fireEvent.change(await screen.findByLabelText('Title'), { target: { value: 'Rice' } });
    const back = screen.getByRole('link', { name: 'Back to products' });
    fireEvent.click(back);
    fireEvent.click(await screen.findByRole('button', { name: 'Leave page' }));
    await waitFor(() => expect(screen.queryByText('Leave without saving?')).toBeNull());
    call.mockResolvedValueOnce(ok({ variantIds: [], refusedFields: [] }));
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expectToast('Draft saved.'));
    fireEvent.click(back);
    expect(screen.queryByText('Leave without saving?')).toBeNull();
  });

  it('keeps Save draft on for a product that has no draft yet', async () => {
    call.mockResolvedValueOnce(ok(view({ workingCopy: null })));
    mountEdit();
    const saveDraft = await screen.findByRole('button', { name: 'Save draft' });
    expect((saveDraft as HTMLButtonElement).disabled).toBe(false);
  });

  it('discards an unpublished product after asking, then goes back to the list', async () => {
    call.mockResolvedValueOnce(ok(view()));
    mountEdit();
    fireEvent.change(await screen.findByLabelText('Title'), { target: { value: 'Rice' } });
    fireEvent.click(screen.getByRole('button', { name: 'Discard product' }));
    expect(await screen.findByText('Discard this product?')).toBeTruthy();
    expect(call).toHaveBeenCalledTimes(1);
    call.mockResolvedValueOnce(ok({ productId: ID }));
    const dialog = discardDialog();
    fireEvent.click(
      Array.from(dialog.querySelectorAll('button')).find(
        (b) => b.textContent === 'Discard product',
      )!,
    );
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/catalog/products'));
    expect(call.mock.calls[1]).toEqual([
      'POST',
      `catalog/admin/platform-products/${ID}/discard`,
      {},
      'csrf-1',
    ]);
  });

  it('keeps the product when the discard is cancelled or refused, and hides it once published', async () => {
    call.mockResolvedValueOnce(ok(view()));
    mountEdit();
    fireEvent.click(await screen.findByRole('button', { name: 'Discard product' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Keep product' }));
    expect(call).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Discard product' }));
    call.mockResolvedValueOnce(fail(409, 'product.not-a-draft'));
    const dialog = discardDialog();
    fireEvent.click(
      Array.from(dialog.querySelectorAll('button')).find(
        (b) => b.textContent === 'Discard product',
      )!,
    );
    expect(
      await screen.findByText("This product can't be edited in its current state."),
    ).toBeTruthy();
    expect(assign).not.toHaveBeenCalledWith('/catalog/products');
    cleanup();
    call.mockResolvedValueOnce(
      ok(
        view({
          status: 'published',
          published: { revisionId: 'r', revisionNo: 1, publishedAt: '2026-11-05T01:00:00.000Z' },
        } as unknown as Partial<ProductView>),
      ),
    );
    mountEdit();
    await screen.findByRole('button', { name: 'Publish changes' });
    expect(screen.queryByRole('button', { name: 'Discard product' })).toBeNull();
  });

  it('hides Discard once the product was submitted for review, and for a product that is not a draft', async () => {
    call.mockResolvedValueOnce(ok(view()));
    mountEdit();
    fireEvent.change(await screen.findByLabelText('Title'), { target: { value: 'Rice' } });
    call.mockResolvedValueOnce(ok({ variantIds: [], refusedFields: [] }));
    call.mockResolvedValueOnce(ok({ revisionId: 'r1', revisionNo: 1, published: false }));
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    await waitFor(() => expectToast('Product submitted.'));
    expect(screen.queryByRole('button', { name: 'Discard product' })).toBeNull();
    cleanup();
    call.mockResolvedValueOnce(ok(view({ status: 'unpublished' })));
    mountEdit();
    await screen.findByRole('button', { name: 'Publish' });
    expect(screen.queryByRole('button', { name: 'Discard product' })).toBeNull();
  });

  it('says so when the new variants were created but the second save failed', async () => {
    call.mockResolvedValueOnce(
      ok(
        view({
          variantModel: 'configurable',
          variants: [],
          form: { ...view().form, fields: [] },
        }),
      ),
    );
    mountEdit();
    fireEvent.click(await screen.findByRole('button', { name: 'Add variant' }));
    call.mockResolvedValueOnce(
      ok({ variantIds: ['0190a000-0000-7000-8000-0000000000e9'], refusedFields: [] }),
    );
    call.mockResolvedValueOnce(fail(409, 'conflict.stale'));
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(
      await screen.findByText(/The new variants were created but the draft wasn't saved with them/),
    ).toBeTruthy();
  });

  it('says a product is missing, and offers the way back', async () => {
    call.mockResolvedValueOnce(fail(404, 'product.not-found'));
    mountEdit();
    expect(await screen.findByText(/does not exist, or it is not a platform product/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to products' }).getAttribute('href')).toBe(
      '/catalog/products',
    );
  });
});

describe('the helpers', () => {
  it('reads and writes only the default language texts', () => {
    const content = {
      texts: { en: { name: 'A', description: 'B', shortDescription: 'C' }, fr: { name: 'D' } },
    };
    expect(textsOf(content, 'en')).toEqual({ name: 'A', description: 'B' });
    expect(textsOf(undefined, 'en')).toEqual({ name: '', description: '' });
    expect(contentWithTexts(content, 'en', { name: 'X', description: '' })).toEqual({
      texts: { en: { name: 'X', shortDescription: 'C' }, fr: { name: 'D' } },
    });
    expect(contentWithTexts(undefined, 'en', { name: ' ', description: '' })).toEqual({
      texts: {},
    });
  });

  it('maps refusal codes to messages and flags the ones that need a fresh read', () => {
    expect(problemOf({ status: 409, code: 'conflict.stale' })).toMatchObject({
      key: 'stale',
      reload: true,
    });
    expect(
      problemOf({ status: 422, code: 'variant.limit-reached', details: { max: 100 } }),
    ).toMatchObject({
      key: 'variant',
      values: { max: 100 },
    });
    expect(problemOf({ status: 0, code: 'network' }).key).toBe('unavailable');
    expect(problemOf({ status: 418, code: 'odd' }).key).toBe('unknown');
  });
});
