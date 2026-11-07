// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../messages/en.json';

vi.mock('../../api/client.ts', () => ({ callApi: vi.fn() }));
vi.mock('./photo-prepare.ts', () => ({
  preparePhoto: vi.fn(() => Promise.resolve({ kind: 'ready', data: 'QUJD' })),
}));

import { callApi } from '../../api/client.ts';
import { expectToast } from '../../../test/toast-spy.ts';
import { ProductCreateForm } from './create-form.tsx';
import { contentWithTexts, ProductEdit, textsOf } from './edit-form.tsx';
import { problemOf } from './errors.ts';
import type { ProductView } from './types.ts';

const call = vi.mocked(callApi);
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
  pausedAt: null,
  offers: { sellerCount: 0, offerCount: 0 },
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

function mountEdit(canPause = false) {
  return render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <ProductEdit
        productId={ID}
        csrfToken="csrf-1"
        marketName="Australia"
        timeZone="Australia/Brisbane"
        canPause={canPause}
      />
    </NextIntlClientProvider>,
  );
}

/** A saved draft that holds everything Publish needs: title, category, tax category, grain. */
const ready = (over: Partial<ProductView> = {}): ProductView => {
  const base = view();
  return view({
    workingCopy: {
      content: {
        ...base.workingCopy!.content,
        categoryIds: [CHILD],
        taxCategoryCode: 'gst-free',
        attributeValues: { grain: 'Extra long' },
      },
      lastSavedAt: '2026-11-05T01:00:00.000Z',
      baseRevisionId: null,
    },
    ...over,
  });
};
/** A published product with a revision 1 and a newer saved draft. */
const live = (over: Partial<ProductView> = {}): ProductView =>
  ready({
    status: 'published',
    offers: { sellerCount: 3, offerCount: 7 },
    published: {
      revisionId: 'r1',
      revisionNo: 1,
      submittedAt: '2026-11-03T01:00:00.000Z',
      content: {},
    },
    ...over,
  });
const headings = () => Array.from(document.querySelectorAll('h2')).map((h) => h.textContent);
const dialogOf = (title: string): HTMLElement =>
  screen.getByText(title).closest('dialog') as HTMLElement;
const inDialog = (title: string, name: string): HTMLElement =>
  Array.from(dialogOf(title).querySelectorAll('button')).find((b) => b.textContent === name)!;
const ok = <T,>(body: T) => ({ ok: true as const, status: 200, body });
const fail = (status: number, code: string, details?: object) => ({
  ok: false as const,
  failure: { status, code, ...(details === undefined ? {} : { details }) },
});
/** The calls the form made, without the read of the picture list it does when it opens. */
const calls = () =>
  call.mock.calls.filter(
    ([method, path]) => !(method === 'GET' && String(path).endsWith('/images')),
  );
