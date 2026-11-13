// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Ui from '@mondapac/ui';
import messages from '../../../messages/en.json';

import type { callApi } from '../../api/client.ts';

// The form also reads the photo library of the product (P1 images). That call goes to its own
// mock, so `call` sees only the add-sizes calls, in order.
const mocks = vi.hoisted(() => ({
  call: vi.fn<typeof callApi>(),
  images: vi.fn<typeof callApi>(),
}));
vi.mock('@mondapac/ui', async (original) => ({
  ...(await original<typeof Ui>()),
  // These tests count the form's own calls; the writer's status read is tested in writer-in-form.
  DescriptionWriter: () => null,
}));
vi.mock('../../api/client.ts', () => ({
  callApi: ((...args: Parameters<typeof callApi>) =>
    args[0] === 'GET' && args[1].endsWith('/images')
      ? mocks.images(...args)
      : mocks.call(...args)) as typeof callApi,
}));

import { expectToast } from '../../../test/toast-spy.ts';
import { addSizesProblemOf, canAddSizes, publishedAxesOf, secondAxisChoices } from './add-sizes.ts';
import { ProductEdit } from './edit-form.tsx';
import type { FormField, ProductView } from './types.ts';

const call = mocks.call;
const ID = '0190a000-0000-7000-8000-0000000000c1';
const V1 = '0190a000-0000-7000-8000-0000000000e1';
const V2 = '0190a000-0000-7000-8000-0000000000e2';

const field = (code: string, name: string, options: [string, string][]): FormField => ({
  code,
  dataType: 'select',
  localizable: false,
  required: false,
  isVariantOption: true,
  bounds: {},
  names: { en: name },
  options: options.map(([value, label]) => ({ code: value, labels: { en: label } })),
});
const SIZE = field('size', 'Size', [
  ['small', 'Small'],
  ['large', 'Large'],
]);
const COLOUR = field('colour', 'Colour', [
  ['red', 'Red'],
  ['blue', 'Blue'],
]);
const FIELDS = [SIZE, COLOUR];

const view = (over: Partial<ProductView> = {}): ProductView => ({
  productId: ID,
  productCode: 'P00000001',
  typeCode: 'simple',
  familyCode: 'default',
  variantModel: 'single',
  status: 'published',
  pausedAt: null,
  offers: { sellerCount: 0, offerCount: 0 },
  variants: [{ variantId: V1, state: 'published' }],
  maxVariants: 100,
  maxAxes: 2,
  version: 4,
  pendingSubmittedAt: null,
  lastChangedAt: '2026-11-05T01:00:00.000Z',
  createdAt: '2026-11-05T01:00:00.000Z',
  form: {
    taxCategoryCodes: ['gst'],
    fields: FIELDS,
    categories: [
      { categoryId: '0190a000-0000-7000-8000-0000000000d1', parentId: null, names: { en: 'Tops' } },
    ],
  },
  locales: { default: 'en', supported: ['en'] },
  workingCopy: {
    content: { texts: { en: { name: 'Tee' } } },
    lastSavedAt: '2026-11-05T01:00:00.000Z',
    baseRevisionId: null,
  },
  published: null,
  ...over,
});

const oneType = (over: Partial<ProductView> = {}): ProductView =>
  view({
    variantModel: 'configurable',
    typeCode: 'configurable',
    variants: [
      { variantId: V1, state: 'published' },
      { variantId: V2, state: 'published' },
    ],
    workingCopy: {
      content: {
        texts: { en: { name: 'Tee' } },
        categoryIds: ['0190a000-0000-7000-8000-0000000000d1'],
        taxCategoryCode: 'gst',
        variantAxes: ['size'],
        variants: [
          { variantId: V1, optionValues: { size: 'small' } },
          { variantId: V2, optionValues: { size: 'large' } },
        ],
      },
      lastSavedAt: '2026-11-05T01:00:00.000Z',
      baseRevisionId: 'r1',
    },
    published: {
      revisionId: 'r1',
      revisionNo: 1,
      submittedAt: '2026-11-05T01:00:00.000Z',
      content: {
        variantAxes: ['size'],
        variants: [
          { variantId: V1, optionValues: { size: 'small' } },
          { variantId: V2, optionValues: { size: 'large' } },
        ],
      },
    },
    ...over,
  });

