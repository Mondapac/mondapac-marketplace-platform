// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createTranslator, NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';
import { sellerNav } from '../nav.ts';
import { SuggestValueForm } from './suggest-value-form.tsx';
import { productDraftName, suggestableFields } from './suggestion-fields.ts';
import { SuggestionsTable } from './suggestions-table.tsx';
import type { OwnSuggestion, ProductView } from './types.ts';
import { visibleNavItems } from '@mondapac/ui';

vi.mock('next-intl/server', () => ({
  getTranslations: (namespace?: string) =>
    Promise.resolve(createTranslator({ locale: 'en-AU', messages, namespace: namespace as never })),
  getLocale: () => Promise.resolve('en-AU'),
  getTimeZone: () => Promise.resolve('UTC'),
}));
vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';

const call = vi.mocked(callApi);
const PRODUCT = '0190a000-0000-7000-8000-0000000000a1';
const id = (n: number) => `0190a000-0000-7000-8000-0000000000${n.toString(16).padStart(2, '0')}`;

const suggestion = (over: Partial<OwnSuggestion>): OwnSuggestion => ({
  id: id(0xb1),
  status: 'open',
  label: 'Extra large',
  createdAt: '2026-11-05T01:00:00.000Z',
  decidedAt: null,
  rejectReason: null,
  attribute: { code: 'pack-size', names: { 'en-AU': 'Pack size' } },
  value: null,
  product: { id: PRODUCT, productCode: 'P00000001', name: 'Olive oil 1L' },
  ...over,
});

const assign = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, 'location', { value: { assign }, writable: true });
});
afterEach(() => cleanup());

describe('value suggestions table', () => {
  it('shows each outcome in words, with the field and a link to the product', async () => {
    render(
      await SuggestionsTable({
        defaultLocale: 'en-AU',
        items: [
          suggestion({ id: id(1) }),
          suggestion({
            id: id(2),
            status: 'approved',
            value: { code: 'xl', labels: { 'en-AU': 'XL' } },
          }),
          suggestion({
            id: id(3),
            status: 'mapped',
            value: { code: 'large', labels: { 'en-AU': 'Large' } },
          }),
          suggestion({ id: id(4), status: 'rejected', rejectReason: 'Not a size we sell.' }),
        ],
      }),
    );
    const row = (n: number) => within(screen.getByTestId(`suggestion-${id(n)}`));
    expect(row(1).getByText('Waiting')).toBeTruthy();
    expect(row(1).getByText(/A reviewer will decide/)).toBeTruthy();
    expect(row(1).getByText('Pack size')).toBeTruthy();
    expect(row(1).getByRole('link', { name: 'Olive oil 1L' }).getAttribute('href')).toBe(
      `/products/${PRODUCT}`,
    );
    expect(row(2).getByText('Added as “XL”. Pick it in the product form.')).toBeTruthy();
    expect(row(3).getByText(/Matched to “Large”/)).toBeTruthy();
    expect(row(4).getByText('Not added: Not a size we sell.')).toBeTruthy();
  });

  it('renders what a seller or reviewer typed as text, not markup', async () => {
    const { container } = render(
      await SuggestionsTable({
        defaultLocale: 'en-AU',
        items: [
          suggestion({
            label: '<b>Huge</b>',
            status: 'rejected',
            rejectReason: '<img src=x onerror=alert(1)>',
          }),
        ],
      }),
    );
    expect(container.querySelector('b')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('<b>Huge</b>')).toBeTruthy();
  });

  it('names a product or field that is gone instead of linking to it', async () => {
    render(
      await SuggestionsTable({
        defaultLocale: 'en-AU',
        items: [
          suggestion({ attribute: null, product: { id: PRODUCT, productCode: null, name: null } }),
        ],
      }),
    );
    expect(screen.getByText('Field no longer available')).toBeTruthy();
    expect(screen.getByText('Product no longer available')).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('shows an empty state with its action', async () => {
    render(
      await SuggestionsTable({
        defaultLocale: 'en-AU',
        items: [],
        emptyAction: <a href="/value-suggestions/new">Suggest a value</a>,
      }),
    );
    expect(screen.getByText('No suggestions yet')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Suggest a value' })).toBeTruthy();
  });
});

describe('suggest a value form', () => {
  const fields = [
    { code: 'pack-size', label: 'Pack size', values: ['Small', 'Large'] },
    { code: 'flavour', label: 'Flavour', values: [] },
  ];
  const mount = (initialField?: string) =>
    render(
      <NextIntlClientProvider locale="en-AU" messages={messages}>
        <SuggestValueForm
          productId={PRODUCT}
          fields={fields}
          initialField={initialField}
          csrfToken="csrf-1"
        />
      </NextIntlClientProvider>,
    );

  it('starts on the linked field, shows its values and sends the trimmed words once', async () => {
    mount('pack-size');
    expect(screen.getByTestId('current-values').textContent).toBe(
      'Values on the list now: Small, Large',
    );
    const send = screen.getByRole<HTMLButtonElement>('button', { name: 'Send suggestion' });
    expect(send.disabled).toBe(true);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '  Jumbo  ' } });
    call.mockResolvedValue({ ok: true, status: 201, body: {} });
    fireEvent.click(send);
    fireEvent.click(send);
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/value-suggestions?sent=1'));
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith(
      'POST',
      `catalog/seller/products/${PRODUCT}/attribute-suggestions`,
      { attributeCode: 'pack-size', label: 'Jumbo' },
      'csrf-1',
    );
  });

  it('needs a field when the link names none, and says why a request is refused', async () => {
    mount('not-a-field');
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Oat' } });
    const send = screen.getByRole<HTMLButtonElement>('button', { name: 'Send suggestion' });
    expect(send.disabled).toBe(true);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'flavour' } });
    expect(screen.getByTestId('current-values').textContent).toBe('This field has no values yet.');
    call.mockResolvedValue({
      ok: false,
      failure: { status: 409, code: 'suggestion.value-exists' },
    });
    fireEvent.click(send);
    expect(await screen.findByText(/already on the list/)).toBeTruthy();
    expect(assign).not.toHaveBeenCalled();
  });

  it('sends a signed-out seller to the session-ended page', async () => {
    mount('flavour');
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Oat' } });
    call.mockResolvedValue({ ok: false, failure: { status: 401, code: 'session.invalid' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send suggestion' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/session-ended'));
  });
});

