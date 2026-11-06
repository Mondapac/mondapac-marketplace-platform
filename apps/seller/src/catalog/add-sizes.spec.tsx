// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));
const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

import { callApi } from '../api/client.ts';
import { addSizesProblemOf, canAddSizes, publishedAxesOf, secondAxisChoices } from './add-sizes.ts';
import { EditForm } from './edit-form.tsx';
import type { FormField, ProductView } from './types.ts';
import { expectToast } from '../../test/toast-spy.ts';

const call = vi.mocked(callApi);
const field = (over: Partial<FormField> & Pick<FormField, 'code'>): FormField => ({
  dataType: 'select',
  localizable: false,
  required: false,
  isVariantOption: true,
  bounds: {},
  names: { 'en-AU': over.code === 'size' ? 'Size' : over.code === 'colour' ? 'Colour' : over.code },
  options: [],
  ...over,
});
const SIZE = field({
  code: 'size',
  options: [
    { code: 'small', labels: { 'en-AU': 'Small' } },
    { code: 'large', labels: { 'en-AU': 'Large' } },
  ],
});
const COLOUR = field({
  code: 'colour',
  options: [
    { code: 'red', labels: { 'en-AU': 'Red' } },
    { code: 'blue', labels: { 'en-AU': 'Blue' } },
  ],
});
const FIELDS: FormField[] = [SIZE, COLOUR];

const simple = (over: Partial<ProductView> = {}): ProductView => ({
  productId: 'p1',
  productCode: 'P00000001',
  typeCode: 'simple',
  familyCode: 'food',
  variantModel: 'single',
  status: 'published',
  variants: [{ variantId: 'v1', state: 'published' }],
  maxVariants: 100,
  maxAxes: 2,
  version: 7,
  sensitiveFields: [],
  lastChangedAt: '2026-10-01T00:00:00Z',
  createdAt: '2026-10-01T00:00:00Z',
  pendingSubmittedAt: null,
  form: { taxCategoryCodes: ['gst'], units: [], fields: FIELDS, categories: [] },
  workingCopy: {
    content: { texts: { 'en-AU': { name: 'Tee' } } },
    lastSavedAt: '2026-10-01T00:00:00Z',
    baseRevisionId: null,
  },
  published: null,
  pending: null,
  ...over,
});

const revision = (content: Record<string, unknown>) => ({
  revisionId: 'r1',
  revisionNo: 1,
  submittedAt: '2026-10-01T00:00:00Z',
  authorKind: 'seller',
  sensitive: false,
  sensitiveReasons: [],
  content,
});

/** A published product with one type (size) and two live variants. */
const oneType = (over: Partial<ProductView> = {}): ProductView =>
  simple({
    variantModel: 'configurable',
    typeCode: 'configurable',
    variants: [
      { variantId: 'v1', state: 'published' },
      { variantId: 'v2', state: 'published' },
    ],
    workingCopy: {
      content: {
        texts: { 'en-AU': { name: 'Tee' } },
        variantAxes: ['size'],
        variants: [
          { variantId: 'v1', optionValues: { size: 'small' } },
          { variantId: 'v2', optionValues: { size: 'large' } },
        ],
      },
      lastSavedAt: '2026-10-01T00:00:00Z',
      baseRevisionId: 'r1',
    },
    published: revision({
      variantAxes: ['size'],
      variants: [
        { variantId: 'v1', optionValues: { size: 'small' } },
        { variantId: 'v2', optionValues: { size: 'large' } },
      ],
    }),
    ...over,
  });

const mount = (p: ProductView) =>
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <EditForm
        product={p}
        photos={[]}
        locales={['en-AU']}
        defaultLocale="en-AU"
        csrfToken="csrf"
      />
    </NextIntlClientProvider>,
  );

const fail = (status: number, code: string, details?: Record<string, unknown>) =>
  ({ ok: false, failure: { status, code, ...(details ? { details } : {}) } }) as never;
