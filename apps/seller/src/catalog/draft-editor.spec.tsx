// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { callApi } from '../api/client.ts';
import {
  attributeInputsOf,
  attributeProblem,
  attributeValuesWith,
  contentFrom,
  measureProblem,
  NO_VARIANT_FIELDS,
  variantRowsOf,
  variantsWith,
} from './draft-content.ts';
import { EditForm } from './edit-form.tsx';
import type { FormField, ProductPhoto, ProductView } from './types.ts';
import { expectToast } from '../../test/toast-spy.ts';

const call = vi.mocked(callApi);
const field = (over: Partial<FormField> & Pick<FormField, 'code' | 'dataType'>): FormField => ({
  localizable: false,
  required: false,
  isVariantOption: false,
  bounds: {},
  names: { 'en-AU': over.code },
  options: [],
  ...over,
});
const FIELDS: FormField[] = [
  field({ code: 'weight', dataType: 'integer', required: true }),
  field({ code: 'organic', dataType: 'boolean' }),
  field({
    code: 'size',
    dataType: 'select',
    isVariantOption: true,
    options: [
      { code: 'small', labels: { 'en-AU': 'Small' } },
      { code: 'large', labels: { 'en-AU': 'Large' } },
    ],
  }),
];
const product = (over: Partial<ProductView> = {}): ProductView => ({
  productId: 'p1',
  productCode: 'P00000001',
  typeCode: 'grocery',
  familyCode: 'food',
  variantModel: 'configurable',
  status: 'draft',
  variants: [{ variantId: 'v1', state: 'proposed', variantCode: 'P-000001-0v1' }],
  maxVariants: 3,
  sensitiveFields: ['name', 'images'],
  lastChangedAt: '2026-10-01T00:00:00Z',
  createdAt: '2026-10-01T00:00:00Z',
  pendingSubmittedAt: null,
  form: {
    taxCategoryCodes: ['gst', 'gst-free'],
    units: [],
    fields: FIELDS,
    categories: [
      { categoryId: 'c1', parentId: null, names: { 'en-AU': 'Pantry' } },
      { categoryId: 'c2', parentId: 'c1', names: { 'en-AU': 'Oils' } },
    ],
  },
  workingCopy: {
    content: { texts: { 'en-AU': { name: 'Olive oil' } } },
    lastSavedAt: '2026-10-01T00:00:00Z',
    baseRevisionId: null,
  },
  published: null,
  pending: null,
  ...over,
});
const mount = (p: ProductView = product(), photos: ProductPhoto[] = []) =>
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <EditForm
        product={p}
        photos={photos}
        locales={['en-AU']}
        defaultLocale="en-AU"
        csrfToken="csrf"
      />
    </NextIntlClientProvider>,
  );
const saved = (ids: string[]) =>
  ({ ok: true, status: 200, body: { variantIds: ids, refusedFields: [] } }) as const;

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