const ok = <T,>(body: T) => ({ ok: true as const, status: 200, body });
const fail = (status: number, code: string, details?: object) => ({
  ok: false as const,
  failure: { status, code, ...(details === undefined ? {} : { details }) },
});
const impact = (count: number) => ok({ productId: ID, version: 4, offOfferCount: count });
const done = ok({
  productId: ID,
  variantId: V1,
  version: 5,
  offOfferCount: 3,
  supersededRevisionId: null,
});

/** Calls to the add-sizes route, in order. */
const posts = () => call.mock.calls.filter(([method]) => method === 'POST');

function mount(product: ProductView) {
  call.mockResolvedValueOnce(ok(product));
  return render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <ProductEdit
        productId={ID}
        csrfToken="csrf-1"
        marketName="Australia"
        timeZone="Australia/Brisbane"
        canPause={false}
      />
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  call.mockReset();
  mocks.images.mockReset();
  mocks.images.mockResolvedValue({ ok: true, status: 200, body: { images: [] } });
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

const openDialog = async () => {
  fireEvent.click(await screen.findByRole('button', { name: 'Add sizes' }));
  return screen.getByRole('dialog');
};
const confirmButton = (dialog: HTMLElement) =>
  within(dialog).getByRole('button', { name: /^(Add sizes|Confirm with the new number)$/ });
const chooseSize = (dialog: HTMLElement) => {
  fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Size' }));
  fireEvent.change(within(dialog).getByLabelText("This product's size"), {
    target: { value: 'small' },
  });
};

describe('add-sizes logic', () => {
  it('maps the codes of the routes to message keys', () => {
    const name = (code: string, status = 409) => addSizesProblemOf({ status, code }).name;
    expect(name('confirm.count-changed')).toBe('count-changed');
    expect(name('revision.pending-exists')).toBe('pending-exists');
    expect(name('product-type.not-allowed', 403)).toBe('type-not-allowed');
    expect(name('product.not-simple')).toBe('not-simple');
    expect(name('conflict.stale')).toBe('stale');
    expect(name('product.family-invalid', 503)).toBe('family-invalid');
    expect(name('access.unavailable', 503)).toBe('unavailable');
    expect(name('request.throttled', 429)).toBe('throttled');
    expect(name('validation.failed', 400)).toBe('invalid');
    const errors = messages.catalog.productForm.addSizes.error as Record<string, string>;
    for (const key of ['count-changed', 'pending-exists', 'type-not-allowed', 'family-invalid']) {
      expect(errors[key]).toBeTruthy();
    }
  });

  it('decides when each action is offered', () => {
    expect(canAddSizes({ variantModel: 'single', status: 'draft' }, FIELDS)).toBe(true);
    expect(canAddSizes({ variantModel: 'configurable', status: 'draft' }, FIELDS)).toBe(false);
    expect(publishedAxesOf({ variantAxes: ['size'] }, FIELDS)).toEqual(['size']);
    expect(publishedAxesOf({ variants: [{ variantId: V1 }] }, FIELDS)).toBeNull();
    expect(secondAxisChoices(['size'], FIELDS, 2).map((f) => f.code)).toEqual(['colour']);
    expect(secondAxisChoices(['size'], FIELDS, 1)).toEqual([]);
    expect(secondAxisChoices(['size', 'colour'], FIELDS, 2)).toEqual([]);
  });
});

describe('Add sizes on a platform product', () => {
  it('reads the impact, shows the off-sale count and sends it back with the version', async () => {
    mount(view());
    call.mockResolvedValueOnce(impact(3));
    call.mockResolvedValueOnce(done);
    // The product is read again after the change.
    call.mockResolvedValueOnce(ok(view({ variantModel: 'configurable' })));
    const dialog = await openDialog();
    expect(call.mock.calls[1]?.slice(0, 2)).toEqual([
      'GET',
      `catalog/admin/platform-products/${ID}/add-sizes-impact`,
    ]);
    expect(
      await within(dialog).findByText(
        "3 offers of other sellers will go off sale because those sellers can't sell products with sizes.",
      ),
    ).toBeTruthy();
    expect(within(dialog).getByText("This can't be undone.")).toBeTruthy();
    chooseSize(dialog);
    fireEvent.click(confirmButton(dialog));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]?.slice(0, 3)).toEqual([
      'POST',
      `catalog/admin/platform-products/${ID}/add-sizes`,
      {
        version: 4,
        axes: ['size'],
        optionValues: { size: 'small' },
        replacePending: false,
        offOfferCount: 3,
      },
    ]);
    await expectToast(/Sizes added/, 'success');
  });

  it('says so when no offer is affected and sends zero', async () => {
    mount(view());
    call.mockResolvedValueOnce(impact(0));
    call.mockResolvedValueOnce(done);
    call.mockResolvedValueOnce(ok(view()));
    const dialog = await openDialog();
    expect(
      await within(dialog).findByText('No offers of other sellers are affected.'),
    ).toBeTruthy();
    chooseSize(dialog);
    fireEvent.click(confirmButton(dialog));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]?.[2]).toMatchObject({ offOfferCount: 0 });
  });

  it('shows the new count when it changed and sends again only after the admin confirms', async () => {
    mount(view());
    call.mockResolvedValueOnce(impact(3));
    call.mockResolvedValueOnce(fail(409, 'confirm.count-changed', { currentCount: 5 }));
    call.mockResolvedValueOnce(fail(409, 'confirm.count-changed', { currentCount: 6 }));
    call.mockResolvedValueOnce(done);
    call.mockResolvedValueOnce(ok(view()));
    const dialog = await openDialog();
    await within(dialog).findByText(/^3 offers of other sellers/);
    chooseSize(dialog);
    fireEvent.click(confirmButton(dialog));

    expect(await within(dialog).findByText(/^5 offers of other sellers/)).toBeTruthy();
    expect(
      within(dialog).getByText('The number changed from 3 to 5. Check it and confirm again.'),
    ).toBeTruthy();
    // Nothing was sent again by itself.
    expect(posts()).toHaveLength(1);

    fireEvent.click(confirmButton(dialog));
    expect(await within(dialog).findByText(/^6 offers of other sellers/)).toBeTruthy();
    expect(
      within(dialog).getByText('The number changed from 5 to 6. Check it and confirm again.'),
    ).toBeTruthy();
    expect(posts()[1]?.[2]).toMatchObject({ offOfferCount: 5 });

    fireEvent.click(confirmButton(dialog));
    await waitFor(() => expect(posts()).toHaveLength(3));
    expect(posts()[2]?.[2]).toMatchObject({ offOfferCount: 6 });
  });

  it('still shows what changed when the count drops to zero', async () => {
    mount(view());
    call.mockResolvedValueOnce(impact(3));
    call.mockResolvedValueOnce(fail(409, 'confirm.count-changed', { currentCount: 0 }));
    const dialog = await openDialog();
    await within(dialog).findByText(/^3 offers of other sellers/);
    chooseSize(dialog);
    fireEvent.click(confirmButton(dialog));
    expect(
      await within(dialog).findByText(
        'The number changed from 3 to 0. Check it and confirm again.',
      ),
    ).toBeTruthy();
    expect(within(dialog).getByText('No offers of other sellers are affected.')).toBeTruthy();
    expect(
      within(dialog).getByRole('button', { name: 'Confirm with the new number' }),
    ).toBeTruthy();
  });

  it('starts clean when it is opened again after Cancel', async () => {
    mount(view());
    call.mockResolvedValueOnce(impact(3));
    call.mockResolvedValueOnce(fail(409, 'confirm.count-changed', { currentCount: 5 }));
    let dialog = await openDialog();
    await within(dialog).findByText(/^3 offers of other sellers/);
    chooseSize(dialog);
    fireEvent.click(confirmButton(dialog));
    await within(dialog).findByText(/^5 offers of other sellers/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    call.mockResolvedValueOnce(impact(2));
    dialog = await openDialog();
    expect(await within(dialog).findByText(/^2 offers of other sellers/)).toBeTruthy();
    expect(within(dialog).queryByText(/The number changed from/)).toBeNull();
    expect(within(dialog).queryByText(/number of offers affected changed/)).toBeNull();
    expect(within(dialog).getByRole<HTMLInputElement>('checkbox', { name: 'Size' }).checked).toBe(
      false,
    );
    expect(within(dialog).getByRole('button', { name: 'Add sizes' })).toBeTruthy();
  });

  it('says why the button is off', async () => {
    mount(view());
    call.mockResolvedValueOnce(impact(1));
    const dialog = await openDialog();
    await within(dialog).findByText(/^1 offer of another seller/);
    expect(within(dialog).getByText('Choose at least one type to continue.')).toBeTruthy();
    expect(confirmButton(dialog).getAttribute('aria-describedby')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Size' }));
    expect(within(dialog).getByText('Choose a value for every type to continue.')).toBeTruthy();
  });

  it('asks to save first while the form has unsaved changes', async () => {
    mount(view());
    const start = await screen.findByRole<HTMLButtonElement>('button', { name: 'Add sizes' });
    expect(start.disabled).toBe(false);
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Tee 2' } });
    expect(screen.getByText('Save your changes before you add sizes.')).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Add sizes' }).disabled).toBe(
      true,
    );
  });

  it('cannot be confirmed when the impact could not be read', async () => {
    mount(view());
    call.mockResolvedValueOnce(fail(503, 'access.unavailable'));
    const dialog = await openDialog();
    expect(
      await within(dialog).findByText(/could not check which offers are affected/),
    ).toBeTruthy();
    // One banner, with the reason inside it.
    expect(within(dialog).getByText(/Products are unavailable right now/)).toBeTruthy();
    expect(within(dialog).getAllByRole('alert').length).toBeLessThanOrEqual(1);
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Size' }));
    expect((confirmButton(dialog) as HTMLButtonElement).disabled).toBe(true);
  });

  it('warns about a waiting change and sends replacePending only after the tick', async () => {
    mount(view({ pendingSubmittedAt: '2026-11-05T02:00:00.000Z' }));
    call.mockResolvedValueOnce(impact(0));
    call.mockResolvedValueOnce(done);
    call.mockResolvedValueOnce(ok(view()));
    const dialog = await openDialog();
    await within(dialog).findByText('No offers of other sellers are affected.');
    expect(within(dialog).getByText(/waiting change is set aside/)).toBeTruthy();
    chooseSize(dialog);
    expect((confirmButton(dialog) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /Set aside the change/ }));
    fireEvent.click(confirmButton(dialog));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]?.[2]).toMatchObject({ replacePending: true });
  });

  it('asks for the tick when the server finds a waiting change the page did not know', async () => {
    mount(view());
    call.mockResolvedValueOnce(impact(0));
    call.mockResolvedValueOnce(fail(409, 'revision.pending-exists'));
    const dialog = await openDialog();
    await within(dialog).findByText('No offers of other sellers are affected.');
    chooseSize(dialog);
    fireEvent.click(confirmButton(dialog));
    expect(
      await within(dialog).findByRole('checkbox', { name: /Set aside the change/ }),
    ).toBeTruthy();
    expect((confirmButton(dialog) as HTMLButtonElement).disabled).toBe(true);
  });

  it.each([
    ['product.not-simple', 409, /already has sizes/],
    ['product-type.not-allowed', 403, /not offered in this market/],
    ['conflict.stale', 409, /changed somewhere else/],
    ['product.family-invalid', 503, /not set up for sizes/],
    ['access.unavailable', 503, /unavailable right now/],
  ])('shows %s as a message', async (code, status, text) => {
    mount(view());
    call.mockResolvedValueOnce(impact(0));
    call.mockResolvedValueOnce(fail(status, code));
    const dialog = await openDialog();
    await within(dialog).findByText('No offers of other sellers are affected.');
    chooseSize(dialog);
    fireEvent.click(confirmButton(dialog));
    expect(await within(dialog).findByText(text)).toBeTruthy();
  });

  it('shows how long to wait when throttled and explains refused values', async () => {
    mount(view());
    call.mockResolvedValueOnce(impact(0));
    call.mockResolvedValueOnce(fail(429, 'request.throttled', { retryAfterSeconds: 12 }));
    call.mockResolvedValueOnce(
      fail(400, 'validation.failed', {
        fields: [{ path: 'optionValues', code: 'variants.option-unknown' }],
      }),
    );
    const dialog = await openDialog();
    await within(dialog).findByText('No offers of other sellers are affected.');
    chooseSize(dialog);
    fireEvent.click(confirmButton(dialog));
    expect(
      await within(dialog).findByText('Too many requests. Try again in 12 seconds.'),
    ).toBeTruthy();
    fireEvent.click(confirmButton(dialog));
    expect(await within(dialog).findByText('A value you chose is not available.')).toBeTruthy();
  });

  it('is not offered on a product that already has sizes', async () => {
    mount(oneType());
    await screen.findByRole('heading', { name: 'Tee' });
    expect(screen.queryByRole('button', { name: 'Add sizes' })).toBeNull();
  });
});