describe('suggestable fields', () => {
  const field = (code: string, dataType: string, isVariantOption = false) => ({
    code,
    dataType,
    localizable: false,
    required: false,
    isVariantOption,
    bounds: {},
    names: { 'en-AU': code.toUpperCase() },
    options: [{ code: 'a', labels: { 'en-AU': 'A' } }],
  });
  const product = {
    form: {
      taxCategoryCodes: [],
      categories: [],
      fields: [
        field('pack-size', 'select'),
        field('cuts', 'multi-select'),
        field('colour', 'select', true),
        field('note', 'text'),
      ],
    },
    workingCopy: {
      content: { texts: { 'en-AU': { name: 'Olive oil' } } },
      lastSavedAt: '',
      baseRevisionId: null,
    },
  } as unknown as ProductView;

  it('offers select fields, variant options included, with their values', () => {
    expect(suggestableFields(product, 'en-AU')).toEqual([
      { code: 'pack-size', label: 'PACK-SIZE', values: ['A'] },
      { code: 'cuts', label: 'CUTS', values: ['A'] },
      { code: 'colour', label: 'COLOUR', values: ['A'] },
    ]);
    expect(productDraftName(product, 'en-AU')).toBe('Olive oil');
    expect(productDraftName(product, 'ja-JP')).toBeNull();
  });
});

describe('seller nav', () => {
  it('lists Value suggestions under Catalogue for a seller who may view products', () => {
    const item = visibleNavItems(sellerNav, new Set(['catalog.own-product.view'])).find(
      (entry) => entry.id === 's_suggestions',
    );
    expect(item).toMatchObject({ href: '/value-suggestions', group: 'catalogue' });
    expect(
      visibleNavItems(sellerNav, new Set<string>()).some((entry) => entry.id === 's_suggestions'),
    ).toBe(false);
  });
});