const done = {
  ok: true,
  status: 200,
  body: {
    productId: 'p1',
    variantId: 'v1',
    version: 8,
    offOfferCount: 0,
    supersededRevisionId: null,
  },
} as never;

beforeEach(() => {
  vi.clearAllMocks();
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});
afterEach(cleanup);

const openDialog = () => {
  fireEvent.click(screen.getByRole('button', { name: 'Add sizes' }));
  return screen.getByRole('dialog');
};
const confirmButton = (dialog: HTMLElement) =>
  within(dialog).getByRole('button', { name: 'Add sizes' });
const chooseSize = (dialog: HTMLElement) => {
  fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Size' }));
  fireEvent.change(within(dialog).getByLabelText("This product's size"), {
    target: { value: 'small' },
  });
};

describe('add-sizes logic', () => {
  it('maps each error code of the route to a message key', () => {
    const name = (code: string, status = 409) => addSizesProblemOf({ status, code }).name;
    expect(name('product.not-simple')).toBe('not-simple');
    expect(name('revision.pending-exists')).toBe('pending-exists');
    expect(name('product-type.not-allowed', 403)).toBe('type-not-allowed');
    expect(name('conflict.stale')).toBe('stale');
    // The seller route never asks for a count, so that code is not special here.
    expect(name('confirm.count-changed')).toBe('unknown');
    expect(name('product.family-invalid', 503)).toBe('family-invalid');
    expect(name('access.unavailable', 503)).toBe('unavailable');
    expect(name('request.throttled', 429)).toBe('throttled');
    expect(name('validation.failed', 400)).toBe('invalid');
    expect(name('something.new', 500)).toBe('unknown');
    expect(addSizesProblemOf({ status: 409, code: 'conflict.stale' }).reload).toBe(true);
    const throttled = addSizesProblemOf({
      status: 429,
      code: 'request.throttled',
      details: { retryAfterSeconds: 30 },
    });
    expect(throttled.values).toEqual({ seconds: 30 });
  });

  it('has a message for every error name and known issue code', () => {
    const errors = (messages.catalog.addSizes.error ?? {}) as Record<string, string>;
    for (const code of [
      'product.not-simple',
      'revision.pending-exists',
      'product-type.not-allowed',
      'conflict.stale',
      'validation.failed',
      'request.throttled',
      'access.unavailable',
      'product.family-invalid',
    ]) {
      expect(errors[addSizesProblemOf({ status: 409, code }).name]).toBeTruthy();
    }
  });

  it('offers Add sizes only on a Simple product that can change and has a type to vary on', () => {
    expect(canAddSizes({ variantModel: 'single', status: 'draft' }, FIELDS)).toBe(true);
    expect(canAddSizes({ variantModel: 'configurable', status: 'draft' }, FIELDS)).toBe(false);
    expect(canAddSizes({ variantModel: 'single', status: 'discarded' }, FIELDS)).toBe(false);
    expect(canAddSizes({ variantModel: 'single', status: 'draft' }, [])).toBe(false);
  });

  it('reads the published types and the types a second one could be', () => {
    expect(publishedAxesOf(undefined, FIELDS)).toBeNull();
    expect(publishedAxesOf({ variants: [{ variantId: 'v1' }] }, FIELDS)).toBeNull();
    expect(publishedAxesOf({ variantAxes: ['size'] }, FIELDS)).toEqual(['size']);
    expect(
      publishedAxesOf({ variants: [{ optionValues: { size: 's', colour: 'r' } }] }, FIELDS),
    ).toEqual(['size', 'colour']);
    expect(secondAxisChoices(['size'], FIELDS, 2).map((f) => f.code)).toEqual(['colour']);
    expect(secondAxisChoices(['size'], FIELDS, 1)).toEqual([]);
    expect(secondAxisChoices(['size', 'colour'], FIELDS, 2)).toEqual([]);
    expect(secondAxisChoices(null, FIELDS, 2)).toEqual([]);
  });
});

