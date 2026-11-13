// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi, type ApiResult } from '../api/client.ts';
import { fromDetail, toRequest, type EditorEntry } from './feature-set-editor-model.ts';
import { MAX_PARALLEL } from './preview-options.ts';
import { SellerFormPreview } from './seller-form-preview.tsx';
import type { FeatureSetDetail, MarketLocales } from './types.ts';

const call = vi.mocked(callApi);
const FS = '0190a000-0000-7000-8000-00000000f001';
const aid = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const ok = (body: unknown): ApiResult<unknown> => ({ ok: true, status: 200, body });
const fail = (status = 500): ApiResult<unknown> =>
  ({ ok: false, failure: { status, code: 'x' } }) as never;

const MARKETS: readonly { readonly name: string; readonly locales: MarketLocales }[] = [
  { name: 'AU', locales: { default: 'en-AU', supported: ['en-AU'] } },
  { name: 'ZZ', locales: { default: 'ja-JP', supported: ['ja-JP'] } },
];

describe.each(MARKETS)('seller form preview in market $name', ({ locales }) => {
  const L = locales.default;
  const entry = (
    code: string,
    dataType: string,
    level: EditorEntry['level'],
    n: number | null,
    name = code,
  ): EditorEntry => ({
    code,
    attributeId: n === null ? null : aid(n),
    level,
    names: { [L]: name },
    dataType,
    isVariantOption: false,
    material: false,
  });
  const core = [
    entry('net-weight', 'measure', 'required', 7, 'Net weight or volume'),
    entry('country-of-origin', 'select', 'required', null, 'Country of origin'),
    entry('brand', 'select', 'recommended', null, 'Brand'),
  ];
  const detailOf = (n: number, labels: readonly string[], help = '', inactive = '') => ({
    id: aid(n),
    options: labels.map((label, i) => ({
      code: `o${i}`,
      labels: { [L]: label },
      active: label !== inactive,
      position: i,
      productCount: 0,
    })),
    display: { helpText: help === '' ? {} : { [L]: help } },
    bounds: {},
    units: [],
  });
  const measureOf = (units: readonly string[]) => ({
    id: aid(7),
    options: [],
    display: { helpText: {} },
    bounds:
      units.length === 0 ? {} : { measure: { dimension: 'mass', units, defaultUnit: units[0] } },
    units: units.map((code) => ({ code, dimension: 'mass', labels: { [L]: code.toUpperCase() } })),
  });
  const categoriesBody = (rows: readonly { n: number; name: string; fs: string | null }[]) => ({
    defaultLocale: L,
    categories: rows.map((r) => ({
      id: aid(r.n),
      slug: `c${r.n}`,
      names: [{ locale: L, name: r.name }],
      featureSetId: r.fs,
    })),
  });

  type Route = (path: string) => ApiResult<unknown> | Promise<ApiResult<unknown>>;
  const serve = (routes: {
    categories?: Route;
    attribute?: (n: number) => ApiResult<unknown> | Promise<ApiResult<unknown>>;
  }) =>
    call.mockImplementation((_m: string, path: string) => {
      if (path.startsWith('catalog/admin/categories')) {
        return Promise.resolve(
          routes.categories === undefined ? ok(categoriesBody([])) : routes.categories(path),
        );
      }
      const n = Number(path.slice(-12));
      return Promise.resolve(routes.attribute === undefined ? fail() : routes.attribute(n));
    });

  const groups = (entries: readonly EditorEntry[], withCore = true) => [
    ...(withCore ? [{ groupCode: 'core', names: { [L]: 'Core' }, entries: core }] : []),
    { groupCode: 'details', names: { [L]: 'Details' }, entries },
  ];
  const ui = (entries: readonly EditorEntry[], open = true, withCore = true) => (
    <NextIntlClientProvider locale="en" messages={messages}>
      <SellerFormPreview
        open={open}
        onClose={() => {}}
        featureSetId={FS}
        featureSetCode="sauces"
        state={{ names: {}, groups: groups(entries, withCore) }}
        locales={locales}
      />
    </NextIntlClientProvider>
  );
  const mount = (entries: readonly EditorEntry[], open = true, withCore = true) =>
    render(ui(entries, open, withCore));

  it('renders the core group in order as selects with their words, and the measure as number + unit', async () => {
    serve({ attribute: (n) => (n === 7 ? ok(measureOf(['g', 'kg'])) : fail()) });
    mount([]);
    const dialog = screen.getByRole('dialog', { name: 'Seller form preview' });
    expect(within(dialog).getAllByRole('heading', { level: 3 })[0]?.textContent).toBe('Core');
    const labels = within(dialog)
      .getAllByRole('combobox')
      .map((el) => el.getAttribute('aria-label') ?? el.id);
    expect(labels.length).toBeGreaterThanOrEqual(2);
    const brand = screen.getByLabelText<HTMLSelectElement>('Brand (Recommended)');
    const country = screen.getByLabelText<HTMLSelectElement>('Country of origin *');
    expect(brand.tagName).toBe('SELECT');
    expect(within(brand).getByText('Choose a brand')).toBeTruthy();
    expect(within(country).getByText('Choose a country')).toBeTruthy();
    expect(screen.getByText('Not listed? Suggest a brand.')).toBeTruthy();
    expect(brand.disabled).toBe(true);
    // Order: Brand, Country of origin, Net weight or volume.
    const order = [brand, country, await screen.findByLabelText('Net weight or volume *')];
    for (let i = 1; i < order.length; i += 1) {
      expect(
        order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
    const unit = await screen.findByLabelText<HTMLSelectElement>('Unit');
    expect(
      within(unit)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['G', 'KG']);
    expect(unit.value).toBe('g');
    expect((order[2] as HTMLInputElement).type).toBe('number');
  });

  it('shows a disabled placeholder unit select and a note when the measure has no units', async () => {
    serve({ attribute: (n) => (n === 7 ? ok(measureOf([])) : fail()) });
    mount([]);
    const unit = await screen.findByLabelText<HTMLSelectElement>('Unit');
    expect(unit.disabled).toBe(true);
    expect(within(unit).getByText('Unit')).toBeTruthy();
    expect(screen.getByText('This attribute has no units set yet.')).toBeTruthy();
    expect(screen.getByLabelText('Net weight or volume *')).toBeTruthy();
  });

  it('marks requirements, names required fields to a screen reader and picks controls by type', async () => {
    serve({
      attribute: (n) =>
        n === 7
          ? ok(measureOf(['g']))
          : n === 1
            ? ok(detailOf(1, ['Milk', 'Egg', 'Soy'], 'Choose all that apply.', 'Egg'))
            : n === 2
              ? ok(detailOf(2, ['Cold', 'Dry']))
              : fail(),
    });
    mount([
      entry('allergens', 'multi-select', 'required', 1, 'Allergens'),
      entry('storage', 'select', 'recommended', 2, 'Storage'),
      entry('gluten-free', 'boolean', 'required', 3, 'Gluten free'),
      entry('shelf', 'integer', 'optional', 4, 'Shelf life'),
      entry('notes', 'long-text', 'optional', 5, 'Notes'),
      entry('best-before', 'date', 'recommended', 6, 'Best before'),
    ]);
    expect(await screen.findByLabelText('Milk')).toBeTruthy();
    // An inactive choice is not offered.
    expect(screen.queryByLabelText('Egg')).toBeNull();
    const group = screen.getByRole('group', { name: /Allergens/ });
    expect(group.querySelector('legend')?.textContent).toContain('Required');
    expect(await screen.findByLabelText('Storage (Recommended)')).toBeTruthy();
    expect(screen.getByRole('group', { name: /Gluten free \*/ })).toBeTruthy();
    expect(screen.getAllByRole('radio')).toHaveLength(2);
    expect(screen.getByLabelText<HTMLInputElement>('Shelf life (Optional)').type).toBe('number');
    expect(screen.getByLabelText('Notes (Optional)').tagName).toBe('TEXTAREA');
    expect(screen.getByLabelText<HTMLInputElement>('Best before (Recommended)').type).toBe('date');
    expect(screen.getByLabelText<HTMLInputElement>('Country of origin *').required).toBe(true);
    // Nothing is a tab stop: every control is disabled.
    for (const control of screen
      .getAllByRole('dialog')[0]!
      .querySelectorAll('input, select, textarea')) {
      expect((control as HTMLInputElement).disabled).toBe(true);
    }
    const reads = call.mock.calls
      .map((c) => c[1])
      .filter((p) => p.startsWith('catalog/admin/attributes/'));
    expect(reads.sort()).toEqual([7, 1, 2].map((n) => `catalog/admin/attributes/${aid(n)}`).sort());
    expect(screen.getByText('Choose all that apply.')).toBeTruthy();
  });

  it('has a close button on top and in the footer, and the exact subtitle', () => {
    serve({});
    mount([], true, false);
    expect(screen.getAllByRole('button', { name: 'Close preview' })).toHaveLength(2);
    expect(
      screen.getByText(
        'What a seller sees for sauces, with your unsaved changes. Nothing here is saved.',
      ),
    ).toBeTruthy();
  });

  it('says "Previewing as" for one category, lists several as text, and says so for none, with no control', async () => {
    serve({
      categories: () =>
        ok(
          categoriesBody([
            { n: 90, name: 'Sauces', fs: FS },
            { n: 92, name: 'Drinks', fs: 'x' },
          ]),
        ),
    });
    const one = mount([], true, false);
    expect(await screen.findByText('Previewing as Sauces')).toBeTruthy();
    expect(screen.queryByLabelText('Preview as')).toBeNull();
    one.unmount();
    serve({
      categories: () =>
        ok(
          categoriesBody([
            { n: 90, name: 'Sauces', fs: FS },
            { n: 91, name: 'Pasta sauces', fs: FS },
          ]),
        ),
    });
    const many = mount([], true, false);
    expect(await screen.findByText('Used by these categories: Sauces, Pasta sauces')).toBeTruthy();
    expect(many.container.ownerDocument.querySelectorAll('select')).toHaveLength(0);
    many.unmount();
    serve({});
    mount([], true, false);
    expect(await screen.findByText('Not used by any category yet.')).toBeTruthy();
  });

  it('shows the empty-set note and still renders the core group', () => {
    serve({});
    mount([]);
    expect(
      screen.getByText('This feature set has no attributes. Sellers only see the core details.'),
    ).toBeTruthy();
    expect(screen.getByLabelText('Brand (Recommended)')).toBeTruthy();
  });

  it('still shows the form when categories fail', async () => {
    serve({ categories: () => fail() });
    mount([entry('notes', 'text', 'optional', null, 'Notes')]);
    expect(await screen.findByText(/couldn't load the categories/)).toBeTruthy();
    expect(screen.getByLabelText('Notes (Optional)')).toBeTruthy();
  });

  it('sends a signed-out admin to the session-ended page from the categories read', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    serve({ categories: () => fail(401) });
    mount([], true, false);
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/session-ended'));
    vi.unstubAllGlobals();
  });

  it('sends a signed-out admin to the session-ended page from an attribute read', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    serve({ attribute: () => fail(401) });
    mount([entry('storage', 'select', 'optional', 2, 'Storage')], true, false);
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/session-ended'));
    vi.unstubAllGlobals();
  });

  it('shows loading, then an error with a retry for one attribute only', async () => {
    let tries = 0;
    serve({
      attribute: (n) => {
        if (n === 1) return ok(detailOf(1, ['Cold']));
        tries += 1;
        return tries === 1 ? fail() : ok(detailOf(2, ['Warm']));
      },
    });
    mount(
      [
        entry('storage', 'select', 'optional', 1, 'Storage'),
        entry('heat', 'select', 'optional', 2, 'Heat'),
      ],
      true,
      false,
    );
    expect(
      await screen.findByText("We couldn't load the choices for this attribute."),
    ).toBeTruthy();
    expect(await screen.findByLabelText('Storage (Optional)')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByLabelText('Heat (Optional)')).toBeTruthy();
    expect(screen.queryByText("We couldn't load the choices for this attribute.")).toBeNull();
  });

  it('reads at most MAX_PARALLEL attributes at once and folds long chip lists into "+ N more"', async () => {
    let inflight = 0;
    let peak = 0;
    serve({
      attribute: (n) => {
        inflight += 1;
        peak = Math.max(peak, inflight);
        return new Promise<ApiResult<unknown>>((resolve) =>
          setTimeout(() => {
            inflight -= 1;
            resolve(ok(detailOf(n, ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'])));
          }, 5),
        );
      },
    });
    mount(
      Array.from({ length: 8 }, (_v, i) =>
        entry(`m${i + 1}`, 'multi-select', 'optional', i + 1, `Multi ${i + 1}`),
      ),
      true,
      false,
    );
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: '+ 2 more' })).toHaveLength(8),
    );
    expect(peak).toBeLessThanOrEqual(MAX_PARALLEL);
    expect(peak).toBeGreaterThan(1);
    fireEvent.click(screen.getAllByRole('button', { name: '+ 2 more' })[0]!);
    expect(screen.getAllByLabelText('H')).toHaveLength(1);
  });

  it('reads nothing while closed, and reads the choices again when it is reopened', async () => {
    serve({ attribute: (n) => ok(detailOf(n, ['Cold'])) });
    const entries = [entry('storage', 'select', 'optional', 2, 'Storage')];
    const view = mount(entries, false, false);
    expect(call).not.toHaveBeenCalled();
    view.rerender(ui(entries, true, false));
    await screen.findByLabelText('Storage (Optional)');
    const reads = () => call.mock.calls.filter((c) => c[1].includes(`attributes/${aid(2)}`)).length;
    expect(reads()).toBe(1);
    view.rerender(ui(entries, false, false));
    view.rerender(ui(entries, true, false));
    await waitFor(() => expect(reads()).toBe(2));
  });
});

describe('the save request', () => {
  it('never carries attributeId', () => {
    const detail: FeatureSetDetail = {
      id: FS,
      code: 'sauces',
      status: 'active',
      revisionNo: 1,
      createdAt: '2026-11-01T00:00:00Z',
      productCount: 0,
      locales: { default: 'en', supported: ['en'] },
      groups: [
        {
          groupCode: 'details',
          attributes: [
            {
              code: 'storage',
              required: false,
              level: 'optional',
              isVariantOption: false,
              attributeId: aid(2),
              names: null,
              dataType: 'select',
              status: 'active',
              material: false,
            },
          ],
        },
      ],
    };
    const state = fromDetail(detail);
    expect(state.groups[0]?.entries[0]?.attributeId).toBe(aid(2));
    expect(JSON.stringify(toRequest(state, 1))).not.toContain('attributeId');
    expect(JSON.stringify(toRequest(state, 1))).not.toContain(aid(2));
  });
});

beforeEach(() => {
  call.mockReset();
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});
afterEach(cleanup);