const lastBody = (index: number) => calls()[index]?.[2] as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  call.mockReset();
  // The pictures are read when the form opens; a test that wants some sets its own answer.
  call.mockImplementation(((_method: string, path: string) =>
    Promise.resolve(path.endsWith('/images') ? ok({ images: [] }) : undefined)) as never);
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
    expect(calls()[0]?.slice(0, 2)).toEqual(['GET', 'catalog/admin/platform-products/options']);

    // The heading shows while the options load; the form (and its button) only after the read.
    fireEvent.click(await screen.findByRole('button', { name: 'Create draft' }));
    expect(screen.getByText('Choose a product type.')).toBeTruthy();
    expect(calls()).toHaveLength(1);

    fireEvent.change(screen.getByLabelText('Product type'), { target: { value: 'configurable' } });
    call.mockResolvedValueOnce(ok({ productId: ID, productCode: 'P1', variantIds: [] }));
    fireEvent.click(screen.getByRole('button', { name: 'Create draft' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(`/catalog/products/${ID}/edit`));
    expect(calls()[1]).toEqual([
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
  it('shows the saved English title as the page title, no language picker, and the lock note', async () => {
    call.mockResolvedValueOnce(ok(view()));
    mountEdit();
    expect((await screen.findByLabelText<HTMLInputElement>('Title')).value).toBe('Sella rice');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Sella rice');
    expect(screen.getByText('Platform product · Australia · P00000001')).toBeTruthy();
    expect(screen.getByLabelText<HTMLTextAreaElement>(/Description/).value).toBe('Long grain');
    expect(screen.queryByRole('combobox', { name: /language/i })).toBeNull();
    expect(screen.getByText('One size')).toBeTruthy();
    expect(screen.getByText(/can't switch between these after the first publish/)).toBeTruthy();
    expect(screen.getAllByText('Draft').length).toBe(2);
    expect(screen.getByText('Platform product')).toBeTruthy();
    expect(screen.getByText('Australia')).toBeTruthy();
    expect(calls()[0]?.slice(0, 2)).toEqual(['GET', `catalog/admin/platform-products/${ID}`]);
  });

  it('lands an untouched draft as "Add product": empty state, no unsaved bar, Publish off', async () => {
    call.mockResolvedValueOnce(
      ok(view({ workingCopy: null, form: { ...view().form, fields: [] } })),
    );
    mountEdit();
    expect(await screen.findByRole('heading', { level: 1, name: 'Add product' })).toBeTruthy();
    expect(screen.getByText('Platform product · Australia')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).toBeNull();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Publish' }).disabled).toBe(true);
    expect(
      screen.getByText('To publish: add a title, choose a category and choose the tax category.'),
    ).toBeTruthy();
    expect(
      screen.getByText('Choose a category first. Its feature set lists what to fill in here.'),
    ).toBeTruthy();
    expect(
      screen.getByText(
        'Only a category or subcategory (levels 3 and 4). It decides the product details and variant types.',
      ),
    ).toBeTruthy();
    expect(screen.getByText('Choose a category or subcategory')).toBeTruthy();
    expect(screen.getByText('Choose a tax category')).toBeTruthy();
    expect(screen.getByText(/Sellers can't find it until you publish/)).toBeTruthy();
  });

  it('orders the cards: Status first on a phone, then Product, Category, details, Variants, the rest', async () => {
    call.mockResolvedValueOnce(ok(live()));
    mountEdit(true);
    await screen.findByLabelText('Title');
    await screen.findByRole('heading', { name: 'Photos' });
    expect(headings()).toEqual([
      'Status',
      'Product',
      'Category',
      'Product details',
      'Photos',
      'Variants',
      'Organisation',
      'Sellers selling it',
    ]);
    expect(screen.queryByLabelText(/^(price|stock|sku|cost)/i)).toBeNull();
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
    expect(calls()[1]?.slice(0, 2)).toEqual(['PUT', `catalog/admin/platform-products/${ID}/draft`]);
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
    await waitFor(() => expect(calls()).toHaveLength(2));
    expect((lastBody(1)['content'] as Record<string, unknown>)['categoryIds']).toEqual([CHILD]);
  });

  it('publishes after a confirm: saves first, then submits without replacing anything', async () => {
    call.mockResolvedValueOnce(ok(ready()));
    mountEdit(true);
    fireEvent.change(await screen.findByLabelText('Title'), { target: { value: 'Rice' } });
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: 'Publish' }));
    expect(await screen.findByText('Publish Rice?')).toBeTruthy();
    expect(calls()).toHaveLength(1);
    const dialog = dialogOf('Publish Rice?');
    expect(dialog.textContent).toContain(
      'Sellers in Australia can find it and add their offers. Buyers see it once at least one offer is on sale.',
    );
    expect(dialog.textContent).toContain('Variants1');
    expect(dialog.textContent).toContain('English · translated when a buyer language is published');
    call.mockResolvedValueOnce(ok({ variantIds: [], refusedFields: [] }));
    call.mockResolvedValueOnce(ok({ revisionId: 'r1', revisionNo: 1, published: true }));
    fireEvent.click(inDialog('Publish Rice?', 'Publish'));
    await waitFor(() => expectToast('Product published.'));
    expect(calls()[1]?.[0]).toBe('PUT');
    expect(calls()[2]).toEqual([
      'POST',
      `catalog/admin/platform-products/${ID}/submit`,
      { replacePending: false },
      'csrf-1',
    ]);
    expect(screen.getAllByText('Published').length).toBeGreaterThan(0);
    expect(screen.getByText('Rice is published.')).toBeTruthy();
    expect(screen.getByText('Sellers can now add their offers.')).toBeTruthy();
    expect(screen.getByRole('switch', { name: 'Active' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Discard product' })).toBeNull();
  });

  it('shows the claim words error under the title, counts it in the bar and keeps Save off', async () => {
    call.mockResolvedValueOnce(ok(ready()));
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
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(
      await screen.findByText(
        'Product text can\'t include certification words like "halal". Badges come from seller offers.',
      ),
    ).toBeTruthy();
    expect(screen.getByText('1 field needs fixing')).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save draft' }).disabled).toBe(
      true,
    );
    expect(calls()).toHaveLength(2);
    // Editing the title clears the error and puts the bar back to unsaved.
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Certified rice' } });
    expect(screen.queryByText('1 field needs fixing')).toBeNull();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save draft' }).disabled).toBe(
      false,
    );
  });

  it('lists what the server says is missing when it refuses a publish', async () => {
    call.mockResolvedValueOnce(ok(ready()));
    mountEdit();
    await screen.findByLabelText('Title');
    // Nothing was edited, so Publish submits the saved draft without saving again.
    call.mockResolvedValueOnce(
      fail(422, 'revision.not-ready', { issues: [{ path: 'variants', code: 'variants.none' }] }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    fireEvent.click(inDialog('Publish Sella rice?', 'Publish'));
    expect(await screen.findByText("The product isn't ready to publish yet:")).toBeTruthy();
    expect(screen.getByText('variants: variants.none')).toBeTruthy();
  });

  it('names what is missing in the order title, category, tax category, required details', async () => {
    call.mockResolvedValueOnce(ok(view()));
    mountEdit();
    await screen.findByLabelText('Title');
    expect(
      screen.getByText(
        'To publish: choose a category, choose the tax category and fill in the required details.',
      ),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: '' } });
    expect(
      screen.getByText(
        'To publish: add a title, choose a category, choose the tax category and fill in the required details.',
      ),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Tax category'), { target: { value: 'gst' } });
    fireEvent.change(screen.getByLabelText('Grain length'), { target: { value: 'Long' } });
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Rice' } });
    expect(screen.getByText('To publish: choose a category.')).toBeTruthy();
  });

  it('reads the product again after a stale save, with the newer-revision banner', async () => {
    call.mockResolvedValueOnce(ok(view()));
    mountEdit();
    fireEvent.change(await screen.findByLabelText('Title'), { target: { value: 'Rice' } });
    call.mockResolvedValueOnce(fail(409, 'conflict.stale'));
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(await screen.findByText('Someone published a newer revision.')).toBeTruthy();
    call.mockResolvedValueOnce(ok(view({ status: 'published' })));
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect((await screen.findAllByText('Published')).length).toBeGreaterThan(0);
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
    await waitFor(() => expect(calls()).toHaveLength(2));
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
    await waitFor(() => expect(calls()).toHaveLength(3));
    expect(lastBody(1)['variantIds']).toEqual([null]);
    expect(lastBody(2)['variantIds']).toEqual([minted]);
    expect((lastBody(2)['content'] as { variants: unknown[] }).variants).toEqual([
      { variantId: minted, optionValues: { size: 'l' } },
    ]);
  });

  it('shows the unsaved bar only after an edit, and asks before leaving with unsaved edits', async () => {
    call.mockResolvedValueOnce(ok(view()));
    mountEdit();
    await screen.findByLabelText('Title');
    expect(screen.queryByRole('button', { name: 'Save draft' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Rice' } });
    const bar = screen.getByRole('region', { name: 'Unsaved changes' });
    expect(bar.textContent).toContain('Unsaved product');
    const saveDraft = screen.getByRole<HTMLButtonElement>('button', { name: 'Save draft' });
    expect(saveDraft.disabled).toBe(false);
    fireEvent.click(screen.getByRole('link', { name: 'Back to products' }));
    expect(await screen.findByText('Leave this page?')).toBeTruthy();
    expect(screen.getByText("Your changes to Sella rice aren't saved.")).toBeTruthy();
    const leave = dialogOf('Leave this page?');
    expect(document.activeElement).toBe(inDialog('Leave this page?', 'Cancel'));
    expect(inDialog('Leave this page?', 'Leave without saving')).toBeTruthy();
    expect(leave.querySelector('button.bg-critical-solid')).not.toBeNull();
    fireEvent.click(inDialog('Leave this page?', 'Cancel'));
    call.mockResolvedValueOnce(ok({ variantIds: [], refusedFields: [] }));
    fireEvent.click(saveDraft);
    await waitFor(() => expectToast('Draft saved.'));
    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).toBeNull();
  });

  it('lets the admin leave after choosing Leave without saving, and not ask again after a save', async () => {
    call.mockResolvedValueOnce(ok(view()));
    mountEdit();
    fireEvent.change(await screen.findByLabelText('Title'), { target: { value: 'Rice' } });
    const back = screen.getByRole('link', { name: 'Back to products' });
    fireEvent.click(back);
    fireEvent.click(await screen.findByRole('button', { name: 'Leave without saving' }));
    await waitFor(() => expect(screen.queryByText('Leave this page?')).toBeNull());
    call.mockResolvedValueOnce(ok({ variantIds: [], refusedFields: [] }));
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expectToast('Draft saved.'));
    fireEvent.click(back);
    expect(screen.queryByText('Leave this page?')).toBeNull();
  });

  it('falls back to a plain leave message when the product has no title', async () => {
    call.mockResolvedValueOnce(ok(view({ workingCopy: null })));
    mountEdit();
    fireEvent.change(await screen.findByLabelText('Title'), { target: { value: 'Rice' } });
    fireEvent.click(screen.getByRole('link', { name: 'Back to products' }));
    expect(await screen.findByText("Your changes aren't saved.")).toBeTruthy();
  });

  it('throws the edits away with Discard in the bar by reading the product again', async () => {
    call.mockResolvedValueOnce(ok(view()));
    mountEdit();
    fireEvent.change(await screen.findByLabelText('Title'), { target: { value: 'Rice' } });
    call.mockResolvedValueOnce(ok(view()));
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(calls()).toHaveLength(2));
    expect(calls()[1]?.[0]).toBe('GET');
    expect((await screen.findByLabelText<HTMLInputElement>('Title')).value).toBe('Sella rice');
    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).toBeNull();
  });

  it('discards an unpublished product after asking, then goes back to the list', async () => {
    call.mockResolvedValueOnce(ok(view()));
    mountEdit();
    fireEvent.change(await screen.findByLabelText('Title'), { target: { value: 'Rice' } });
    fireEvent.click(screen.getByRole('button', { name: 'Discard product' }));
    expect(await screen.findByText('Discard this product?')).toBeTruthy();
    expect(calls()).toHaveLength(1);
    call.mockResolvedValueOnce(ok({ productId: ID }));
    fireEvent.click(inDialog('Discard this product?', 'Discard product'));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/catalog/products'));
    expect(calls()[1]).toEqual([
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
    expect(calls()).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Discard product' }));
    call.mockResolvedValueOnce(fail(409, 'product.not-a-draft'));
    fireEvent.click(inDialog('Discard this product?', 'Discard product'));
    expect(
      await screen.findByText("This product can't be edited in its current state."),
    ).toBeTruthy();
    expect(assign).not.toHaveBeenCalledWith('/catalog/products');
    cleanup();
    call.mockResolvedValueOnce(ok(live()));
    mountEdit();
    await screen.findByRole('button', { name: 'Publish revision 2' });
    expect(screen.queryByRole('button', { name: 'Discard product' })).toBeNull();
  });

  it('hides Discard once the product was submitted for review, and for a product that is not a draft', async () => {
    call.mockResolvedValueOnce(ok(ready()));
    mountEdit();
    fireEvent.change(await screen.findByLabelText('Title'), { target: { value: 'Rice' } });
    call.mockResolvedValueOnce(ok({ variantIds: [], refusedFields: [] }));
    call.mockResolvedValueOnce(ok({ revisionId: 'r1', revisionNo: 1, published: false }));
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    fireEvent.click(inDialog('Publish Rice?', 'Publish'));
    await waitFor(() => expectToast('Product submitted.'));
    expect(screen.queryByRole('button', { name: 'Discard product' })).toBeNull();
    cleanup();
    call.mockResolvedValueOnce(ok(ready({ status: 'unpublished' })));
    mountEdit();
    await screen.findByRole('button', { name: 'Publish' });
    expect(screen.queryByRole('button', { name: 'Discard product' })).toBeNull();
  });

  it('shows the product pictures from the library and keeps the picked ones in the draft', async () => {
    const photo = { imageId: 'img-1', width: 800, height: 600, createdAt: '2026-11-05T01:00:00Z' };
    const spare = { imageId: 'img-2', width: 400, height: 400, createdAt: '2026-11-05T01:00:00Z' };
    call.mockResolvedValueOnce(ok(view()));
    call.mockImplementation((_m: string, path: string) =>
      Promise.resolve(
        path.endsWith('/images')
          ? ok({ images: [photo, spare] })
          : ok({ variantIds: [], refusedFields: [] }),
      ),
    );
    mountEdit();
    expect(await screen.findByText('Main photo')).toBeTruthy();
    expect(screen.getByText('Not on the product')).toBeTruthy();
    const sources = screen.getAllByRole('img').map((img) => img.getAttribute('src'));
    expect(sources[0]).toBe(`/api/catalog/admin/platform-products/${ID}/images/img-1/medium`);
    fireEvent.click(screen.getByRole('button', { name: 'Add back' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expectToast('Draft saved.'));
    const saved = calls().find((c) => c[0] === 'PUT');
    expect((saved?.[2] as { content: { imageIds: string[] } }).content.imageIds).toEqual([
      'img-1',
      'img-2',
    ]);
  });

  it('uploads a picture, adds it to the draft, and deletes one after asking', async () => {
    call.mockResolvedValueOnce(ok(view({ workingCopy: null })));
    const added = { imageId: 'img-9', width: 800, height: 600, createdAt: '2026-11-05T01:00:00Z' };
    call.mockImplementation(((method: string, path: string) =>
      Promise.resolve(
        path.endsWith('/images') && method === 'GET'
          ? ok({ images: [] })
          : method === 'POST'
            ? ok(added)
            : method === 'DELETE'
              ? ok({ deleted: true })
              : undefined,
      )) as never);
    mountEdit();
    const input = await screen.findByLabelText<HTMLInputElement>('Add photos');
    fireEvent.change(input, {
      target: { files: [new File(['x'], 'rice.jpg', { type: 'image/jpeg' })] },
    });
    expect(await screen.findByText('Main photo')).toBeTruthy();
    const post = calls().find((c) => c[0] === 'POST');
    expect(post?.[1]).toBe(`catalog/admin/platform-products/${ID}/images`);
    expect(post?.[2]).toEqual({ data: 'QUJD' });
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(calls().some((c) => c[0] === 'DELETE')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Yes, delete' }));
    await waitFor(() => expect(screen.queryByText('Main photo')).toBeNull());
    expect(calls().find((c) => c[0] === 'DELETE')?.[1]).toBe(
      `catalog/admin/platform-products/${ID}/images/img-9`,
    );
  });

  it('says the pictures are unavailable when they cannot be read, and the rest of the form works', async () => {
    call.mockResolvedValueOnce(ok(view()));
    call.mockImplementation(((_m: string, path: string) =>
      Promise.resolve(
        path.endsWith('/images') ? fail(503, 'access.unavailable') : undefined,
      )) as never);
    mountEdit();
    expect(await screen.findByText(/Photos are unavailable right now/)).toBeTruthy();
    expect(screen.getByLabelText('Title')).toBeTruthy();
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

describe('a published product', () => {
  it('shows the revision badge, the next revision to publish, and saves as a revision', async () => {
    call.mockResolvedValueOnce(ok(live()));
    mountEdit();
    await screen.findByLabelText('Title');
    expect(screen.getByText('Revision 2 · unpublished changes')).toBeTruthy();
    expect(
      screen.getByText(
        'Changes are saved as a new revision. Buyers keep seeing revision 1 until you publish.',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Publish revision 2' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Rice 2' } });
    expect(screen.getByRole('region', { name: 'Unsaved changes' }).textContent).toContain(
      'Unsaved changes',
    );
    call.mockResolvedValueOnce(ok({ variantIds: [], refusedFields: [] }));
    fireEvent.click(screen.getByRole('button', { name: 'Save revision' }));
    await waitFor(() => expectToast('Revision saved.'));
  });

  it('shows no revision badge when nothing was saved after the publish, and Publish stays off', async () => {
    call.mockResolvedValueOnce(
      ok(
        live({
          workingCopy: {
            content: {},
            lastSavedAt: '2026-11-03T00:59:00.000Z',
            baseRevisionId: 'r1',
          },
        }),
      ),
    );
    mountEdit();
    await screen.findByLabelText('Title');
    expect(screen.queryByText(/unpublished changes/)).toBeNull();
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Publish revision 2' }).disabled,
    ).toBe(true);
  });

  it('confirms "Publish revision N of <title>?" and submits the revision', async () => {
    call.mockResolvedValueOnce(ok(live()));
    mountEdit();
    await screen.findByLabelText('Title');
    fireEvent.click(screen.getByRole('button', { name: 'Publish revision 2' }));
    expect(await screen.findByText('Publish revision 2 of Sella rice?')).toBeTruthy();
    call.mockResolvedValueOnce(ok({ revisionId: 'r2', revisionNo: 2, published: true }));
    fireEvent.click(inDialog('Publish revision 2 of Sella rice?', 'Publish'));
    await waitFor(() => expectToast('Product published.'));
    expect(calls()[1]?.slice(0, 2)).toEqual([
      'POST',
      `catalog/admin/platform-products/${ID}/submit`,
    ]);
    expect(screen.queryByText(/unpublished changes/)).toBeNull();
    expect(
      screen.getByText(
        'Changes are saved as a new revision. Buyers keep seeing revision 2 until you publish.',
      ),
    ).toBeTruthy();
  });

  it('shows "Sellers selling it" with two tiles only on a published product', async () => {
    call.mockResolvedValueOnce(ok(live()));
    mountEdit();
    await screen.findByLabelText('Title');
    const card = screen.getByRole('heading', { name: 'Sellers selling it' }).closest('section')!;
    expect(card.textContent).toContain('Sellers3');
    expect(card.textContent).toContain('Offers7');
    expect(card.textContent).toContain(
      'Read only. Each seller sets price and stock on their own offer.',
    );
    expect(card.textContent).not.toContain('No offers yet');
    expect(screen.queryByRole('link', { name: /Open the/ })).toBeNull();
    cleanup();
    call.mockResolvedValueOnce(ok(ready()));
    mountEdit();
    await screen.findByLabelText('Title');
    expect(screen.queryByText('Sellers selling it')).toBeNull();
  });

  it('says so when nobody has an offer yet', async () => {
    call.mockResolvedValueOnce(ok(live({ offers: { sellerCount: 0, offerCount: 0 } })));
    mountEdit();
    await screen.findByLabelText('Title');
    expect(
      screen.getByText('No offers yet. Sellers can add theirs now that it is published.'),
    ).toBeTruthy();
  });
});

describe('the Active switch', () => {
  it('is shown only to an admin with the pause key, and only on a published product', async () => {
    call.mockResolvedValueOnce(ok(live()));
    mountEdit(true);
    const toggle = await screen.findByRole<HTMLButtonElement>('switch', { name: 'Active' });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(
      screen.getByText(
        'Turn off to stop all sales at once. Sellers keep their offers and nothing is deleted.',
      ),
    ).toBeTruthy();
    cleanup();
    call.mockResolvedValueOnce(ok(live()));
    mountEdit(false);
    await screen.findByLabelText('Title');
    expect(screen.queryByRole('switch')).toBeNull();
    cleanup();
    call.mockResolvedValueOnce(ok(ready()));
    mountEdit(true);
    await screen.findByLabelText('Title');
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('asks before turning off, with the offer count and Cancel focused, then pauses with one id', async () => {
    call.mockResolvedValueOnce(ok(live()));
    mountEdit(true);
    fireEvent.click(await screen.findByRole('switch', { name: 'Active' }));
    expect(await screen.findByText('Turn off Sella rice?')).toBeTruthy();
    const dialog = dialogOf('Turn off Sella rice?');
    expect(dialog.textContent).toContain(
      "Buyers can't find it and every offer stops selling at once. Sellers keep their offers and you can turn it on again.",
    );
    expect(dialog.textContent).toContain('Offers that stop selling7');
    expect(document.activeElement).toBe(inDialog('Turn off Sella rice?', 'Cancel'));
    // No call yet: the dialog only asks.
    expect(calls()).toHaveLength(1);
    call.mockResolvedValueOnce(
      ok({
        counts: { done: 1, skipped: 0, failed: 0 },
        results: [{ productId: ID, outcome: 'done' }],
      }),
    );
    fireEvent.click(inDialog('Turn off Sella rice?', 'Turn off'));
    await waitFor(() => expectToast('Product turned off.'));
    expect(calls()[1]).toEqual([
      'POST',
      'catalog/admin/products/bulk',
      { action: 'pause', productIds: [ID] },
      'csrf-1',
    ]);
    expect(screen.getByText('This product is inactive')).toBeTruthy();
    expect(
      screen.getByText(
        "Buyers can't find it and all 7 offers are off sale. Sellers keep their offers.",
      ),
    ).toBeTruthy();
    // The switch takes its name from the visible row title, which now reads Inactive.
    expect(screen.getByRole('switch', { name: 'Inactive' }).getAttribute('aria-checked')).toBe(
      'false',
    );
    expect(screen.getByText('Inactive')).toBeTruthy();
  });

  it('turns it on again from the banner without a dialog', async () => {
    call.mockResolvedValueOnce(ok(live({ pausedAt: '2026-10-31T20:00:00.000Z' })));
    mountEdit(true);
    // Brisbane is UTC+10: 31 Oct 20:00 UTC is already 1 Nov there.
    expect(
      await screen.findByText(
        'Paused 1 Nov 2026. All 7 offers are off sale; sellers keep them. Turn on to sell again.',
      ),
    ).toBeTruthy();
    call.mockResolvedValueOnce(
      ok({
        counts: { done: 1, skipped: 0, failed: 0 },
        results: [{ productId: ID, outcome: 'done' }],
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Turn on' }));
    await waitFor(() => expectToast('Product turned on.'));
    expect(calls()[1]).toEqual([
      'POST',
      'catalog/admin/products/bulk',
      { action: 'resume', productIds: [ID] },
      'csrf-1',
    ]);
    expect(screen.queryByText('This product is inactive')).toBeNull();
    expect(screen.getByRole('switch', { name: 'Active' }).getAttribute('aria-checked')).toBe(
      'true',
    );
    expect(calls()).toHaveLength(2);
  });

  it('turns it on again from the switch without a dialog, and disables the controls while it runs', async () => {
    call.mockResolvedValueOnce(ok(live({ pausedAt: '2026-10-31T20:00:00.000Z' })));
    mountEdit(true);
    const toggle = await screen.findByRole<HTMLButtonElement>('switch', { name: 'Inactive' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(toggle.disabled).toBe(false);
    let finish: (value: Awaited<ReturnType<typeof callApi>>) => void = () => undefined;
    call.mockReturnValueOnce(
      new Promise<Awaited<ReturnType<typeof callApi>>>((resolve) => {
        finish = resolve;
      }),
    );
    fireEvent.click(toggle);
    // In flight: no dialog, and neither the switch nor the banner button can be pressed again.
    await waitFor(() => expect(toggle.disabled).toBe(true));
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Turn on' }).disabled).toBe(true);
    expect(screen.queryByText('Turn off Sella rice?')).toBeNull();
    finish(
      ok({
        counts: { done: 1, skipped: 0, failed: 0 },
        results: [{ productId: ID, outcome: 'done' }],
      }),
    );
    await waitFor(() => expectToast('Product turned on.'));
    expect(calls()[1]).toEqual([
      'POST',
      'catalog/admin/products/bulk',
      { action: 'resume', productIds: [ID] },
      'csrf-1',
    ]);
    expect(screen.queryByText('This product is inactive')).toBeNull();
    const active = screen.getByRole<HTMLButtonElement>('switch', { name: 'Active' });
    expect(active.getAttribute('aria-checked')).toBe('true');
    expect(active.disabled).toBe(false);
    expect(calls()).toHaveLength(2);
  });

  it('shows the inactive banner without a Turn on button or a switch when the admin cannot pause', async () => {
    call.mockResolvedValueOnce(ok(live({ pausedAt: '2026-10-31T20:00:00.000Z' })));
    mountEdit(false);
    expect(await screen.findByText('This product is inactive')).toBeTruthy();
    expect(
      screen.getByText(
        "Buyers can't find it and all 7 offers are off sale. Sellers keep their offers.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Turn on' })).toBeNull();
    expect(screen.queryByRole('switch')).toBeNull();
    expect(calls()).toHaveLength(1);
  });

  it('says so and offers a fresh read when the pause was skipped or failed', async () => {
    call.mockResolvedValueOnce(ok(live()));
    mountEdit(true);
    fireEvent.click(await screen.findByRole('switch', { name: 'Active' }));
    await screen.findByText('Turn off Sella rice?');
    call.mockResolvedValueOnce(
      ok({
        counts: { done: 0, skipped: 1, failed: 0 },
        results: [{ productId: ID, outcome: 'skipped', reason: 'product.already-paused' }],
      }),
    );
    fireEvent.click(inDialog('Turn off Sella rice?', 'Turn off'));
    expect(
      await screen.findByText(
        'The product could not be turned on or off. Read it again, then retry.',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('switch', { name: 'Active' }).getAttribute('aria-checked')).toBe(
      'true',
    );
  });

  it('shows no inactive banner for a draft that carries no pause', async () => {
    call.mockResolvedValueOnce(ok(ready()));
    mountEdit(true);
    await screen.findByLabelText('Title');
    expect(screen.queryByText('This product is inactive')).toBeNull();
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