describe('Add sizes dialog', () => {
  it('shows the button on a Simple product and not on one with sizes', () => {
    mount(simple());
    expect(screen.getByRole('button', { name: 'Add sizes' })).toBeTruthy();
    cleanup();
    mount(oneType());
    expect(screen.queryByRole('button', { name: 'Add sizes' })).toBeNull();
  });

  it('explains the change and sends the types, the value and the version', async () => {
    call.mockResolvedValueOnce(done);
    mount(simple());
    const dialog = openDialog();
    expect(within(dialog).getByText(/keeps its price and stock/)).toBeTruthy();
    expect(within(dialog).getByText("This can't be undone.")).toBeTruthy();
    // Nothing can be sent before a type and its value are chosen.
    expect((confirmButton(dialog) as HTMLButtonElement).disabled).toBe(true);
    chooseSize(dialog);
    expect((confirmButton(dialog) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(confirmButton(dialog));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(call).toHaveBeenCalledWith(
      'POST',
      'catalog/seller/products/p1/add-sizes',
      { version: 7, axes: ['size'], optionValues: { size: 'small' }, replacePending: false },
      'csrf',
    );
    await expectToast(/Sizes added/, 'success');
  });

  it('lets the seller pick two types and no third', () => {
    const three = [...FIELDS, field({ code: 'fit', names: { 'en-AU': 'Fit' } })];
    mount(simple({ form: { taxCategoryCodes: [], units: [], fields: three, categories: [] } }));
    const dialog = openDialog();
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Size' }));
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Colour' }));
    expect(within(dialog).getByRole<HTMLInputElement>('checkbox', { name: 'Fit' }).disabled).toBe(
      true,
    );
  });

  it('limits the types to what the Market allows', () => {
    mount(simple({ maxAxes: 1 }));
    const dialog = openDialog();
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Size' }));
    expect(
      within(dialog).getByRole<HTMLInputElement>('checkbox', { name: 'Colour' }).disabled,
    ).toBe(true);
  });

  it('warns that a waiting change is set aside and sends replacePending only after the tick', async () => {
    call.mockResolvedValueOnce(done);
    mount(simple({ pending: revision({}) }));
    const dialog = openDialog();
    expect(within(dialog).getByText(/waiting change is set aside|is set aside/)).toBeTruthy();
    chooseSize(dialog);
    // Chosen, but the seller has not agreed to set the waiting change aside.
    expect((confirmButton(dialog) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /Set aside the change/ }));
    fireEvent.click(confirmButton(dialog));
    await waitFor(() => expect(call).toHaveBeenCalled());
    expect(call.mock.calls[0]?.[2]).toMatchObject({ replacePending: true });
  });

  it('never asks to set aside when nothing waits, and sends false', async () => {
    call.mockResolvedValueOnce(done);
    mount(simple());
    const dialog = openDialog();
    expect(within(dialog).queryByRole('checkbox', { name: /Set aside the change/ })).toBeNull();
    chooseSize(dialog);
    fireEvent.click(confirmButton(dialog));
    await waitFor(() => expect(call).toHaveBeenCalled());
    expect(call.mock.calls[0]?.[2]).toMatchObject({ replacePending: false });
  });

  it('shows the warning when the server finds a waiting change the page did not know', async () => {
    call.mockResolvedValueOnce(fail(409, 'revision.pending-exists'));
    call.mockResolvedValueOnce(done);
    mount(simple());
    const dialog = openDialog();
    chooseSize(dialog);
    fireEvent.click(confirmButton(dialog));
    const tick = await within(dialog).findByRole('checkbox', { name: /Set aside the change/ });
    expect((confirmButton(dialog) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(tick);
    fireEvent.click(confirmButton(dialog));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(2));
    expect(call.mock.calls[1]?.[2]).toMatchObject({ replacePending: true });
  });

  it.each([
    ['product.not-simple', 409, /already has sizes/],
    ['product-type.not-allowed', 403, /can't sell products with sizes/],
    ['conflict.stale', 409, /changed somewhere else/],
    ['product.family-invalid', 503, /not set up for sizes/],
    ['access.unavailable', 503, /unavailable right now/],
  ])('shows %s as a message and keeps the dialog open', async (code, status, text) => {
    call.mockResolvedValueOnce(fail(status, code));
    mount(simple());
    const dialog = openDialog();
    chooseSize(dialog);
    fireEvent.click(confirmButton(dialog));
    expect(await within(dialog).findByText(text)).toBeTruthy();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('shows how long to wait when the route is throttled', async () => {
    call.mockResolvedValueOnce(fail(429, 'request.throttled', { retryAfterSeconds: 30 }));
    mount(simple());
    const dialog = openDialog();
    chooseSize(dialog);
    fireEvent.click(confirmButton(dialog));
    expect(
      await within(dialog).findByText('Too many requests. Try again in 30 seconds.'),
    ).toBeTruthy();
  });

  it('explains the refused types and values by their issue codes', async () => {
    call.mockResolvedValueOnce(
      fail(400, 'validation.failed', {
        fields: [
          { path: 'axes', code: 'variants.axes-unknown' },
          { path: 'optionValues', code: 'variants.option-not-in-family' },
          { path: 'axes', code: 'variants.new-code' },
        ],
      }),
    );
    mount(simple());
    const dialog = openDialog();
    chooseSize(dialog);
    fireEvent.click(confirmButton(dialog));
    expect(await within(dialog).findByText(/type you chose is not available/)).toBeTruthy();
    expect(
      within(dialog).getByText(/value you chose is not available for this product/),
    ).toBeTruthy();
    expect(within(dialog).getByText('axes: variants.new-code')).toBeTruthy();
  });

  it('offers a reload when the product is stale', async () => {
    call.mockResolvedValueOnce(fail(409, 'conflict.stale'));
    mount(simple());
    const dialog = openDialog();
    chooseSize(dialog);
    fireEvent.click(confirmButton(dialog));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Reload the product' }));
    expect(refresh).toHaveBeenCalled();
  });

  it('says why Add sizes cannot be confirmed yet, and starts clean on each opening', async () => {
    call.mockResolvedValueOnce(fail(409, 'conflict.stale'));
    mount(simple());
    let dialog = openDialog();
    expect(within(dialog).getByText('Choose at least one type to continue.')).toBeTruthy();
    expect(confirmButton(dialog).getAttribute('aria-describedby')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Size' }));
    expect(within(dialog).getByText('Choose a value for every type to continue.')).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText("This product's size"), {
      target: { value: 'small' },
    });
    fireEvent.click(confirmButton(dialog));
    expect(await within(dialog).findByText(/changed somewhere else/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    dialog = openDialog();
    expect(within(dialog).queryByText(/changed somewhere else/)).toBeNull();
    expect(within(dialog).getByRole<HTMLInputElement>('checkbox', { name: 'Size' }).checked).toBe(
      false,
    );
  });

  it('asks to save first while the form has unsaved changes', () => {
    mount(simple());
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Tee 2' } });
    expect(screen.getByText('Save your changes before you add sizes.')).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Add sizes' }).disabled).toBe(
      true,
    );
  });
});

describe('Add a second type', () => {
  it('is offered on a published product with one type', () => {
    mount(oneType());
    expect(screen.getByRole('heading', { name: 'Add a second type' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add a second type' })).toBeTruthy();
  });

  it('is not offered with two types', () => {
    mount(
      oneType({
        published: revision({
          variantAxes: ['size', 'colour'],
          variants: [{ variantId: 'v1', optionValues: { size: 'small', colour: 'red' } }],
        }),
      }),
    );
    expect(screen.queryByRole('button', { name: 'Add a second type' })).toBeNull();
  });

  it('is not offered when the Market allows one type', () => {
    mount(oneType({ maxAxes: 1 }));
    expect(screen.queryByRole('button', { name: 'Add a second type' })).toBeNull();
  });

  it('is not offered before the first publish of sizes', () => {
    mount(oneType({ published: null }));
    expect(screen.queryByRole('button', { name: 'Add a second type' })).toBeNull();
  });

  it('asks for the new type for every live variant, says it goes to review, and sends both axes', async () => {
    call.mockResolvedValue({
      ok: true,
      status: 200,
      body: { variantIds: ['v1', 'v2'], refusedFields: [] },
    } as never);
    mount(oneType({ sensitiveFields: ['axis-added'] }));
    fireEvent.click(screen.getByRole('button', { name: 'Add a second type' }));
    fireEvent.change(screen.getByLabelText('New type'), { target: { value: 'colour' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add this type' }));
    expect(screen.getByText(/goes to review before it is live/)).toBeTruthy();
    const cells = screen.getAllByLabelText(/^Colour of /);
    expect(cells).toHaveLength(2);

    // Submitting with a missing value is stopped before anything is sent.
    fireEvent.click(screen.getByRole('button', { name: 'Submit for review' }));
    expect(await screen.findByText(/Choose the new type's value for every variant/)).toBeTruthy();
    expect(call).not.toHaveBeenCalled();

    fireEvent.change(cells[0] as HTMLElement, { target: { value: 'red' } });
    fireEvent.change(cells[1] as HTMLElement, { target: { value: 'blue' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(call).toHaveBeenCalled());
    const body = call.mock.calls[0]?.[2] as {
      content: { variantAxes: string[]; variants: { optionValues: Record<string, string> }[] };
    };
    expect(body.content.variantAxes).toEqual(['size', 'colour']);
    expect(body.content.variants.map((v) => v.optionValues)).toEqual([
      { size: 'small', colour: 'red' },
      { size: 'large', colour: 'blue' },
    ]);
  });

  it('says the change is published on submit when the Market does not review it', () => {
    mount(oneType());
    fireEvent.click(screen.getByRole('button', { name: 'Add a second type' }));
    fireEvent.change(screen.getByLabelText('New type'), { target: { value: 'colour' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add this type' }));
    expect(screen.queryByText(/goes to review/)).toBeNull();
    expect(screen.getByText(/is published when you submit/)).toBeTruthy();
  });

  it('shows the published type locked and the new one as being added, and numbers the steps in order', () => {
    mount(oneType());
    fireEvent.click(screen.getByRole('button', { name: 'Add a second type' }));
    fireEvent.change(screen.getByLabelText('New type'), { target: { value: 'colour' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add this type' }));
    const size = screen.getByRole<HTMLInputElement>('checkbox', { name: 'Size' });
    expect(size.checked).toBe(true);
    expect(size.disabled).toBe(true);
    const adding = screen.getByRole<HTMLInputElement>('checkbox', {
      name: 'Colour (being added)',
    });
    expect(adding.checked).toBe(true);
    expect(adding.disabled).toBe(false);
    expect(
      screen.getByRole('heading', { name: '1. What does this product come in?' }),
    ).toBeTruthy();
    expect(screen.getByRole('heading', { name: '2. Second type: Colour' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: /^3\. Barcode/ })).toBeTruthy();
    // Unticking the new type takes it back.
    fireEvent.click(adding);
    expect(screen.queryByLabelText(/^Colour of /)).toBeNull();
    expect(screen.getByRole('button', { name: 'Add a second type' })).toBeTruthy();
  });

  it('can be taken back before it is saved', () => {
    mount(oneType());
    fireEvent.click(screen.getByRole('button', { name: 'Add a second type' }));
    fireEvent.change(screen.getByLabelText('New type'), { target: { value: 'colour' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add this type' }));
    fireEvent.click(screen.getByRole('button', { name: "Don't add a second type" }));
    expect(screen.getByRole('button', { name: 'Add a second type' })).toBeTruthy();
    expect(screen.queryByLabelText(/^Colour of /)).toBeNull();
  });
});
