// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { callApi } from '../api/client.ts';
import {
  attributeProblem,
  attributeValuesWith,
  contentFrom,
  variantRowsOf,
} from './draft-content.ts';
import { EditForm } from './edit-form.tsx';
import type { FormField, ProductView } from './types.ts';

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
  variants: [{ variantId: 'v1', state: 'proposed' }],
  maxVariants: 3,
  sensitiveFields: ['name', 'images'],
  lastChangedAt: '2026-10-01T00:00:00Z',
  createdAt: '2026-10-01T00:00:00Z',
  pendingSubmittedAt: null,
  form: {
    taxCategoryCodes: ['gst', 'gst-free'],
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
const mount = (p: ProductView = product()) =>
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <EditForm product={p} locales={['en-AU']} defaultLocale="en-AU" csrfToken="csrf" />
    </NextIntlClientProvider>,
  );
const saved = (ids: string[]) =>
  ({ ok: true, status: 200, body: { variantIds: ids, refusedFields: [] } }) as const;

beforeEach(() => vi.clearAllMocks());
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
      },
    ]);
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

  it('adds a variant, then writes the draft again with the id the server minted', async () => {
    call.mockResolvedValueOnce(saved(['v1', 'v9'])).mockResolvedValueOnce(saved(['v1', 'v9']));
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Add a variant' }));
    fireEvent.change(screen.getAllByLabelText('size')[1] as HTMLElement, {
      target: { value: 'large' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(2));
    expect(call.mock.calls[0]?.[2]).toMatchObject({ variantIds: ['v1', null] });
    expect(call.mock.calls[1]?.[2]).toMatchObject({
      variantIds: ['v1', 'v9'],
      content: {
        variants: [{ variantId: 'v1' }, { variantId: 'v9', optionValues: { size: 'large' } }],
      },
    });
    expect(await screen.findByText('Draft saved.')).toBeTruthy();
  });

  it('stops adding at the limit and keeps a published variant', () => {
    mount(
      product({
        maxVariants: 1,
        variants: [{ variantId: 'v1', state: 'published' }],
      }),
    );
    expect(screen.getByRole('button', { name: 'Add a variant' }).hasAttribute('disabled')).toBe(
      true,
    );
    expect(screen.queryByRole('button', { name: 'Remove this variant' })).toBeNull();
  });

  it('hides the variants editor for a product with one fixed variant', () => {
    mount(product({ variantModel: 'single' }));
    expect(screen.queryByRole('button', { name: 'Add a variant' })).toBeNull();
  });

  it('warns about changes that go to review once a revision is published', () => {
    mount(product({ published: { revisionId: 'r', revisionNo: 1 } as ProductView['published'] }));
    expect(screen.getByText(/checked by us before they go live: name, images/)).toBeTruthy();
  });
});