describe('Add a second type on a platform product', () => {
  it('is hidden with two types, with a Market that allows one, and before sizes are published', async () => {
    mount(
      oneType({
        published: {
          revisionId: 'r1',
          revisionNo: 1,
          submittedAt: '2026-11-05T01:00:00.000Z',
          content: { variantAxes: ['size', 'colour'] },
        },
      }),
    );
    await screen.findByRole('heading', { name: 'Tee' });
    expect(screen.queryByRole('button', { name: 'Add a second type' })).toBeNull();
    cleanup();
    mount(oneType({ maxAxes: 1 }));
    await screen.findByRole('heading', { name: 'Tee' });
    expect(screen.queryByRole('button', { name: 'Add a second type' })).toBeNull();
    cleanup();
    mount(oneType({ published: null }));
    await screen.findByRole('heading', { name: 'Tee' });
    expect(screen.queryByRole('button', { name: 'Add a second type' })).toBeNull();
  });

  it('requires the new type on every variant, says every variant is renamed on publishing, and saves both axes', async () => {
    mount(oneType());
    fireEvent.click(await screen.findByRole('button', { name: 'Add a second type' }));
    fireEvent.change(screen.getByLabelText('New type'), { target: { value: 'colour' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add this type' }));
    expect(screen.getByText('When you publish, every variant gets a new name.')).toBeTruthy();
    expect(screen.queryByText(/goes to review/)).toBeNull();
    // The grid lists the type as a locked tick as well; the value cells are the selects.
    const cells = screen
      .getAllByLabelText('Colour')
      .filter((element) => element.tagName === 'SELECT');
    expect(cells).toHaveLength(2);

    // Publishing with a missing value is stopped before anything is sent.
    fireEvent.click(screen.getByRole('button', { name: 'Publish revision 2' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Publish' }));
    expect(await screen.findByText(/Choose the new type's value for every variant/)).toBeTruthy();
    expect(call).toHaveBeenCalledTimes(1);

    call.mockResolvedValue(ok({ variantIds: [V1, V2], refusedFields: [] }));
    fireEvent.change(cells[0] as HTMLElement, { target: { value: 'red' } });
    fireEvent.change(cells[1] as HTMLElement, { target: { value: 'blue' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save revision' }));
    await waitFor(() => expect(call.mock.calls.some(([m]) => m === 'PUT')).toBe(true));
    const put = call.mock.calls.find(([m]) => m === 'PUT');
    const body = put?.[2] as {
      content: { variantAxes: string[]; variants: { optionValues: Record<string, string> }[] };
    };
    expect(body.content.variantAxes).toEqual(['size', 'colour']);
    expect(body.content.variants.map((v) => v.optionValues)).toEqual([
      { size: 'small', colour: 'red' },
      { size: 'large', colour: 'blue' },
    ]);
  });
});