describe('draft content helpers', () => {
  it('checks whole numbers, decimals and lengths by the field bounds', () => {
    expect(attributeProblem(field({ code: 'a', dataType: 'integer' }), '1.5')).toBe('whole');
    expect(attributeProblem(field({ code: 'a', dataType: 'decimal' }), '1.5')).toBeNull();
    expect(attributeProblem(field({ code: 'a', dataType: 'decimal' }), 'x')).toBe('decimal');
    expect(
      attributeProblem(field({ code: 'a', dataType: 'integer', bounds: { max: 5 } }), '6'),
    ).toBe('range');
    expect(
      attributeProblem(field({ code: 'a', dataType: 'text', bounds: { maxLength: 2 } }), 'abc'),
    ).toBe('length');
  });

  it('keeps attribute values the form does not show and drops cleared ones', () => {
    const fields = [field({ code: 'weight', dataType: 'integer' })];
    expect(
      attributeValuesWith({ attributeValues: { weight: 5, size: 'small' } }, fields, {}, 'en-AU'),
    ).toEqual({ size: 'small' });
    expect(attributeValuesWith(undefined, fields, { weight: ' 7 ' }, 'en-AU')).toEqual({
      weight: 7,
    });
  });

  it('does not add empty keys to a draft that never had them', () => {
    const parts = { categoryIds: [], taxCategoryCode: '', attributeValues: {}, variants: [] };
    expect(contentFrom({ texts: {} }, parts)).toEqual({ texts: {} });
    expect(contentFrom({ categoryIds: ['c1'] }, parts)).toEqual({ categoryIds: [] });
  });

  it('lists live variants only, with what the draft says about them', () => {
    const rows = variantRowsOf(
      {
        variants: [{ variantId: 'v1', optionValues: { size: 'large' }, labels: { 'en-AU': 'L' } }],
      },
      [
        { variantId: 'v1', state: 'published' },
        { variantId: 'v2', state: 'retired' },
      ],
    );
    expect(rows).toEqual([
      {
        variantId: 'v1',
        key: 'v1',
        state: 'published',
        options: { size: 'large' },
        labels: { 'en-AU': 'L' },
        ...NO_VARIANT_FIELDS,
      },
    ]);
  });

  it('reads and writes the V4 fields of a variant, leaving empty ones out', () => {
    const rows = variantRowsOf(
      {
        variants: [
          {
            variantId: 'v1',
            optionValues: { size: 'large' },
            gtin: '00012345600012',
            shippingWeightGrams: 250,
            shippingLengthMm: 120,
            shippingWidthMm: 80,
            shippingHeightMm: 40,
            imageIds: ['i2', 'i1'],
          },
        ],
      },
      [{ variantId: 'v1', state: 'proposed' }],
    );
    expect(rows[0]).toMatchObject({
      gtin: '00012345600012',
      weightGrams: '250',
      lengthMm: '120',
      imageIds: ['i2', 'i1'],
    });
    expect(variantsWith(rows)).toEqual([
      {
        variantId: 'v1',
        optionValues: { size: 'large' },
        gtin: '00012345600012',
        shippingWeightGrams: 250,
        shippingLengthMm: 120,
        shippingWidthMm: 80,
        shippingHeightMm: 40,
        imageIds: ['i2', 'i1'],
      },
    ]);
    const blank = variantRowsOf(
      { variants: [{ variantId: 'v1', optionValues: { size: 'large' } }] },
      [{ variantId: 'v1', state: 'proposed' }],
    );
    expect(variantsWith(blank)).toEqual([{ variantId: 'v1', optionValues: { size: 'large' } }]);
  });
});

describe('a measure field (attributes A3)', () => {
  const netWeight = field({
    code: 'net-weight',
    dataType: 'measure',
    bounds: { min: 1, max: 5000 },
    measure: { dimension: 'mass', units: ['g', 'kg'], defaultUnit: 'g', decimals: 2 },
  });
  const UNITS = [
    { code: 'g', labels: { 'en-AU': 'g' } },
    { code: 'kg', labels: { 'en-AU': 'kg' } },
  ];

  it('saves what was typed in base units with the unit picked', () => {
    expect(
      attributeValuesWith(
        undefined,
        [netWeight],
        { 'net-weight': { amount: '0.5', unit: 'kg' } },
        'en-AU',
      ),
    ).toEqual({ 'net-weight': { value: '500', unit: 'kg' } });
    expect(
      attributeValuesWith(
        undefined,
        [netWeight],
        { 'net-weight': { amount: ' 250 ', unit: 'g' } },
        'en-AU',
      ),
    ).toEqual({ 'net-weight': { value: '250', unit: 'g' } });
  });

  it('leaves the value out while the amount is empty', () => {
    expect(
      attributeValuesWith(
        { attributeValues: { 'net-weight': { value: '500', unit: 'g' } } },
        [netWeight],
        { 'net-weight': { amount: '', unit: 'g' } },
        'en-AU',
      ),
    ).toEqual({});
  });

  it('reads a saved value back in the unit the seller chose', () => {
    expect(
      attributeInputsOf({ attributeValues: { 'net-weight': { value: '1500', unit: 'kg' } } }, [
        netWeight,
      ]),
    ).toEqual({ 'net-weight': { amount: '1.5', unit: 'kg' } });
  });

  it('names the problem: not a number, too many places, unit, or outside the range in base units', () => {
    const check = (amount: string, unit = 'g') => measureProblem(netWeight, { amount, unit });
    expect(check('')).toBeNull();
    expect(check('250')).toBeNull();
    expect(check('x')).toBe('decimal');
    expect(check('1.234', 'kg')).toBe('places');
    expect(check('1', 'ml')).toBe('unit');
    expect(check('0.0005', 'kg')).toBe('places');
    expect(check('0.0001', 'kg')).toBe('places');
    expect(check('5001')).toBe('range');
    expect(check('5.01', 'kg')).toBe('range');
    expect(check('5', 'kg')).toBeNull();
  });

  it('shows a number box and a unit list, and saves the converted value', async () => {
    call.mockResolvedValue(saved(['v1']));
    mount(
      product({
        form: { ...product().form, units: UNITS, fields: [...FIELDS, netWeight] },
      }),
    );
    const amount = screen.getByLabelText<HTMLInputElement>(/^net-weight/);
    expect(amount.getAttribute('inputmode')).toBe('decimal');
    expect(amount.getAttribute('dir')).toBe('ltr');
    fireEvent.change(screen.getByLabelText('Unit'), { target: { value: 'kg' } });
    fireEvent.change(amount, { target: { value: '1.25' } });
    fireEvent.change(screen.getByLabelText('weight'), { target: { value: '250' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(call.mock.calls[0]?.[2]).toMatchObject({
      content: { attributeValues: { 'net-weight': { value: '1250', unit: 'kg' } } },
    });
  });

  it('tells the seller when the number has more places than the field allows', () => {
    mount(
      product({
        form: { ...product().form, units: UNITS, fields: [...FIELDS, netWeight] },
      }),
    );
    fireEvent.change(screen.getByLabelText(/^net-weight/), { target: { value: '0.12345' } });
    expect(screen.getByText('Use at most 2 decimal places.')).toBeTruthy();
  });
});

describe('EditForm product details', () => {
  it('saves categories, tax category and attribute values', async () => {
    call.mockResolvedValue(saved(['v1']));
    mount();
    fireEvent.click(screen.getByLabelText('Oils'));
    fireEvent.change(screen.getByLabelText('Tax category'), { target: { value: 'gst-free' } });
    fireEvent.change(screen.getByLabelText('weight'), { target: { value: '250' } });
    fireEvent.change(screen.getByLabelText('organic'), { target: { value: 'yes' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(call.mock.calls[0]?.[2]).toMatchObject({
      content: {
        categoryIds: ['c2'],
        taxCategoryCode: 'gst-free',
        attributeValues: { weight: 250, organic: true },
        variants: [{ variantId: 'v1' }],
      },
      variantIds: ['v1'],
    });
  });

  const box = (name: string, index = 0) =>
    screen.getAllByRole('checkbox', { name })[index] as HTMLInputElement;

  it('ticks a combination, then writes the draft again with the id the server minted', async () => {
    call.mockResolvedValueOnce(saved(['v9'])).mockResolvedValueOnce(saved(['v9']));
    mount(product({ variants: [] }));
    fireEvent.click(box('size'));
    fireEvent.click(box('Large'));
    fireEvent.click(box('Large', 1));
    expect(screen.getByText('1 of 3')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(2));
    expect(call.mock.calls[0]?.[2]).toMatchObject({
      variantIds: [null],
      content: { variantAxes: ['size'] },
    });
    expect(call.mock.calls[1]?.[2]).toMatchObject({
      variantIds: ['v9'],
      content: {
        variantAxes: ['size'],
        variants: [{ variantId: 'v9', optionValues: { size: 'large' } }],
      },
    });
    // The seller never types a label: the draft carries none.
    expect(JSON.stringify(call.mock.calls[1]?.[2])).not.toContain('labels');
    await expectToast('Draft saved.');
  });

  it('tells the seller to save again when the second write fails, and a retry sends real ids', async () => {
    call
      .mockResolvedValueOnce(saved(['v9']))
      .mockResolvedValueOnce({ ok: false, failure: { status: 503, code: 'access.unavailable' } })
      .mockResolvedValueOnce(saved(['v9']));
    mount(product({ variants: [] }));
    fireEvent.click(box('size'));
    fireEvent.click(box('Small'));
    fireEvent.click(box('Small', 1));
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(await screen.findByText(/do not reload the page/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(3));
    expect(call.mock.calls[2]?.[2]).toMatchObject({ variantIds: ['v9'] });
    await expectToast('Draft saved.');
  });

  it('allows a partial grid: only the ticked combinations become variants', async () => {
    call.mockResolvedValueOnce(saved(['v1']));
    mount(
      product({
        variants: [{ variantId: 'v1', state: 'proposed', variantCode: 'P-000001-0v1' }],
        workingCopy: {
          content: {
            variantAxes: ['size'],
            variants: [{ variantId: 'v1', optionValues: { size: 'large' } }],
          },
          lastSavedAt: '2026-10-01T00:00:00Z',
          baseRevisionId: null,
        },
      }),
    );
    fireEvent.click(box('Small')); // activate Small, leave it unticked
    expect(box('Small', 1).checked).toBe(false);
    expect(box('Large', 1).checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(call.mock.calls[0]?.[2]).toMatchObject({
      variantIds: ['v1'],
      content: { variants: [{ variantId: 'v1', optionValues: { size: 'large' } }] },
    });
  });

  it('stops ticking at the limit and warns before it', () => {
    mount(
      product({
        maxVariants: 1,
        variants: [{ variantId: 'v1', state: 'proposed', variantCode: 'P-000001-0v1' }],
        workingCopy: {
          content: {
            variantAxes: ['size'],
            variants: [{ variantId: 'v1', optionValues: { size: 'large' } }],
          },
          lastSavedAt: '2026-10-01T00:00:00Z',
          baseRevisionId: null,
        },
      }),
    );
    fireEvent.click(box('Small'));
    expect(box('Small', 1).disabled).toBe(true);
    expect(screen.getByText(/reached the limit of 1 variants/)).toBeTruthy();
  });

  it('locks the axes once the product is published and confirms removing a published variant', () => {
    mount(
      product({
        published: { revisionId: 'r', revisionNo: 1 } as ProductView['published'],
        variants: [{ variantId: 'v1', state: 'published', variantCode: 'P-000001-0v1' }],
        workingCopy: {
          content: {
            variantAxes: ['size'],
            variants: [{ variantId: 'v1', optionValues: { size: 'large' } }],
          },
          lastSavedAt: '2026-10-01T00:00:00Z',
          baseRevisionId: 'r',
        },
      }),
    );
    expect(box('size').disabled).toBe(true);
    expect(screen.getByText(/what it varies on is locked/)).toBeTruthy();
    fireEvent.click(box('Large', 1));
    // Nothing is removed until the seller confirms.
    expect(box('Large', 1).checked).toBe(true);
    expect(screen.getByText(/Adding it again later starts from empty/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(box('Large', 1).checked).toBe(false);
  });

  it('also confirms removing a saved but never published variant', () => {
    mount(
      product({
        variants: [{ variantId: 'v1', state: 'proposed', variantCode: 'P-000001-0v1' }],
        workingCopy: {
          content: {
            variantAxes: ['size'],
            variants: [{ variantId: 'v1', optionValues: { size: 'large' } }],
          },
          lastSavedAt: '2026-10-01T00:00:00Z',
          baseRevisionId: null,
        },
      }),
    );
    fireEvent.click(box('Large', 1));
    expect(box('Large', 1).checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(box('Large', 1).checked).toBe(false);
  });

  it('explains a published product whose variants have no axes instead of an empty card', () => {
    mount(
      product({
        published: { revisionId: 'r', revisionNo: 1 } as ProductView['published'],
        variants: [{ variantId: 'v1', state: 'published', variantCode: 'P-000001-0v1' }],
        workingCopy: {
          content: { variants: [{ variantId: 'v1', optionValues: {} }] },
          lastSavedAt: '2026-10-01T00:00:00Z',
          baseRevisionId: 'r',
        },
      }),
    );
    expect(screen.getByText(/set up before axes existed/)).toBeTruthy();
  });

  it('draws two axes as a matrix and ticks one cell', async () => {
    call.mockResolvedValueOnce(saved(['v9'])).mockResolvedValueOnce(saved(['v9']));
    mount(
      product({
        variants: [],
        form: {
          ...product().form,
          fields: [
            ...FIELDS,
            field({
              code: 'colour',
              dataType: 'select',
              isVariantOption: true,
              options: [
                { code: 'red', labels: { 'en-AU': 'Red' } },
                { code: 'blue', labels: { 'en-AU': 'Blue' } },
              ],
            }),
          ],
        },
      }),
    );
    fireEvent.click(box('size'));
    fireEvent.click(box('colour'));
    fireEvent.click(box('Large'));
    fireEvent.click(box('Red'));
    fireEvent.click(box('Blue'));
    expect(screen.getByRole('columnheader', { name: 'size / colour' })).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Large · Blue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(2));
    expect(call.mock.calls[1]?.[2]).toMatchObject({
      content: {
        variantAxes: ['size', 'colour'],
        variants: [{ variantId: 'v9', optionValues: { size: 'large', colour: 'blue' } }],
      },
    });
  });

  it('asks before changing the axes of a draft that has ticked combinations', () => {
    mount(
      product({
        variants: [{ variantId: 'v1', state: 'proposed', variantCode: 'P-000001-0v1' }],
        workingCopy: {
          content: {
            variantAxes: ['size'],
            variants: [{ variantId: 'v1', optionValues: { size: 'large' } }],
          },
          lastSavedAt: '2026-10-01T00:00:00Z',
          baseRevisionId: null,
        },
      }),
    );
    fireEvent.click(box('size'));
    expect(screen.getByText(/ticked combinations are cleared/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Keep it' }));
    expect(box('size').checked).toBe(true);
    fireEvent.click(box('size'));
    fireEvent.click(screen.getByRole('button', { name: 'Clear and change' }));
    expect(box('size').checked).toBe(false);
  });

  it('hides the variants editor for a product with one fixed variant', () => {
    mount(product({ variantModel: 'single' }));
    expect(screen.queryByText('1. What does this product come in?')).toBeNull();
  });

  it('warns about changes that go to review once a revision is published', () => {
    mount(product({ published: { revisionId: 'r', revisionNo: 1 } as ProductView['published'] }));
    expect(screen.getByText(/checked by us before they go live: name, images/)).toBeTruthy();
  });
});

describe('EditForm variant details', () => {
  const withRow = (extra: Record<string, unknown> = {}, images: string[] = []) =>
    product({
      workingCopy: {
        content: {
          variantAxes: ['size'],
          imageIds: images,
          variants: [{ variantId: 'v1', optionValues: { size: 'large' }, ...extra }],
        },
        lastSavedAt: '2026-10-01T00:00:00Z',
        baseRevisionId: null,
      },
    });
  const photo = (imageId: string): ProductPhoto => ({
    imageId,
    width: 10,
    height: 10,
    createdAt: '2026-10-01T00:00:00Z',
  });
  const type = (label: RegExp | string, value: string) =>
    fireEvent.change(screen.getByLabelText(label), { target: { value } });

  it('saves a barcode, weight, box and photo picks with the variant', async () => {
    call.mockResolvedValueOnce(saved(['v1']));
    mount(withRow({}, ['i1', 'i2']), [photo('i1'), photo('i2')]);
    type(/Barcode/, '4006381333931');
    type('Shipping weight (g)', '250');
    type('Length (mm)', '120');
    type('Width (mm)', '80');
    type('Height (mm)', '40');
    fireEvent.click(screen.getByLabelText('Photo 2', { selector: 'input' }));
    fireEvent.click(screen.getByLabelText('Photo 1', { selector: 'input' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(call.mock.calls[0]?.[2]).toMatchObject({
      content: {
        variants: [
          {
            variantId: 'v1',
            gtin: '4006381333931',
            shippingWeightGrams: 250,
            shippingLengthMm: 120,
            shippingWidthMm: 80,
            shippingHeightMm: 40,
            imageIds: ['i2', 'i1'],
          },
        ],
      },
    });
  });

  it('shows a bad barcode and a half-set box under their fields and does not save', async () => {
    mount(withRow());
    type(/Barcode/, '4006381333932');
    type('Length (mm)', '120');
    expect(screen.getByText('Not a valid barcode. Check the digits.')).toBeTruthy();
    expect(screen.getAllByText('Enter all three sides, or none.')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(
      await screen.findByText('Fix the highlighted variant fields before saving.'),
    ).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
  });

  it('drops a variant photo pick when the product no longer has that photo', async () => {
    mount(withRow({ imageIds: ['i1'] }, ['i1']), [photo('i1')]);
    expect(screen.getByText('1 photo picked. The first one is the main photo.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Take off/ }));
    expect(await screen.findByText(/Add photos to the product first/)).toBeTruthy();
  });

  it('shows the advice when a barcode is already used and names the product to sell on', async () => {
    call.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: {
        variantIds: ['v1'],
        refusedFields: [],
        variantNotices: [
          { variantId: 'v1', code: 'gtin.duplicate', sellOnProductCode: 'P00000042' },
        ],
      },
    });
    mount(withRow({ gtin: '4006381333931' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(await screen.findByText(/Product P00000042 already carries/)).toBeTruthy();
    await expectToast('Draft saved.');
  });
});
